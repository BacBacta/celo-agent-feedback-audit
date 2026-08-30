import type { ConcentrationStats, Burst } from './analysis/concentration.js'
import type { ReconciliationStats } from './analysis/reconcile.js'
import type { EvidenceVerdict } from './analysis/evidence.js'

export interface AuditResult {
  fromBlock: bigint
  toBlock: bigint
  fromDate: string
  toDate: string
  totalFeedback: number
  revokedFeedback: number
  distinctAgentsRated: number
  registeredAgents: number
  evidence: {
    declaresURI: number
    declaresHash: number
    hashWithoutURI: number
    withPointer: number
    /** Bytes came back. Says nothing about whether they were a usable document. */
    fetched: number
    /**
     * The bytes came back *and* parsed as a JSON object.
     *
     * `fetched` was published as "the file actually resolved" and again, in the
     * same table, as "File retrievable" — one measure printed as two rungs of a
     * ladder, which made the chain look like it survived a step it never took.
     * 1,410 of the 3,560 retrievals returned something that was not a document.
     */
    parsed: number
    hashMatched: number
    /** Inside the chain: a hash-matched document that carries a payment claim. */
    claimsPayment: number
    /**
     * Every payment claim, whatever the state of the file carrying it.
     *
     * The two are equal in this run and are not equal by construction. If they
     * ever diverge, the difference is claims made in documents that do not
     * match their attested hash — which is a finding, not a rounding error.
     */
    claimsPaymentAnyHash: number
    txExists: number
    paymentVerified: number
    paymentAttributed: number
    partyMismatch: number
    foreignChain: number
    inconclusive: number
    /**
     * Verdicts carrying a content identifier.
     *
     * Named `archivedFiles`, which promised a count of files on disk. A warm
     * resume cache fills this without writing anything, so the two are
     * unrelated numbers; `archivedThisRun` and `corpusSize` are the file counts.
     */
    contentAddressed: number
    /**
     * Files this run actually wrote to disk.
     *
     * `contentAddressed` counts verdicts carrying a content identifier, which a
     * warm resume cache fills without fetching anything — so the sentence
     * "N retrieved files were archived… every verdict stays checkable"
     * described a corpus that could be empty, and on the last run was: 619
     * claimed, 0 files on disk.
     */
    archivedThisRun: number
    /** Blobs actually on disk, counted from the directory. */
    corpusSize: number
    /** Content ids the manifest records. Equal to corpusSize unless a blob is missing. */
    corpusRecorded: number
    sampled: number
    sampleStride: number
    /** Which origins the inconclusive count is about, largest first. */
    inconclusiveTopHosts: { host: string; records: number; share: number }[]
    /** Distinct origins behind the inconclusive records. */
    inconclusiveHosts: number
  }
  reconciliation: ReconciliationStats
  concentration: ConcentrationStats
  bursts: Burst[]
  settlementsSeen: number
  /**
   * What produced this report, so a reader can re-derive it rather than
   * believe it. A census that cannot be re-run to the same range is an
   * assertion with a table in front of it.
   */
  /** The semantic rules version, e.g. r8-ssrf-cid-datauri. */
  retrievalRulesName?: string
  /** The digest of every setting that can change a verdict. */
  retrievalRules: string
  observedRoot: string
  archivedThisRun: number
  /**
   * Whether the sweep was actually attempted.
   *
   * `settlementsSeen === 0` cannot tell "we skipped this" from "we looked and
   * there was nothing", and the report printed the first for both — so a real
   * measurement of zero was published as a caveat saying no measurement had
   * been made.
   */
  settlementsRan: boolean
  selfVerifiedReviewers: number
}

/**
 * A formatter that refuses rather than printing `NaN`.
 *
 * A field the report reads and the result object does not carry rendered as
 * the string "NaN" in a numeric column — indistinguishable, to a reader, from
 * a measured zero or a rounding artifact, and published with the same
 * confidence as every real figure beside it. A report whose whole subject is
 * numbers that overstate what they measured cannot print one that measures
 * nothing at all.
 */
function requireFinite(n: number, where: string): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new Error(`report: ${where} is ${String(n)}, not a number — refusing to publish it`)
  }
  return n
}
const pct = (n: number, d: number) =>
  requireFinite(d, 'a denominator') === 0
    ? '0.0%'
    : `${((requireFinite(n, 'a numerator') / d) * 100).toFixed(1)}%`
const num = (n: number) => requireFinite(n, 'a published figure').toLocaleString('en-US')
/**
 * Fixed-point, refusing the same way.
 *
 * `requireFinite` was reached only through num() and pct(), while a dozen other
 * figures went straight to `.toFixed()` — including every number in the
 * Concentration section, which is where the comparability caveat lives. A
 * missing field there rendered a bold "NaN%" beside real measurements, in the
 * one place the report is warning a reader about false precision.
 */
