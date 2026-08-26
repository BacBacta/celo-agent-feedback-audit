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
    sampled: number
    sampleStride: number
  }
  reconciliation: ReconciliationStats
  concentration: ConcentrationStats
  bursts: Burst[]
  settlementsSeen: number
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

| Step | Records | Share of all feedback |
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

${
  r.evidence.sampled < r.evidence.declaresURI
    ? `> Sampled ${num(r.evidence.sampled)} of ${num(r.evidence.declaresURI)} records that declare a file — every ${r.evidence.sampleStride}th, evenly spread across the period rather than taken from one end. The four rows below are counts within that sample; the percentages are of all feedback, so read them as a lower bound.\n`
    : ''
}
## Payment backing, reconstructed${r.settlementsSeen === 0 ? ' — not run' : ''}

${r.settlementsSeen === 0 ? '> The settlement sweep did not run for this window, so every figure in this section reads zero. It is not a finding. The headline above — whether a declared payment exists on chain — is verified per transaction hash and does not depend on it.\n' : ''}
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
    sampled,
  }
}
