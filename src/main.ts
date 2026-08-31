import { mkdirSync, writeFileSync } from 'node:fs'
import type { Address } from 'viem'
import { latestBlock, assertDeterministicLogs } from './rpc.js'
import { AUDIT_VERSION, RETRIEVAL_RULES, retrievalFingerprint } from './config.js'
import { BLOCKS_PER_DAY, REGISTRY_DEPLOY_BLOCK, REPUTATION_REGISTRY, NEW_FEEDBACK_EVENT } from './config.js'
import { SETTLEMENT_TOKENS, MAX_SETTLEMENT_PASSES, settlementPasses } from './config.js'
import { loadFeedback } from './sources/feedback.js'
import { loadIdentity, loadSelfVerified } from './sources/identity.js'
import { loadSettlementsFrom } from './sources/settlements.js'
import { checkEvidence, type EvidenceVerdict } from './analysis/evidence.js'
import { pool } from './pool.js'
import { EvidenceArchive } from './archive.js'
import { sample, sampleStride } from './sample.mjs'
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
import { resolveRange } from './range.js'
import { renderMarkdown, renderJSON, collectEvidence, rung, evidenceRung, type AuditResult } from './report.js'

const iso = (ts: number) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : 'unknown')

async function main() {
  const maxFetches = Number(process.env.MAX_FILE_FETCHES ?? 2000)

  const head = await latestBlock()
  /**
   * The range decision lives in range.ts, as a pure function tested without a
   * chain. It is the one setting that changes which records exist rather than
   * how carefully each is checked, so a report that gets it wrong is internally
   * consistent, names a range in its own filename, and is wrong about the
   * world.
   */
  const range = resolveRange({
    window: process.env.AUDIT_WINDOW,
    from: process.env.AUDIT_FROM_BLOCK,
    to: process.env.AUDIT_TO_BLOCK,
    head,
    deployBlock: REGISTRY_DEPLOY_BLOCK,
    blocksPerDay: BLOCKS_PER_DAY,
  })
  if (!range.ok) {
    for (const line of range.lines) console.error(line)
    process.exit(1)
  }
  const { fromBlock, toBlock } = range
  if (range.pinnedTo) console.log(`  pinned to block ${toBlock} (AUDIT_TO_BLOCK)`)
  if (range.pinnedFrom) console.log(`  starting at block ${fromBlock} (AUDIT_FROM_BLOCK)`)

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
  /**
   * A window that held nothing is a result, not a reason to stop.
   *
   * This used to return here, writing no manifest and leaving out/ holding the
   * previous run — which the sweep then republished and very nearly attested as
   * new work. Worse than the stale files: a range with no records could not be
   * claimed at all, so the coverage frontier stalled through every quiet period,
   * and a reader could no longer tell "nothing happened here" from "the attester
   * stopped". That distinction is the entire purpose of publishing coverage.
   *
   * `commitSweep` accepts `observed 0, attested 0` with a zero root — checked
   * against the deployed bytecode — and the claim is exactly as falsifiable as
   * any other: re-index the range, and finding a single record refutes it.
   *
   * So the run continues with an empty set. Everything downstream is a count or
   * a proportion of zero, and the report's own NaN guards refuse to render a
   * figure that came out undefined, so an empty run either produces an honest
   * report of nothing or refuses loudly.
   */
  if (feedback.length === 0) {
    console.log('\n  no feedback records in this range — publishing a claim of nothing')
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
  let ranSettlements = false
  const skipSettlements = process.env.SKIP_SETTLEMENTS === '1'
  let settlements: Awaited<ReturnType<typeof loadSettlementsFrom>> = []
  if (skipSettlements) {
    console.log('  settlements: skipped (SKIP_SETTLEMENTS=1)')
  } else if (settlementPasses(reviewers.length) > MAX_SETTLEMENT_PASSES) {
    /**
     * The old guard fired above 300 reviewers and justified itself with a
     * static formula — reviewers/100 x tokens x span/5000 — that reported
     * 452,710 requests for this registry. That number ignored the chunking the
     * RPC layer actually does; the measured cost was 5.9 hours, and after
     * widening the topic filter it is about half an hour. A guard whose
     * arithmetic is wrong by two orders of magnitude does not protect anyone,
     * it just removes the one figure that depends on no off-chain file.
     */
    console.log(
      `  settlements: skipped — ${reviewers.length} reviewers over ` +
        `${SETTLEMENT_TOKENS.length} tokens is ${settlementPasses(reviewers.length)} ` +
        `full-history passes, above the ${MAX_SETTLEMENT_PASSES} allowed here.\n` +
        '              Raise MAX_SETTLEMENT_PASSES, or narrow AUDIT_WINDOW.',
    )
  } else {
    settlements = await loadSettlementsFrom(reviewers, fromBlock, toBlock)
    ranSettlements = true
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
    toCheck = sample(withPointer, maxFetches)
    stride = sampleStride(withPointer.length, maxFetches)
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
  /**
   * Named by the RULES alone, not by the block range.
   *
   * A verdict is about a record, and a record is the same record whatever
   * window found it — so a per-range file was never separating anything the
   * per-record keys inside do not separate already. It did break resume: with
   * AUDIT_WINDOW set, fromBlock follows the chain head, which moves every
   * second on Celo, so the file was newly named on every run and the retrieval
   * phase — the one that takes hours — started from zero every time.
   */
  const rules = retrievalFingerprint()
  const cache = new VerdictCache(
    `${process.env.CACHE_DIR ?? 'data'}/evidence-verdicts-${rules}.jsonl`,
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

  /**
   * A worker pool, not a barrier of fixed-size batches.
   *
   * This was `Promise.all` over slices of 8: dispatch eight, wait for all
   * eight, dispatch the next eight. Throughput is then set by the *slowest*
   * record in every group rather than by the average, and one host that
   * exhausts EVIDENCE_BUDGET_MS holds seven finished workers idle for the rest
   * of its 45 seconds.
   *
   * That is not a theoretical cost. One host in this registry accounts for
   * 1,570 of the 10,469 declared pointers and never answers, so roughly every
   * batch contained at least one budget-exhausting record and the measured
   * rate sat at 8/45s — 10.7 records a minute, to four significant figures the
   * arithmetic of the barrier rather than of the network. A full pass took
   * over sixteen hours to do a few hours of work.
   *
   * Each worker now pulls the next record the moment it finishes its own, so
   * the pool runs at the mean latency instead of the maximum. The number of
   * requests in flight is unchanged — this buys throughput without asking any
   * host for more than it was already being asked.
   */
  const CONCURRENCY = Math.max(1, Number(process.env.EVIDENCE_CONCURRENCY ?? 8))
  let failedChecks = 0
  await pool(pending, CONCURRENCY, async (f) => {
    let v: EvidenceVerdict | null = null
    try {
      v = await checkEvidence(f, {
        agentOwner: identity.owners.get(String(f.agentId))?.toLowerCase() ?? null,
        archive,
      })
    } catch (err) {
      /**
       * One hostile file must not end the run. A throw that escapes here
       * reaches the top level and kills a pass over ten thousand records —
       * permanently, for everything not yet written to the verdict cache.
       * Failing this one record loudly is the only safe behaviour.
       */
      failedChecks++
      console.error(`\n  ! evidence check threw for ${f.feedbackURI}: ${(err as Error).message}`)
    }
    if (!v) return
    verdictByRecord.set(f, v)
    cache.put(VerdictCache.key(f), v)
    process.stdout.write(`\r  evidence: ${verdictByRecord.size}/${toCheck.length}`)
  })
  if (toCheck.length) process.stdout.write('\n')
  if (failedChecks) console.log(`  ${failedChecks} check(s) threw and were dropped — see errors above`)
  if (archive) {
    console.log(
      `  evidence corpus: ${archive.written} file(s) written by this run, ` +
        `${archive.size} distinct in the store`,
    )
  }
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
  // Files this run actually wrote, as distinct from verdicts carrying a
  // content id — a warm resume cache fills the second without fetching.
  evidence.archivedThisRun = archive ? archive.written : 0
  // Files on disk, not manifest lines: the corpus figure is a promise that a
  // verdict stays checkable against bytes that are actually there.
  evidence.corpusSize = archive ? archive.onDisk : 0
  evidence.corpusRecorded = archive ? archive.size : 0
  evidence.corpusNotStored = archive ? archive.recordedNotStored : 0
  /**
   * Which hosts the inconclusive count is actually about.
   *
   * "Records this audit could not reach, for reasons that prove nothing" is
   * honest and, published as one number, still misleads: it reads as a diffuse
   * network tax spread across the registry. It is not. One host accounts for
   * nearly half of it and never answered once. That is a fact about a single
   * publisher's infrastructure, and a reader who is not told cannot tell the
   * difference between "the web is flaky" and "one operator's files are all
   * gone but we decline to say so".
   */
  {
    /**
     * A CID is not a host.
     *
     * This bucketed by `new URL(uri).hostname`, and for `ipfs://Qm…` that is
     * the content identifier — so every unresolved CID became its own
     * "publisher" and the count read 982 distinct hosts. The honest answer is
     * five origins, one of which carries 45%: an `ipfs://` pointer is served by
     * whichever gateway answers, so the gateway set is the origin and the CID
     * is the thing being asked for. Publishing 982 made a concentrated failure
     * look like a diffuse one, which is the same defect this report exists to
     * object to, committed in the code that reports it.
     */
    const perHost = new Map<string, number>()
    for (const [rec, v] of verdictByRecord) {
      if (!v.inconclusive) continue
      const uri = rec.feedbackURI ?? ''
      const scheme = uri.includes(':') ? uri.slice(0, uri.indexOf(':')).toLowerCase() : ''
      let origin: string
      if (scheme === 'http' || scheme === 'https') {
        try {
          origin = new URL(uri).hostname || '(no host)'
        } catch {
          origin = '(unparseable URI)'
        }
      } else if (scheme) {
        origin = `${scheme}:// (no gateway served it)`
      } else {
        origin = '(no scheme)'
      }
      perHost.set(origin, (perHost.get(origin) ?? 0) + 1)
    }
    const total = [...perHost.values()].reduce((a, b) => a + b, 0) || 1
    evidence.inconclusiveTopHosts = [...perHost.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([host, records]) => ({ host, records, share: records / total }))
    evidence.inconclusiveHosts = perHost.size
  }
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
    settlementsRan: ranSettlements,
    /**
     * Both halves: what the rules ARE, and the digest that proves settings equality.
     *
     * This published only the fingerprint under a label reading "retrieval
     * rules" — a hex digest that proves two runs shared their settings and
     * tells a reader nothing about which semantics decided the verdicts. The
     * name is the half a human can act on; the digest is the half a machine
     * can compare. Publishing one under the other's label is the defect this
     * report is about.
     */
    retrievalRulesName: RETRIEVAL_RULES,
    retrievalRules: rules,
    observedRoot: merkleRoot(feedback.map((f) => recordKey(f.agentId, f.reviewer, f.feedbackIndex))),
    archivedThisRun: archive ? archive.written : 0,
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

  /**
   * When THIS run looked at the registry, for rows decided from the event
   * alone.
   *
   * A record that attested a hash and published no file needs no fetch: the
   * event says it, and the verdict is EvidenceAbsent. But the row still went
   * out with an empty observedAt, which the backfill reads as 0 and the
   * contract stores as "not stated" — so the state on chain carried whatever
   * date a PREVIOUS pass had left, describing a verdict this one had just
   * replaced. A dimension that is stated must say when it was looked at, and
   * for these rows the answer is: now, in this run, in the registry's own log.
   */
  const RUN_OBSERVED_AT = new Date().toISOString()

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
          v?.observedAt
            ? new Date(v.observedAt * 1000).toISOString()
            : unchecked ? '' : RUN_OBSERVED_AT,
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
  const distinctKeys = [...new Set(observedKeys)].sort()
  writeFileSync('out/observed-keys.txt', distinctKeys.join('\n') + '\n')
  /**
   * `observed` counts records; the root commits to distinct keys.
   *
   * They are the same number here and are not the same number by construction:
   * `merkleRoot` dedupes, so two records sharing an (agentId, reviewer,
   * feedbackIndex) triple would be one leaf and two in the count. That gap
   * would be published on chain as a coverage claim, where a verifier counting
   * leaves and a verifier reading `observed` would reach different conclusions
   * about the same run and neither would be told why. If it ever opens, the
   * manifest says so out loud rather than carrying two figures that quietly
   * describe different sets.
   */
  const duplicateKeys = observedKeys.length - distinctKeys.length
  if (duplicateKeys > 0) {
    console.warn(
      `\n  ! ${duplicateKeys} feedback record(s) share an (agentId, reviewer, feedbackIndex)` +
        '\n    triple. The coverage root commits to distinct keys, so it has fewer leaves' +
        '\n    than `observed` counts records. Both numbers are in out/sweep.json.',
    )
  }
  writeFileSync(
    'out/sweep.json',
    JSON.stringify({
      fromBlock: fromBlock.toString(),
      toBlock: toBlock.toString(),
      observed: feedback.length,
      /** Leaves in the root below. Equal to `observed` unless a triple repeats. */
      observedDistinct: distinctKeys.length,
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
      retrievalRulesName: RETRIEVAL_RULES,
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
  console.log(`  declaring a file            ${evidence.declaresURI}`)
  console.log(`  …of which retrieved         ${evidence.fetched}`)
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
      `      out/evidence.csv (${evidenceRows.length} of ${feedback.length} records — every record\n        that declares a URI or a hash; the ${feedback.length - evidenceRows.length} that declare neither\n        have no evidence claim to verify and are left unattested)` +
      (archive ? `\n      out/evidence-corpus/ (${archive.size} archived files, content-addressed)` : ''),
  )
}

main()
  .then(() => {
    /**
     * Say the work is done, then actually stop.
     *
     * The audit wrote every output and then hung: `closeDispatchers()` closes
     * the evidence fetcher's connections, but Node's global agent keeps the
     * RPC client's keep-alive sockets open — eight of them — and the event
     * loop stays alive on handles nothing will ever use again. Measured: a run
     * that finished at 11:19 was still resident at 13:36.
     *
     * Nothing is lost by this, because every writeFileSync above has already
     * returned. But a run that never exits is a stuck job in CI, a cron entry
     * that overlaps itself, and a container that is never reclaimed.
     */
    process.exit(0)
  })
  .catch((e) => {
    console.error('\nAudit failed:', e)
    process.exit(1)
  })