const fx = (n: number, d = 1, where = 'a published figure') => requireFinite(n, where).toFixed(d)

export function renderMarkdown(r: AuditResult): string {
  const t = r.totalFeedback
  const burstEvents = r.bursts.reduce((s, b) => s + b.count, 0)
  const burstOneShot = r.bursts.reduce((s, b) => s + b.oneShotReviewers, 0)
  /**
   * Which clusters stand alone and which are stretches of continuous activity.
   *
   * "71% of feedback arrived in five-minute clusters" is exact and reads as
   * pervasive bursting. Clusters are disjoint, so the count is honest — but a
   * busy afternoon becomes a hundred consecutive clusters, each counted as
   * one, and the reader cannot tell that from a hundred separate spikes. The
   * distinction is the whole evidential weight of the section.
   */
  const burstRuns = (() => {
    const b = [...r.bursts].sort((x, y) => x.startTs - y.startTs)
    if (b.length === 0) {
      return { isolated: 0, isolatedRecords: 0, longest: 0, longestRecords: 0, longestSpanHours: 0 }
    }
    const runs: (typeof b)[] = []
    let cur: typeof b = [b[0]!]
    for (let i = 1; i < b.length; i++) {
      if (b[i]!.startTs - b[i - 1]!.endTs <= 300) cur.push(b[i]!)
      else { runs.push(cur); cur = [b[i]!] }
    }
    runs.push(cur)
    const solo = runs.filter((run) => run.length === 1)
    const size = (run: typeof b) => run.reduce((sum, c) => sum + c.count, 0)
    /**
     * ONE run, described by its own attributes.
     *
     * `longest` and `longestRecords` were two independent `Math.max` calls, so
     * the sentence "the longest run holds M records" paired the length of one
     * run with the record count of another whenever they were not the same run.
     * And the duration was `clusters × 5 minutes`, an upper bound on a shape
     * rather than the span that was measured: it read 9.75 h for a run whose
     * own timestamps say 12.42 h. Pick the run, then read its numbers off it.
     */
    const longestRun = runs.reduce((best, run) => (run.length > best.length ? run : best), runs[0]!)
    return {
      isolated: solo.length,
      isolatedRecords: solo.reduce((sum, run) => sum + size(run), 0),
      longest: longestRun.length,
      longestRecords: size(longestRun),
      longestSpanHours: (longestRun[longestRun.length - 1]!.endTs - longestRun[0]!.startTs) / 3600,
    }
  })()

  return `# Celo Agent Feedback Audit

**Scope.** ERC-8004 Reputation Registry on Celo mainnet, blocks ${r.fromBlock}–${r.toBlock}.
The first and last feedback records in that span are dated ${r.fromDate} and
${r.toDate}; the block range extends past the last record to the pinned head, so
the two are not the same interval and the dates are not the window's edges.

**Provenance.** Retrieval rules **${r.retrievalRulesName ?? '(unnamed)'}**, fingerprint
\`${r.retrievalRules}\`. The name says which semantics decided these verdicts; the
fingerprint digests every setting that can change one — gateways, limits,
timeouts, endpoint, proxy routing — so a run under different settings produces a
different digest and cannot silently reuse these answers.
Coverage root \`${r.observedRoot}\` over the distinct
(agentId, reviewer, feedbackIndex) keys of the ${num(r.totalFeedback)} records
observed in range — the root commits to keys, not to a count, and the two are
equal only while no triple repeats. Re-index the same blocks, rebuild the root,
and a mismatch is proof this census is incomplete. The evidence corpus in \`out/evidence-corpus/\`
holds ${num(r.evidence.corpusSize)} distinct files, content-addressed, of which
${num(r.archivedThisRun)} were written by this run: a verdict about a file that later
disappears stays checkable against the bytes it judged, whichever run fetched them.

## Headline

${
  r.evidence.sampled < r.evidence.declaresURI
    ? `> **Two of these rows are counts within a sample.** ${num(r.evidence.sampled)} of the ${num(r.evidence.declaresURI)} records declaring a file were opened, so "read and matched" and everything nested under it are lower bounds, not subsets of the row above in the ordinary sense. The Evidence chain section says which records were left unopened.\n\n`
    : ''
}What the registry says about itself, narrowing:

| Measure | Records | Share |
|---|---|---|
| Feedback records written | **${num(t)}** | 100% |
| ⤷ declaring an evidence file | **${num(r.evidence.declaresURI)}** | **${pct(r.evidence.declaresURI, t)}** |
| ⤷ ⤷ whose file this audit read and matched to its attested hash | ${num(r.evidence.hashMatched)} | ${pct(r.evidence.hashMatched, t)} |
| ⤷ ⤷ ⤷ claiming a specific payment transaction | ${num(r.evidence.claimsPayment)} | ${pct(r.evidence.claimsPayment, t)} |
| ⤷ ⤷ ⤷ ⤷ whose claimed transaction exists on chain | ${num(r.evidence.txExists)} | ${pct(r.evidence.txExists, t)} |
| ⤷ ⤷ ⤷ ⤷ ⤷ whose payment actually verifies | **${num(r.evidence.paymentVerified)}** | **${pct(r.evidence.paymentVerified, t)}** |
| ⤷ ⤷ ⤷ ⤷ ⤷ ⤷ and is *attributable* to this reviewer and agent | **${num(r.evidence.paymentAttributed)}** | **${pct(r.evidence.paymentAttributed, t)}** |
| ⤷ carrying only an attested hash, no file | ${num(r.evidence.hashWithoutURI)} | ${pct(r.evidence.hashWithoutURI, t)} |

The **read-and-matched** row is where most of the fall happens, and it is about
retrieval rather than about what reviewers declare: of
${num(r.evidence.declaresURI)} pointers, ${num(r.evidence.hashMatched)} led to a
document this audit could read and bind to its attested hash. The Evidence chain
section below decomposes that drop into its causes. Note that the Share column
stays relative to all ${num(t)} feedback records the whole way down — it is not
a share of the row above, so a small percentage there is not a small survival
rate at that step.

What the chain says, asked independently of anything a record declares. These
are not narrowings of the rows above and do not belong in that column:

| Measure | Records | Share |
|---|---|---|
| Reviewer demonstrably paid the agent | **${num(r.reconciliation.backed)}** | **${pct(r.reconciliation.backed, t)}** |
| Written by a Self Agent ID holder | **${num(r.reconciliation.humanBacked)}** | **${pct(r.reconciliation.humanBacked, t)}** |

${
  r.reconciliation.backed === 0
    ? `**${num(r.evidence.paymentAttributed)} attributable, and no reviewer-to-agent payment reconstructed either.** Both halves of the question came back empty in this window. That is a measurement, not an absence of one — see the settlement-sweep note below for whether the sweep ran at all.`
    : `**${num(r.evidence.paymentAttributed)} against ${num(r.reconciliation.backed)}** is
the finding. Not that payment is absent — one review in ${fx(t / r.reconciliation.backed, 0, 'the backed ratio')} is
backed by a stablecoin transfer this audit reconstructed from chain state — but
that essentially none of it is *declared*, and of the handful that is declared,
none survives attribution. The evidence slot the standard provides is not being
used by the people who are, in fact, paying. Both figures come with a
concentration caveat below; read them together with it.`
}

| Also measured | Count |
|---|---|
| Stablecoin transfers sent by these reviewers, to anyone (transfers, not records) | ${num(r.settlementsSeen)} |

## What the registry contains

- Feedback records: **${num(t)}** (${num(r.revokedFeedback)} later revoked)
- Distinct agents rated: **${num(r.distinctAgentsRated)}** of ${num(r.registeredAgents)} registered
- Distinct reviewer addresses: **${num(r.concentration.distinctReviewers)}**

## Evidence chain

ERC-8004 stores the evidence off-chain: the event carries a \`feedbackURI\` and a
\`feedbackHash\`, and the optional \`proofOfPayment\` object lives inside the file.
Each step below can fail independently, so the interesting result is where the
chain breaks.

${
  r.evidence.sampled < r.evidence.declaresURI
    ? `> **Sampled, not complete.** ${num(r.evidence.sampled)} of ${num(r.evidence.declaresURI)} records that declare a file were opened — every ${r.evidence.sampleStride}th, evenly spread across the period rather than taken from one end. Every row below from "bytes came back from the pointer" downwards is a count **within that sample**, while the percentages are of all feedback: read them as lower bounds. The ${num(r.evidence.declaresURI - r.evidence.sampled)} records that were not opened are exported with the rung \`NotChecked\` and nothing is attested for them.\n\n`
    : ''
}Each row indented under another is a **subset** of it, enforced by the
predicates that produce them rather than observed in this run's data. Rows at
the left margin start a new question and are not subsets of the row above — a
chain of indistinguishable rows is how a table implies a narrowing that never
happened.

