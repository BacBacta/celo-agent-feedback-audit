import { mkdirSync, writeFileSync } from 'node:fs'
import type { Address } from 'viem'
import { latestBlock, assertDeterministicLogs } from './rpc.js'
import { AUDIT_VERSION, retrievalFingerprint } from './config.js'
import { BLOCKS_PER_DAY, REGISTRY_DEPLOY_BLOCK, REPUTATION_REGISTRY, NEW_FEEDBACK_EVENT } from './config.js'
import { loadFeedback } from './sources/feedback.js'
import { loadIdentity, loadSelfVerified } from './sources/identity.js'
import { loadSettlementsFrom } from './sources/settlements.js'
import { checkEvidence, type EvidenceVerdict } from './analysis/evidence.js'
import { EvidenceArchive } from './archive.js'
import { pinningStatus, closeDispatchers } from './net/fetch-evidence.js'
import { VerdictCache } from './verdict-cache.js'
// One escaper, shared with the offline tooling and with the attestation
// service that consumes these rows. Two implementations of one format drift,
// and this format's consumer writes to a public ledger.
import { escapeCell as csvEsc } from './csv.mjs'
// One implementation of the coverage tree, shared with the attestation
// service. Three parties computing the same root from three implementations
// is how a coverage claim quietly stops meaning anything.
import { recordKey, merkleRoot } from './coverage.mjs'
import { concentration, findBursts } from './analysis/concentration.js'
import { reconcile, summarize } from './analysis/reconcile.js'
import { renderMarkdown, renderJSON, collectEvidence, rung, evidenceRung, type AuditResult } from './report.js'

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
  /**
   * Before anything is counted, establish that the endpoint can answer the same
   * immutable question the same way twice. It is the cheapest possible check
   * and it catches the failure that produces the most confident wrong number.
   */
  await assertDeterministicLogs({
    address: REPUTATION_REGISTRY,
    event: NEW_FEEDBACK_EVENT,
    fromBlock: REGISTRY_DEPLOY_BLOCK,
    toBlock,
  })
  const feedback = await loadFeedback(fromBlock, toBlock)
  if (feedback.length === 0) {
    console.log('\nNo feedback records in this window. Widen AUDIT_WINDOW and re-run.')
    return
  }

  /**
   * Ownership is cumulative state, not events in a window.
   *
   * Scanning the Identity Registry over the same range as the feedback means
   * every agent registered before that range has no known owner — and
   * attribution needs the owner, so a windowed run reports "agent owner
   * unknown" and refuses to attribute payments that are perfectly ordinary.
   * Measured on a 45-day window: both verified payments came back unattributed
   * for exactly this reason. The registry's history is replayed in full
   * regardless of the window, and cached, so the answer does not depend on how
   * much feedback the run happened to look at.
   */
  const identity = await loadIdentity(REGISTRY_DEPLOY_BLOCK, toBlock)
  const selfVerified = await loadSelfVerified(REGISTRY_DEPLOY_BLOCK, toBlock)

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

  /**
   * Retrieved bytes are kept, content-addressed, beside the verdicts they
   * justify. An audit that convicts a file and does not keep it has published
   * exactly what it condemns: a claim whose evidence is a dead link.
   */
  const archive = process.env.ARCHIVE_EVIDENCE === '0' ? null : new EvidenceArchive('out/evidence-corpus')
  console.log(`  ${pinningStatus()}`)

  /**
   * Verdicts are paired with their record as they are produced. A positional
   * zip afterwards would silently shift every later verdict onto the wrong
   * record the moment one check is dropped.
   */
  const verdictByRecord = new Map<(typeof toCheck)[number], EvidenceVerdict>()

  /**
   * Retrieval resumes. It is the phase that takes hours, and until now a run
   * interrupted near the end repeated every fetch.
   */
  const rules = retrievalFingerprint()
  const cache = new VerdictCache(
    `${process.env.CACHE_DIR ?? 'data'}/evidence-verdicts-${fromBlock}-${rules}.jsonl`,
  )
  const pending: typeof toCheck = []
  for (const rec of toCheck) {
    const hit = cache.get(VerdictCache.key(rec))
    if (hit) verdictByRecord.set(rec, hit)
    else pending.push(rec)
  }
  if (cache.size) {
    console.log(
      `  resuming: ${verdictByRecord.size} verdict(s) already decided under rules ${rules}, ` +
        `${pending.length} to fetch`,
    )
  } else {
    console.log(`  retrieval rules ${rules} — no cached verdicts, every file will be fetched`)
  }

  const CONCURRENCY = 8
  let failedChecks = 0
  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const batch = pending.slice(i, i + CONCURRENCY)
    const settled = await Promise.all(
      batch.map(async (f) => {
        try {
          const v = await checkEvidence(f, {
            agentOwner: identity.owners.get(String(f.agentId))?.toLowerCase() ?? null,
            archive,
          })
          return { rec: f, v }
        } catch (err) {
          /**
           * One hostile file must not end the run. `Promise.all` rejects the
           * whole batch on a single throw and the rejection reaches the top
           * level, so a four-byte body used to abort an audit of ten thousand
           * records — permanently, since the evidence phase has no resume.
           * Failing this one record loudly is the only safe behaviour.
           */
          failedChecks++
          console.error(`\n  ! evidence check threw for ${f.feedbackURI}: ${(err as Error).message}`)
          return { rec: f, v: null }
        }
      }),
    )
    for (const { rec, v } of settled) {
      if (!v) continue
      verdictByRecord.set(rec, v)
      cache.put(VerdictCache.key(rec), v)
    }
    process.stdout.write(`\r  evidence: ${verdictByRecord.size}/${toCheck.length}`)
  }
  if (toCheck.length) process.stdout.write('\n')
  if (failedChecks) console.log(`  ${failedChecks} check(s) threw and were dropped — see errors above`)
  if (archive) console.log(`  archived ${archive.size} distinct evidence files under out/evidence-corpus/`)
  await closeDispatchers()

  const verdicts: EvidenceVerdict[] = [...verdictByRecord.values()]

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
    .map((rec) => ({ rec, v: verdictByRecord.get(rec) }))
    .filter((x) => x.v?.claimsPayment)

  /**
   * Every record whose evidence was actually checked, with the rung it reached.
   *
   * The narrower claims file below covers only records that declare a payment —
   * 93 of 27,520. That is a third of a percent of the registry, and attesting
   * only those would leave the far more common failures (a file that no longer
   * resolves, a hash attested with no file at all) unrecorded. This file is the
   * full ladder, and it is what the attestation backfill consumes.
   */
  const checkedRows = feedback
    .filter((r) => verdictByRecord.has(r))
    .map((rec) => ({ rec, v: verdictByRecord.get(rec)!, unchecked: false }))

  /**
   * Records that declared a file the fetch cap kept us from opening.
   *
   * Dropping them made the export silently shorter than the registry: they
   * received no rung, so the ledger left them at `None` — "never attested" —
   * which is the one state the contract promises is unforgeable. A sampled
   * audit must say which records it skipped, not omit them.
   */
  const uncheckedRows = withPointer
    .filter((r) => !verdictByRecord.has(r))
    .map((rec) => ({ rec, v: undefined, unchecked: true }))

  const evidenceRows = [
    ...checkedRows,
    ...uncheckedRows,
    // Records that attested a hash while declaring no file: identifiable from
    // the event alone, no fetch needed, and a third of the registry. Records
    // declaring neither URI nor hash are left unattested — there is no
    // evidence claim to verify, and the ledger's None default says exactly that.
    ...feedback.filter((r) => !r.hasURI && r.hasHash).map((rec) => ({ rec, v: undefined, unchecked: false })),
  ]

  /**
   * `feedbackIndex` is carried explicitly.
   *
   * It was omitted once, and the backfill had to recover it by joining on
   * (agentId, reviewer, feedbackURI) — a triple that is not unique, because
   * every record that publishes no file carries the same empty URI. Exporting
   * the registry's own index removes the join, and with it a whole class of
   * silent mis-attestation.
   */
  const EVIDENCE_HEADER = [
    'timestamp', 'block', 'agentId', 'reviewer', 'feedbackIndex',
    'rung', 'evidenceRung',
    'hasURI', 'hasHash', 'fetched', 'jsonValid', 'hashMatched', 'inconclusive',
    'claimsPayment', 'proofPresent', 'txExistsOnCelo', 'paymentVerified', 'paymentAttributed',
    'partiesContradicted', 'onQueryableChain',
    'claimTxHash', 'claimNetwork', 'amount', 'symbol', 'decimals', 'token',
    'declaredFrom', 'declaredTo', 'transferFrom', 'transferTo', 'transferCount',
    'evidenceHash', 'contentSha256', 'contentKeccak', 'bytes', 'observedAt', 'via',
    'note', 'partyNote', 'feedbackURI',
  ]

  const UNCHECKED_NOTE = 'not checked — beyond MAX_FILE_FETCHES sampling cap; nothing is attested for this record'

  writeFileSync(
    'out/evidence.csv',
    [
      EVIDENCE_HEADER.join(','),
      ...evidenceRows.map(({ rec, v, unchecked }) =>
        [
          new Date(rec.timestamp * 1000).toISOString(),
          rec.blockNumber,
          rec.agentId,
          rec.reviewer,
          rec.feedbackIndex,
          /**
           * `NotChecked` is not a verdict, and must not be spelled like one.
           *
           * These rows were sampled out: we never opened the file. Calling
           * that `EvidenceInconclusive` — "we tried and learned nothing" —
           * published a retrieval failure against publishers nobody had
           * contacted, and the backfill wrote every one of them on chain. The
           * row stays here, because a sampled audit must say which records it
           * skipped; the backfill reads this rung and writes nothing.
           */
          v ? rung(rec, v) : unchecked ? 'NotChecked' : 'EvidenceAbsent',
          v ? evidenceRung(rec, v) : unchecked ? 'NotChecked' : 'Absent',
          rec.hasURI,
          rec.hasHash,
          v?.fetched ?? false,
          v?.jsonValid ?? false,
          v?.hashMatches ?? false,
          // An unopened record produced no retrieval outcome at all, so this
          // column is false for it: `inconclusive` describes an attempt.
          v?.inconclusive ?? false,
          v?.claimsPayment ?? false,
          v?.proofPresent ?? false,
          v?.txExists ?? false,
          v?.paymentVerified ?? false,
          v?.paymentAttributed ?? false,
          v?.partiesContradicted ?? false,
          v?.onQueryableChain ?? true,
          v?.claimTxHash ?? '',
          v?.claimNetwork ?? '',
          v?.amount == null ? '' : v.amount.toString(),
          v?.symbol ?? '',
          v?.decimals == null ? '' : String(v.decimals),
          v?.token ?? '',
          v?.declaredFrom ?? '',
          v?.declaredTo ?? '',
          v?.transferFrom ?? '',
          v?.transferTo ?? '',
          v?.transferCount ?? 0,
          rec.feedbackHash,
          v?.sha256 ?? '',
          v?.contentId ?? '',
          v?.bytes == null ? '' : String(v.bytes),
          v?.observedAt ? new Date(v.observedAt * 1000).toISOString() : '',
          v?.via ?? '',
          unchecked ? UNCHECKED_NOTE : (v?.note ?? ''),
          v?.partyNote ?? '',
          rec.feedbackURI,
        ]
          .map(csvEsc)
          .join(','),
      ),
    ].join('\n'),
  )

  const CLAIMS_HEADER = [
    'timestamp', 'block', 'agentId', 'reviewer', 'feedbackIndex',
    'claimNetwork', 'onQueryableChain', 'claimTxHash', 'txExistsOnCelo',
    'paymentVerified', 'paymentAttributed', 'partiesContradicted',
    'amount', 'symbol', 'decimals', 'token',
    'declaredFrom', 'declaredTo', 'transferFrom', 'transferTo', 'transferCount',
    'note', 'partyNote', 'feedbackURI',
  ]

  writeFileSync(
    'out/claims.csv',
    [
      CLAIMS_HEADER.join(','),
      ...claimRows.map(({ rec, v }) =>
        [
          new Date(rec.timestamp * 1000).toISOString(),
          rec.blockNumber,
          rec.agentId,
          rec.reviewer,
          rec.feedbackIndex,
          v!.claimNetwork ?? '',
          v!.onQueryableChain,
          v!.claimTxHash ?? '',
          v!.txExists,
          v!.paymentVerified,
          v!.paymentAttributed,
          v!.partiesContradicted,
          v!.amount == null ? '' : v!.amount.toString(),
          v!.symbol ?? '',
          v!.decimals == null ? '' : String(v!.decimals),
          v!.token ?? '',
          v!.declaredFrom ?? '',
          v!.declaredTo ?? '',
          v!.transferFrom ?? '',
          v!.transferTo ?? '',
          v!.transferCount,
          v?.note ?? '',
          v?.partyNote ?? '',
          rec.feedbackURI,
        ]
          .map(csvEsc)
          .join(','),
      ),
    ].join('\n'),
  )

  /**
   * What this run examined, for the attester to publish on chain.
   *
   * `observed` comes from the indexer, not from the export: the point of a
   * coverage claim is that it counts what the registry emitted, including the
   * records this audit deliberately writes no verdict for. Taking it from the
   * CSV would make the claim agree with itself by construction.
   */
  /**
   * The root covers what was OBSERVED, never what was written.
   *
   * A root over the attested rows proves only what the events already prove —
   * it cannot answer "was this record in scope and skipped", which is the one
   * question the coverage claim exists for. So it is built here, by the only
   * component that knows the observed set, and the writer merely carries it.
   */
  const observedKeys = feedback.map((f) => recordKey(f.agentId, f.reviewer, f.feedbackIndex))
  writeFileSync('out/observed-keys.txt', [...new Set(observedKeys)].sort().join('\n') + '\n')
  writeFileSync(
    'out/sweep.json',
    JSON.stringify({
      fromBlock: fromBlock.toString(),
      toBlock: toBlock.toString(),
      observed: feedback.length,
      observedRoot: merkleRoot(observedKeys),
      declaringEvidence: withPointer.length,
      exportedRows: evidenceRows.length,
      auditVersion: AUDIT_VERSION,
      /**
       * The rules the verdicts behind this sweep were decided under.
       *
       * A coverage claim becomes an on-chain assertion, so it has to say what
       * produced it. Without this the manifest names a version and a date and
       * nothing about the retrieval semantics — which is how the previous run
       * came to republish verdicts decided under rules that had since been
       * corrected, and looked entirely legitimate doing it.
       */
      retrievalRules: rules,
      producedAt: new Date().toISOString(),
    }, null, 2),
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
  console.log(`  …and attributable to both   ${evidence.paymentAttributed}`)
  console.log(`  parties contradict claim    ${evidence.partyMismatch}`)
  console.log(`  declared on another chain   ${evidence.foreignChain}`)
  console.log(`  retrieval inconclusive      ${evidence.inconclusive}  (not a finding)`)
    if (settlements.length || process.env.SKIP_SETTLEMENTS === '0') {
    console.log(`  reviewer demonstrably paid  ${stats.backed}`)
  }
  console.log(`  written by Self ID holder   ${stats.humanBacked}`)
  console.log('─'.repeat(60))
  console.log(
    `\nWrote out/audit.md, out/audit.json, out/samples.json,\n` +
      `      out/claims.csv (${claimRows.length} payment claims) and\n` +
      `      out/evidence.csv (${evidenceRows.length} records — the full ladder)` +
      (archive ? `\n      out/evidence-corpus/ (${archive.size} archived files, content-addressed)` : ''),
  )
}

main().catch((e) => {
  console.error('\nAudit failed:', e)
  process.exit(1)
})
