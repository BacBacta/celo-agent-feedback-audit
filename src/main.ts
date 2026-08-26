import { mkdirSync, writeFileSync } from 'node:fs'
import type { Address } from 'viem'
import { latestBlock } from './rpc.js'
import { AUDIT_VERSION } from './config.js'
import { BLOCKS_PER_DAY, REGISTRY_DEPLOY_BLOCK } from './config.js'
import { loadFeedback } from './sources/feedback.js'
import { loadIdentity, loadSelfVerified } from './sources/identity.js'
import { loadSettlementsFrom } from './sources/settlements.js'
import { checkEvidence, type EvidenceVerdict } from './analysis/evidence.js'
import { concentration, findBursts } from './analysis/concentration.js'
import { reconcile, summarize } from './analysis/reconcile.js'
import { renderMarkdown, renderJSON, collectEvidence, type AuditResult } from './report.js'

const iso = (ts: number) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : 'unknown')

async function main() {
  const window = process.env.AUDIT_WINDOW ?? 'all'
  const maxFetches = Number(process.env.MAX_FILE_FETCHES ?? 2000)

  const head = await latestBlock()
  const fromBlock =
    window === 'all' ? REGISTRY_DEPLOY_BLOCK : head - BigInt(Number(window)) * BLOCKS_PER_DAY
  const toBlock = head

  console.log(`Celo Agent Feedback Audit v${AUDIT_VERSION}`)
  console.log(`  blocks ${fromBlock} → ${toBlock}\n`)

  console.log('Indexing…')
  const feedback = await loadFeedback(fromBlock, toBlock)
  if (feedback.length === 0) {
    console.log('\nNo feedback records in this window. Widen AUDIT_WINDOW and re-run.')
    return
  }

  const identity = await loadIdentity(fromBlock, toBlock)
  const selfVerified = await loadSelfVerified(fromBlock, toBlock)

  const reviewers = [...new Set(feedback.map((f) => f.reviewer.toLowerCase()))] as Address[]
  console.log(`  ${reviewers.length} distinct reviewers`)

  // The settlement sweep costs one block-range scan per reviewer batch per
  // token, so it grows with the number of reviewers — tractable over a month,
  // days of requests over full history. It feeds only the reconstructed
  // "reviewer demonstrably paid" figure, which is already the weakest number
  // here because a platform commonly pays from a different address than the one
  // writing the review. The headline — whether a *declared* payment exists — is
  // verified per transaction hash and needs none of it.
  const skipSettlements = process.env.SKIP_SETTLEMENTS === '1'
  let settlements: Awaited<ReturnType<typeof loadSettlementsFrom>> = []
  if (skipSettlements) {
    console.log('  settlements: skipped (SKIP_SETTLEMENTS=1)')
  } else if (reviewers.length > 300) {
    console.log(
      `  settlements: skipped — ${reviewers.length} reviewers would need roughly ` +
        `${Math.round((reviewers.length / 100) * 3 * Number((toBlock - fromBlock) / 5000n))} requests.\n` +
        '              Set SKIP_SETTLEMENTS=0 to force it, or narrow AUDIT_WINDOW.',
    )
  } else {
    settlements = await loadSettlementsFrom(reviewers, fromBlock, toBlock)
  }

  console.log('\nAnalysing…')

  const withPointer = feedback.filter((f) => f.hasURI)

  /**
   * Sampling matters more than it looks.
   *
   * `feedback` is ordered by block, so taking the first N records samples only
   * the oldest ones — which for this registry means one early cohort of authors
   * and none of the recent ones. That is not a sample, it is a truncation, and
   * it produced a headline of "0% claim a payment" for a period in which the
   * true recent figure is 100%.
   *
   * Taking every Nth record instead spreads the sample evenly across the whole
   * window, and being deterministic it stays reproducible — which a random
   * sample in an audit would not.
   */
  let toCheck: typeof withPointer = []
  let stride = 1
  if (maxFetches > 0) {
    if (withPointer.length <= maxFetches) {
      toCheck = withPointer
    } else {
      stride = Math.ceil(withPointer.length / maxFetches)
      toCheck = withPointer.filter((_, i) => i % stride === 0).slice(0, maxFetches)
    }
  }
  console.log(
    `  ${withPointer.length} records declare evidence; checking ${toCheck.length}` +
      (stride > 1 ? ` (every ${stride}th, spread across the full period)` : ' (all of them)'),
  )

  const verdicts: EvidenceVerdict[] = []
  const CONCURRENCY = 8
  for (let i = 0; i < toCheck.length; i += CONCURRENCY) {
    const batch = toCheck.slice(i, i + CONCURRENCY)
    verdicts.push(...(await Promise.all(batch.map((f) => checkEvidence(f)))))
    process.stdout.write(`\r  evidence: ${Math.min(i + CONCURRENCY, toCheck.length)}/${toCheck.length}`)
  }
  if (toCheck.length) process.stdout.write('\n')

  const rows = reconcile({ feedback, settlements, identity, selfVerified })
  const stats = summarize(rows)
  const conc = concentration(feedback.map((f) => f.reviewer.toLowerCase()))
  const bursts = findBursts(
    feedback.map((f) => ({ timestamp: f.timestamp, reviewer: f.reviewer.toLowerCase() })),
  )

  const evidence = collectEvidence(verdicts, toCheck.length)
  evidence.sampleStride = stride
  // Records beyond the fetch cap still declared a pointer.
  evidence.withPointer = withPointer.length
  evidence.declaresURI = withPointer.length
  evidence.declaresHash = feedback.filter((f) => f.hasHash).length
  evidence.hashWithoutURI = feedback.filter((f) => f.hasHash && !f.hasURI).length

  const result: AuditResult = {
    fromBlock,
    toBlock,
    fromDate: iso(feedback[0]?.timestamp ?? 0),
    toDate: iso(feedback[feedback.length - 1]?.timestamp ?? 0),
    totalFeedback: feedback.length,
    revokedFeedback: feedback.filter((f) => f.revoked).length,
    distinctAgentsRated: new Set(feedback.map((f) => String(f.agentId))).size,
    registeredAgents: identity.registeredAt.size,
    evidence,
    reconciliation: stats,
    concentration: conc,
    bursts,
    settlementsSeen: settlements.length,
    selfVerifiedReviewers: reviewers.filter((r) => selfVerified.has(r)).length,
  }

  mkdirSync('out', { recursive: true })

  /**
   * Every payment claim, one row each, with its verdict. The aggregate table
   * says "74 of 82 don't resolve"; this file is what lets anyone — including
   * the platform whose pipeline produced them — check that claim hash by hash
   * instead of taking the aggregate on faith.
   */
  const claimRows = toCheck
    .map((rec, i) => ({ rec, v: verdicts[i] }))
    .filter((x) => x.v?.claimsPayment)
  const csvEsc = (val: unknown) => `"${String(val ?? '').replace(/"/g, '""')}"`
  writeFileSync(
    'out/claims.csv',
    [
      'timestamp,block,agentId,reviewer,claimNetwork,claimTxHash,txExistsOnCelo,paymentVerified,note,feedbackURI',
      ...claimRows.map(({ rec, v }) =>
        [
          new Date(rec.timestamp * 1000).toISOString(),
          rec.blockNumber,
          rec.agentId,
          rec.reviewer,
          v!.claimNetwork,
          v!.claimTxHash,
          v!.txExists,
          v!.paymentVerified,
          v!.note ?? '',
          rec.feedbackURI,
        ]
          .map(csvEsc)
          .join(','),
      ),
    ].join('\n'),
  )

  writeFileSync('out/audit.md', renderMarkdown(result))
  writeFileSync('out/audit.json', renderJSON(result))

  // An audit that only prints totals asks to be trusted. Dump the raw records
  // behind them so any surprising number can be checked by hand.
  writeFileSync(
    'out/samples.json',
    JSON.stringify(
      feedback.slice(0, 25).map((f) => ({
        agentId: String(f.agentId),
        reviewer: f.reviewer,
        value: String(f.value),
        tag1: f.tag1,
        endpoint: f.endpoint,
        feedbackURI: f.feedbackURI,
        feedbackHash: f.feedbackHash,
        txHash: f.txHash,
        timestamp: new Date(f.timestamp * 1000).toISOString(),
      })),
      null,
      2,
    ),
  )

  console.log('\n' + '─'.repeat(60))
  console.log(`  feedback records            ${result.totalFeedback}`)
  console.log(`  with a retrievable file     ${evidence.declaresURI}`)
  console.log(`  claiming a payment          ${evidence.claimsPayment}`)
  console.log(`  claimed tx exists on chain  ${evidence.txExists}`)
  console.log(`  payment actually verified   ${evidence.paymentVerified}`)
    if (settlements.length || process.env.SKIP_SETTLEMENTS === '0') {
    console.log(`  reviewer demonstrably paid  ${stats.backed}`)
  }
  console.log(`  written by Self ID holder   ${stats.humanBacked}`)
  console.log('─'.repeat(60))
  console.log(`\nWrote out/audit.md, out/audit.json, out/samples.json and out/claims.csv (${claimRows.length} claims)`)
}

main().catch((e) => {
  console.error('\nAudit failed:', e)
  process.exit(1)
})