One caveat the nesting cannot carry on its own: the retrieval rows count only
records this run actually opened. When every declared file is opened, as here,
that is the whole population and the subset relation is literal. Under a
sampling cap it is not, and the callout above says so.

| Step | Records | Share of all feedback |
|---|---|---|
| Declares a \`feedbackURI\` | ${num(r.evidence.declaresURI)} | ${pct(r.evidence.declaresURI, t)} |
| ⤷ bytes came back from the pointer | ${num(r.evidence.fetched)} | ${pct(r.evidence.fetched, t)} |
| ⤷ …and those bytes parsed as a JSON document | ${num(r.evidence.parsed)} | ${pct(r.evidence.parsed, t)} |
| ⤷ …and the document matches the attested hash | ${num(r.evidence.hashMatched)} | ${pct(r.evidence.hashMatched, t)} |
| ⤷ …and the document contains a payment claim | ${num(r.evidence.claimsPayment)} | ${pct(r.evidence.claimsPayment, t)} |
| ⤷ …and the claimed transaction exists on chain | ${num(r.evidence.txExists)} | ${pct(r.evidence.txExists, t)} |
| ⤷ …and it succeeded and moved value — **verified** | **${num(r.evidence.paymentVerified)}** | **${pct(r.evidence.paymentVerified, t)}** |
| ⤷ …and its parties are this reviewer and this agent — **attributed** | **${num(r.evidence.paymentAttributed)}** | **${pct(r.evidence.paymentAttributed, t)}** |
| ⤷ …or its parties contradict the claim — **mismatch** | ${num(r.evidence.partyMismatch)} | ${pct(r.evidence.partyMismatch, t)} |
| Declares a non-zero \`feedbackHash\` | ${num(r.evidence.declaresHash)} | ${pct(r.evidence.declaresHash, t)} |
| ⤷ …while publishing no file at all | ${num(r.evidence.hashWithoutURI)} | ${pct(r.evidence.hashWithoutURI, t)} |
| Payment claims in documents whose hash does *not* match | ${num(r.evidence.claimsPaymentAnyHash - r.evidence.claimsPayment)} | ${pct(r.evidence.claimsPaymentAnyHash - r.evidence.claimsPayment, t)} |
| Payment declared on a chain this audit does not query | ${num(r.evidence.foreignChain)} | ${pct(r.evidence.foreignChain, t)} |

> **What \`EvidenceUnreachable\` contains.** The rung is not a synonym for 404.
> It holds three different failures: a host that answered with an HTTP error, a
> host that answered with something that was not a JSON document (an HTML
> landing page or soft-404 — ${num(r.evidence.fetched - r.evidence.parsed)} of them, counted in
> "bytes came back" above and nowhere below it), and a pointer whose scheme this
> audit cannot resolve at all. Only the first is the host saying the file is
> gone. \`out/evidence.csv\` carries the reason per record in its \`note\` column.

> **Not a finding:** ${num(r.evidence.inconclusive)} records could not be retrieved for
> reasons that prove nothing — rate limits, timeouts, gateway outages. They are
> excluded from the dead-link count above rather than folded into it. A file
> this audit failed to reach is a question it failed to ask, not an answer.
> The corpus holds ${num(r.evidence.corpusSize)} distinct evidence files on disk, of which
> ${num(r.evidence.archivedThisRun)} were written by this run — the rest were archived by earlier
> runs and reused, and a run resumed entirely from cache writes none. Under
> \`out/evidence-corpus/\`, so every verdict above stays checkable after the
> originals go offline.${
  r.evidence.corpusRecorded !== undefined && r.evidence.corpusRecorded !== r.evidence.corpusSize
    ? ` **The manifest records ${num(r.evidence.corpusRecorded)} content ids, so ${num(Math.abs(r.evidence.corpusRecorded - r.evidence.corpusSize))} of them name bytes that are no longer there.** A verdict about those is no longer checkable, and this figure says so rather than counting manifest lines as files.`
    : ''
}
${
  r.evidence.inconclusiveTopHosts.length
    ? `
