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
    fetched: number
    hashMatched: number
    claimsPayment: number
    txExists: number
    paymentVerified: number
    paymentAttributed: number
    partyMismatch: number
    foreignChain: number
    inconclusive: number
    archivedFiles: number
    /**
     * Files this run actually wrote to disk.
     *
     * `archivedFiles` counts verdicts carrying a content identifier, which a
     * warm resume cache fills without fetching anything — so the sentence
     * "N retrieved files were archived… every verdict stays checkable"
     * described a corpus that could be empty, and on the last run was: 619
     * claimed, 0 files on disk.
     */
    archivedThisRun: number
    sampled: number
    sampleStride: number
  }
  reconciliation: ReconciliationStats
  concentration: ConcentrationStats
  bursts: Burst[]
  settlementsSeen: number
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

const pct = (n: number, d: number) => (d === 0 ? '0.0%' : `${((n / d) * 100).toFixed(1)}%`)
const num = (n: number) => n.toLocaleString('en-US')

export function renderMarkdown(r: AuditResult): string {
  const t = r.totalFeedback
  const burstEvents = r.bursts.reduce((s, b) => s + b.count, 0)
  const burstOneShot = r.bursts.reduce((s, b) => s + b.oneShotReviewers, 0)

  return `# Celo Agent Feedback Audit

**Scope.** ERC-8004 Reputation Registry on Celo mainnet, blocks ${r.fromBlock}–${r.toBlock} (${r.fromDate} → ${r.toDate}).

## Headline

| Measure | Value |
|---|---|
| Feedback records written | **${num(t)}** |
| …declaring an evidence file | **${num(r.evidence.declaresURI)} (${pct(r.evidence.declaresURI, t)})** |
| …carrying only an attested hash, no file | ${num(r.evidence.hashWithoutURI)} (${pct(r.evidence.hashWithoutURI, t)}) |
| …claiming a specific payment transaction | ${num(r.evidence.claimsPayment)} (${pct(r.evidence.claimsPayment, t)}) |
| …whose claimed transaction exists on chain | ${num(r.evidence.txExists)} (${pct(r.evidence.txExists, t)}) |
| …whose payment actually verifies | **${num(r.evidence.paymentVerified)} (${pct(r.evidence.paymentVerified, t)})** |
| …whose payment is also *attributable* to this reviewer and agent | **${num(r.evidence.paymentAttributed)} (${pct(r.evidence.paymentAttributed, t)})** |
| …where the reviewer demonstrably paid the agent | **${num(r.reconciliation.backed)} (${pct(r.reconciliation.backed, t)})** |
| …written by a Self Agent ID holder | **${num(r.reconciliation.humanBacked)} (${pct(r.reconciliation.humanBacked, t)})** |
| Stablecoin settlements observed between these parties | ${num(r.settlementsSeen)} |

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
    ? `> **Sampled, not complete.** ${num(r.evidence.sampled)} of ${num(r.evidence.declaresURI)} records that declare a file were opened — every ${r.evidence.sampleStride}th, evenly spread across the period rather than taken from one end. Every row below from "of which the file actually resolved" downwards is a count **within that sample**, while the percentages are of all feedback: read them as lower bounds. The ${num(r.evidence.declaresURI - r.evidence.sampled)} records that were not opened are exported with the rung \`NotChecked\` and nothing is attested for them.\n\n`
    : ''
}| Step | Records | Share of all feedback |
|---|---|---|
| Declares a \`feedbackURI\` | ${num(r.evidence.declaresURI)} | ${pct(r.evidence.declaresURI, t)} |
| …of which the file actually resolved | ${num(r.evidence.fetched)} | ${pct(r.evidence.fetched, t)} |
| Declares a non-zero \`feedbackHash\` | ${num(r.evidence.declaresHash)} | ${pct(r.evidence.declaresHash, t)} |
| Hash attested but no file published | ${num(r.evidence.hashWithoutURI)} | ${pct(r.evidence.hashWithoutURI, t)} |
| File retrievable | ${num(r.evidence.fetched)} | ${pct(r.evidence.fetched, t)} |
| File matches the attested hash | ${num(r.evidence.hashMatched)} | ${pct(r.evidence.hashMatched, t)} |
| Contains a payment claim | ${num(r.evidence.claimsPayment)} | ${pct(r.evidence.claimsPayment, t)} |
| Claimed transaction exists on chain | ${num(r.evidence.txExists)} | ${pct(r.evidence.txExists, t)} |
| Payment verified — exists, succeeded, moved value | **${num(r.evidence.paymentVerified)}** | **${pct(r.evidence.paymentVerified, t)}** |
| Payment attributed — …and paid by this reviewer to this agent | **${num(r.evidence.paymentAttributed)}** | **${pct(r.evidence.paymentAttributed, t)}** |
| Payment cited but its parties contradict the claim | ${num(r.evidence.partyMismatch)} | ${pct(r.evidence.partyMismatch, t)} |
| Payment declared on a chain this audit does not query | ${num(r.evidence.foreignChain)} | ${pct(r.evidence.foreignChain, t)} |

> **Not a finding:** ${num(r.evidence.inconclusive)} records could not be retrieved for
> reasons that prove nothing — rate limits, timeouts, gateway outages. They are
> excluded from the dead-link count above rather than folded into it. A file
> this audit failed to reach is a question it failed to ask, not an answer.
> ${num(r.evidence.archivedFiles)} verdicts carry a content identifier, and ${num(r.evidence.archivedThisRun)} file(s) were written by THIS run under
> \`out/evidence-corpus/\`, so every verdict above stays checkable after the
> originals go offline.

## Payment backing, reconstructed${r.settlementsRan === false ? ' — not run' : ''}

${r.settlementsRan === false ? '> The settlement sweep did not run for this window, so every figure in this section reads zero. It is not a finding. The headline above — whether a declared payment exists on chain — is verified per transaction hash and does not depend on it.\n' : ''}${r.settlementsRan === true && r.settlementsSeen === 0 ? '> The settlement sweep ran and found no transfers between these parties. That is a measurement, not an absence of one.\n' : ''}
Independently of what a record declares, did this reviewer actually pay this
agent's owner, in a stablecoin, before rating it?

| | Records | Share |
|---|---|---|
| Paid the agent before reviewing it | **${num(r.reconciliation.backed)}** | **${pct(r.reconciliation.backed, t)}** |
| Paid only *after* reviewing | ${num(r.reconciliation.paidAfterReview)} | ${pct(r.reconciliation.paidAfterReview, t)} |
| No payment relationship found | ${num(t - r.reconciliation.backed - r.reconciliation.paidAfterReview)} | ${pct(t - r.reconciliation.backed - r.reconciliation.paidAfterReview, t)} |
| Reviewer owns the agent it reviewed | ${num(r.reconciliation.selfDealing)} | ${pct(r.reconciliation.selfDealing, t)} |
| Paid **and** human-backed | ${num(r.reconciliation.backedAndHumanBacked)} | ${pct(r.reconciliation.backedAndHumanBacked, t)} |

## Concentration

Same measures as the arXiv ERC-8004 study (2606.26028, June 2026), which covered
Ethereum, BSC and Base but not Celo — so these numbers are directly comparable
to the published ones.

- Gini over reviews per reviewer: **${r.concentration.gini.toFixed(3)}**
- Top 10 reviewers wrote: **${(r.concentration.topTenShare * 100).toFixed(1)}%** of all feedback
- Reviewers who reviewed exactly once: **${(r.concentration.oneShotReviewerRate * 100).toFixed(1)}%**
- Most feedback from a single address: **${num(r.concentration.maxBySingleReviewer)}**

## Temporal clustering

${r.bursts.length} clusters of ≥5 reviews within a 5-minute window, totalling
**${num(burstEvents)} records (${pct(burstEvents, t)} of all feedback)** and
${num(burstOneShot)} reviewers that never reviewed anything again.

A genuinely busy hour looks like this too. These are reported for inspection,
not labelled fraudulent.

## Method and limits

- Every figure is reproducible: \`npm run audit\` against any Celo RPC.
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
    fetched: verdicts.filter((v) => v.fetched).length,
    hashMatched: verdicts.filter((v) => v.hashMatches).length,
    claimsPayment: verdicts.filter((v) => v.claimsPayment).length,
    txExists: verdicts.filter((v) => v.txExists).length,
    paymentVerified: verdicts.filter((v) => v.paymentVerified).length,
    paymentAttributed: verdicts.filter((v) => v.paymentAttributed).length,
    partyMismatch: verdicts.filter((v) => v.partiesContradicted).length,
    foreignChain: verdicts.filter((v) => v.claimsPayment && !v.onQueryableChain).length,
    // Counted apart from `fetched` on purpose: these are the records the audit
    // failed to reach, not the records it found dead. Reporting them inside the
    // dead-link figure is how a transport problem becomes a published finding.
    inconclusive: verdicts.filter((v) => v.inconclusive).length,
    archivedFiles: verdicts.filter((v) => v.contentId !== null).length,
    archivedThisRun: 0,
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
 * documentary rung, so for the 93 records that declare a payment the state of
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