**And that number is about a handful of origins, not about the web.** These ${num(r.evidence.inconclusive)} records — not \`EvidenceUnreachable\`, which is a different and disjoint rung — come from ${num(r.evidence.inconclusiveHosts)} distinct origins, distributed like this:

| Origin | Records | Share of inconclusive |
|---|---|---|
${r.evidence.inconclusiveTopHosts.map((h) => `| \`${h.host}\` | ${num(h.records)} | ${fx(h.share * 100, 1, 'a self-ID share')}% |`).join('\n')}

The largest carries **${fx(r.evidence.inconclusiveTopHosts[0]!.share * 100, 0, 'the top origin share')}%**, and the top two carry **${fx(r.evidence.inconclusiveTopHosts.slice(0, 2).reduce((a, h) => a + h.share, 0) * 100, 0, 'the top two origin shares')}%** between them. This audit still classes these records inconclusive rather than dead, and that is deliberate: a host that never answers has not told us its files are gone, and an \`ipfs://\` pointer no gateway serves may still be pinned somewhere this audit did not ask. But a reader owed the number is also owed its shape — it is not a diffuse tax on reaching the web. It is a small number of origins, of two kinds: content addressed to a network that no longer holds it, and one publisher's endpoint that never answered.
`
    : ''
}

## Payment backing, reconstructed${r.settlementsRan === false ? ' — not run' : ''}

${r.settlementsRan === false ? '> **The settlement sweep did not run for this window, so this section is not a measurement.** `backed` and `paidAfterReview` are zero by construction, which means the residual row below absorbs every record and reads 100% — that row is the count of questions this audit never asked, published in the slot where a negative answer normally goes. Read the whole section as unmeasured, not as negative. The headline above — whether a *declared* payment exists on chain — is verified per transaction hash and does not depend on the sweep.\n\n' : ''}${r.settlementsRan === true && r.settlementsSeen === 0 ? '> The settlement sweep ran and found no transfers between these parties. That is a measurement, not an absence of one.\n\n' : ''}Independently of what a record declares, did this reviewer actually pay this
agent's owner, in a stablecoin, before rating it?

Every record falls into exactly one of these four. The Share column is rounded
to one decimal, so it need not read as exactly 100%:

| Outcome | Records | Share |
|---|---|---|
| Paid the agent before reviewing it | **${num(r.reconciliation.backed)}** | **${pct(r.reconciliation.backed, t)}** |
| Paid only *after* reviewing | ${num(r.reconciliation.paidAfterReview)} | ${pct(r.reconciliation.paidAfterReview, t)} |
| ${r.settlementsRan === false ? '**Not looked for** — the sweep did not run' : 'No payment relationship found'} | ${num(t - r.reconciliation.backed - r.reconciliation.paidAfterReview - r.reconciliation.unresolvedAgent)} | ${pct(t - r.reconciliation.backed - r.reconciliation.paidAfterReview - r.reconciliation.unresolvedAgent, t)} |
| Not askable — the agent has no owner in the registry | ${num(r.reconciliation.unresolvedAgent)} | ${pct(r.reconciliation.unresolvedAgent, t)} |

The last row is what this audit could not ask the question of at all, kept
apart from "no relationship found" rather than folded into it: an unasked
question published as a negative answer is the failure this whole report is
about.

These two overlap the four above and each other, so they are counted
separately:

| Also true of some of them | Records | Share |
|---|---|---|
| Reviewer is the agent's *current* registered owner | ${num(r.reconciliation.selfDealing)} | ${pct(r.reconciliation.selfDealing, t)} |
| Paid **and** written by a Self ID holder | ${num(r.reconciliation.backedAndHumanBacked)} | ${pct(r.reconciliation.backedAndHumanBacked, t)} |

Ownership is measured *as the registry holds it now*. An agent minted by its
reviewer and transferred away before this run reads false, so read that row as
a lower bound on self-dealing and not as its absence.

### …and how few relationships that rests on

${pct(r.reconciliation.backed, t)} of reviews being backed by a real payment is
exact, and on its own it suggests a broad market. It is not one. The ${num(r.reconciliation.backed)}
backed records come from **${num(r.reconciliation.backingPairs)} distinct
reviewer→owner relationships**, and they are distributed like this:

| Relationship | Backed records | Share of backed |
|---|---|---|
${r.reconciliation.backingTopPairs
  .map((p) => `| \`${p.reviewer.slice(0, 10)}…\` → \`${p.owner.slice(0, 10)}…\` | ${num(p.records)} | ${fx(p.share * 100, 1, 'a backing pair share')}% |`)
  .join('\n')}

${r.reconciliation.backingTopPairs.length
  ? `The largest single relationship carries **${fx(r.reconciliation.backingTopPairs[0]!.share * 100, 0, 'the top backing share')}%** of the backed records, ${r.reconciliation.backingTopPairs.length > 1 ? `and the ${r.reconciliation.backingTopPairs.length} listed above carry **${fx(r.reconciliation.backingTopPairs.reduce((a, p) => a + p.share, 0) * 100, 0, 'the listed backing share')}%** between them. ` : 'and it is the only one listed above. '}Read the headline as "a few operators pay, and almost nobody else does" rather than as a market rate.`
  : ''}

### The same question, asked of the Self-ID figure

${num(r.reconciliation.humanBacked)} records were written by an address holding a
Self Agent ID. That is **${num(r.reconciliation.humanBackedReviewers)} distinct
addresses**${r.reconciliation.humanBackedTop.length ? `, of which the largest wrote ${num(r.reconciliation.humanBackedTop[0]!.records)} — ${fx(r.reconciliation.humanBackedTop[0]!.share * 100, 0, 'the top self-ID share')}% of the figure` : ''}.
Read it as "a handful of verified operators are prolific", not as
"${pct(r.reconciliation.humanBacked, t)} of reviews came from a verified human",
which is what the percentage alone suggests.

| Self-ID reviewer | Records | Share of the figure |
|---|---|---|
${r.reconciliation.humanBackedTop
  .map((h) => `| \`${h.reviewer.slice(0, 10)}…\` | ${num(h.records)} | ${fx(h.share * 100, 1, 'a self-ID share')}% |`)
  .join('\n')}

## Concentration

- Gini over **reviews per reviewer**: **${fx(r.concentration.gini, 3, 'gini')}**
- The 10 most prolific reviewers wrote: **${fx(r.concentration.topTenShare * 100, 1, 'topTenShare')}%** of all feedback
- Reviewers who reviewed exactly once: **${fx(r.concentration.oneShotReviewerRate * 100, 1, 'oneShotReviewerRate')}%**
- Most feedback from a single address: **${num(r.concentration.maxBySingleReviewer)}**

> **These are not comparable to the arXiv ERC-8004 study's figures, and an
> earlier version of this report said they were.** That study (2606.26028, 24
> June 2026) covers Ethereum, BSC and Base through 13 May 2026, not Celo. Its
> Gini coefficients — 0.733, 0.708, 0.134 — measure **agents owned per wallet**,
> a concentration of registration. The figure above measures **reviews written
> per reviewer**. Its "top 10%" is a decile of wallets holding agents; the
> figure above is the ten single busiest reviewers. It reports no one-shot
> reviewer rate at all.
>
> The proximity is what makes the claim dangerous rather than merely wrong:
> ${fx(r.concentration.topTenShare * 100, 1, 'topTenShare')}% beside that study's ">70%"
> reads as corroboration between two measurements that never met.
>
> Its headline — 73.6%, 59.2% and 90.6% of reviewers exhibiting coordinated
> Sybil behaviour — comes from a shared-first-funder funding graph: each reviewer
> is traced to the address that first sent it native tokens, and reviewers under
> a common root are one cluster. **This audit does not implement that analysis
> and publishes no Sybil figure.** Nothing below should be read as a Celo
> counterpart to it.

## Temporal clustering

${num(r.bursts.length)} clusters of ≥5 reviews within a 5-minute window. Those
clusters hold **${num(burstEvents)} records (${pct(burstEvents, t)} of all
feedback)**. Separately, ${num(burstOneShot)} of the addresses writing inside
them never reviewed anything again — a count of reviewers, not of the records
above, and the two must not be read as one figure.

A genuinely busy hour looks like this too. These are reported for inspection,
not labelled fraudulent — and the shape below is why that caveat is not a
formality.

Clusters are disjoint by construction: a record belongs to at most one, so the
figure above is not double-counted. But a *sustained* busy period is chopped
into back-to-back clusters, and each one is counted separately, which makes
continuous operation look like repeated bursting. Separating the two:

| | Clusters | Records |
|---|---|---|
| Isolated — no other cluster within 5 minutes | ${num(burstRuns.isolated)} | ${num(burstRuns.isolatedRecords)} |
| Inside a run of consecutive clusters | ${num(r.bursts.length - burstRuns.isolated)} | ${num(burstEvents - burstRuns.isolatedRecords)} |

${
  burstRuns.longest > 1
    ? `The longest unbroken run is **${num(burstRuns.longest)} consecutive clusters** holding ${num(burstRuns.longestRecords)} records, spanning ${fx(burstRuns.longestSpanHours, 1, 'the longest run span')} hours from the first cluster's start to the last one's end — continuous five-or-more-per-five-minutes activity, which reads as an operator running rather than as a spike. Only the isolated clusters are the shape the word "burst" describes.`
    : 'No cluster has a neighbour within five minutes, so every one of them stands alone: here the word "burst" describes the whole figure.'
}

## Method and limits

- **What is reproducible, and what is not.** Re-run with:

  \`\`\`
  AUDIT_TO_BLOCK=${r.toBlock} SKIP_SETTLEMENTS=0 MAX_FILE_FETCHES=100000 npm run audit
  \`\`\`

  Without the pin, \`npm run audit\` follows the chain head — Celo produces a
  block a second — so a re-run covers a different span and disagrees slightly
  with the numbers above. The pin is what makes disagreement meaningful.

  Everything derived from the chain reproduces exactly: the record count, the
  coverage root, the ladder rows that read the event alone, the concentration
  and clustering figures, and every payment verdict, which is a transaction
  receipt lookup. Three things do not, and saying "every figure is reproducible"
  concealed all three. **Retrieval outcomes depend on the network at the moment
  of the run**: a host that times out today answers tomorrow, and the record
  moves between \`EvidenceInconclusive\` and a documentary rung — the
  ${num(r.evidence.inconclusive)} inconclusive records are precisely the ones
  whose verdict is a property of the run. **The corpus counters are
  cache-relative by construction**: a re-run resumed from a warm verdict cache
  writes nothing and reports zero newly archived, which is correct and not
  comparable. **The RPC endpoint is not pinned by that command** — set
  \`CELO_RPC_URL\` to the endpoint you want; it is part of the retrieval
  fingerprint above, so a different one refuses to reuse this run's cache rather
  than silently mixing the two.
- Payment detection covers USDC, USDT and USAT — the assets the Celo x402
  facilitator settles. Payments in other assets, or routed through a contract
  rather than sent directly, are not counted, so the payment-backed rate is a
  **lower bound**.
- Agent ownership comes from ERC-721 mints and transfers on the Identity
  Registry. An agent paid at an address other than its NFT owner will not match.
- Correlation is not endorsement: a payment before a review does not prove the
  review is honest. It proves only that something was at stake, which is exactly
  what is missing today.
- **Verified is not attributed.** \`PaymentVerified\` says a cited transaction
  settled; it does not say the payer was the reviewer or the payee the agent.
  Anyone may cite any real transfer, so that rung is a floor, not a filter. Only
  \`PaymentAttributed\` — both ends confirmed — carries the strong claim, and
  only \`PaymentPartyMismatch\` is an accusation.
- A payment is attributed against the agent's *registered NFT owner*. An agent
  paid at an operator address it controls but does not hold the token for reads
  as unattributed, so the attributed count is a **lower bound**.
- Amounts are reported unthresholded. A verified settlement of one millionth of
  a dollar and one of five hundred dollars reach the same rung; the amount is
  published alongside so a consumer can set its own floor.
`
}

export function renderJSON(r: AuditResult): string {
  return JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)
}

export function collectEvidence(verdicts: EvidenceVerdict[], sampled: number) {
  return {
    declaresURI: 0,
    declaresHash: 0,
    hashWithoutURI: 0,
    sampleStride: 1,
    withPointer: verdicts.filter((v) => v.hasPointer).length,
    /**
     * The ladder is nested by construction, not by luck.
     *
     * Each of these was an independent filter, and the table presented them as
     * a chain in which each row narrows the one above. That held in the data by
     * coincidence — a document carrying a payment claim under a hash that does
     * not match would have appeared *below* a row it is not inside, and the
     * table would have gone on reading as a chain. Nesting the predicates makes
     * the shape the table promises a property of the code.
     */
    fetched: verdicts.filter((v) => v.fetched).length,
    parsed: verdicts.filter((v) => v.fetched && v.jsonValid).length,
    hashMatched: verdicts.filter((v) => v.fetched && v.jsonValid && v.hashMatches).length,
    claimsPayment: verdicts.filter((v) => v.fetched && v.jsonValid && v.hashMatches && v.claimsPayment).length,
    claimsPaymentAnyHash: verdicts.filter((v) => v.claimsPayment).length,
    txExists: verdicts.filter((v) => v.fetched && v.jsonValid && v.hashMatches && v.claimsPayment && v.txExists).length,
    paymentVerified: verdicts.filter(
      (v) => v.fetched && v.jsonValid && v.hashMatches && v.claimsPayment && v.txExists && v.paymentVerified,
    ).length,
    paymentAttributed: verdicts.filter(
      (v) =>
        v.fetched && v.jsonValid && v.hashMatches && v.claimsPayment && v.txExists &&
        v.paymentVerified && v.paymentAttributed,
    ).length,
    partyMismatch: verdicts.filter(
      (v) =>
        v.fetched && v.jsonValid && v.hashMatches && v.claimsPayment && v.txExists &&
        v.paymentVerified && v.partiesContradicted,
    ).length,
    foreignChain: verdicts.filter((v) => v.claimsPayment && !v.onQueryableChain).length,
    // Counted apart from `fetched` on purpose: these are the records the audit
    // failed to reach, not the records it found dead. Reporting them inside the
    // dead-link figure is how a transport problem becomes a published finding.
    inconclusive: verdicts.filter((v) => v.inconclusive).length,
    contentAddressed: verdicts.filter((v) => v.contentId !== null).length,
    archivedThisRun: 0,
    corpusSize: 0,
    corpusRecorded: 0,
    inconclusiveTopHosts: [] as { host: string; records: number; share: number }[],
    inconclusiveHosts: 0,
    sampled,
  }
}

/**
 * The rung a record's evidence reached, named identically to the on-chain
 * Verdict enum so the audit and the attestation ledger cannot drift apart.
 *
 * Six distinctions this ladder owes to its own counter-analysis:
 * a soft-404 (HTML served with HTTP 200) is a DEAD file, not a mismatched one;
 * a live file with a zero attested hash is UNBOUND, not mismatched — there was
 * never anything to contradict; a mismatch only means something when a real
 * hash was attested and real JSON came back; a settlement whose parties are the
 * reviewer and the agent is a strictly stronger fact than one that merely
 * exists; a payment declared on a chain we never queried is not a payment we
 * found missing; and a retrieval that was rate-limited or timed out is not a
 * dead link, it is a question we failed to ask.
 *
 * The last three add rungs rather than redefining old ones. Enum values are
 * append-only — 20,097 verdicts are already published under the first nine, and
 * silently changing what one of them means would corrupt every indexer reading
 * them.
 */
export function rung(
  rec: { hasURI: boolean; hasHash: boolean },
  v: {
    fetched: boolean
    jsonValid: boolean
    hashMatches: boolean
    claimsPayment: boolean
    txExists: boolean
    paymentVerified: boolean
    paymentAttributed?: boolean
    partiesContradicted?: boolean
    onQueryableChain?: boolean
    inconclusive?: boolean
    note?: string
  },
): string {
  // Payment rungs, strongest first.
  if (v.paymentVerified && v.paymentAttributed) return 'PaymentAttributed'
  if (v.paymentVerified && v.partiesContradicted) return 'PaymentPartyMismatch'
  if (v.paymentVerified) return 'PaymentVerified'
  if (v.claimsPayment && v.onQueryableChain === false) return 'PaymentForeignChain'
  if (v.claimsPayment && !v.txExists) return 'PaymentTxNotFound'
  if (v.claimsPayment && v.txExists) {
    const note = (v.note ?? '').toLowerCase()
    return note.includes('zero') || note.includes('no stablecoin') ? 'PaymentNoValue' : 'PaymentTxFailed'
  }
  // Documentary rungs.
  if (v.fetched && v.jsonValid) {
    if (!rec.hasHash) return 'EvidenceUnbound'
    return v.hashMatches ? 'EvidenceIntact' : 'EvidenceUnhashed'
  }
  // An unanswered question outranks a wrong answer: this record is not a
  // finding, and must never be counted as a dead link.
  if (v.inconclusive) return 'EvidenceInconclusive'
  if (rec.hasURI) return 'EvidenceUnreachable'
  return 'EvidenceAbsent'
}

/**
 * The documentary dimension, recorded independently of the payment one.
 *
 * A single verdict slot cannot carry both: the payment rungs outrank every
 * documentary rung, so for every record that declares a payment the state of
 * their file was measured and then thrown away. Reporting the two side by side
 * is what lets a consumer ask "settled AND intact" instead of guessing which
 * question the one verdict answered.
 */
export function evidenceRung(
  rec: { hasURI: boolean; hasHash: boolean },
  v: { fetched: boolean; jsonValid: boolean; hashMatches: boolean; inconclusive?: boolean },
): string {
  if (v.fetched && v.jsonValid) {
    if (!rec.hasHash) return 'Unbound'
    return v.hashMatches ? 'Intact' : 'Unhashed'
  }
  if (v.inconclusive) return 'Inconclusive'
  if (rec.hasURI) return 'Unreachable'
  return 'Absent'
}

/** Every rung name, in on-chain enum order. Index === the contract's value. */
export const RUNG_ORDER = [
  'None',
  'PaymentVerified',
  'EvidenceIntact',
  'EvidenceUnbound',
  'EvidenceUnhashed',
  'PaymentTxNotFound',
  'PaymentTxFailed',
  'PaymentNoValue',
  'EvidenceUnreachable',
  'EvidenceAbsent',
  'PaymentAttributed',
  'PaymentPartyMismatch',
  'PaymentForeignChain',
  'EvidenceInconclusive',
] as const

/** Evidence-dimension names, in on-chain enum order. */
export const EVIDENCE_ORDER = [
  'Unknown',
  'Intact',
  'Unbound',
  'Unhashed',
  'Unreachable',
  'Inconclusive',
  'Absent',
] as const
