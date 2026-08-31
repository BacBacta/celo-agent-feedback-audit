import type { Address } from 'viem'
import type { FeedbackRecord } from '../sources/feedback.js'
import type { Settlement } from '../sources/settlements.js'
import type { AgentOwnership } from '../sources/identity.js'

export interface ReconciledFeedback {
  record: FeedbackRecord
  /** A settlement from the reviewer to the agent's owner, dated before the review. */
  backingSettlement: Settlement | null
  /** The reviewer paid this agent, but only after leaving the review. */
  paidAfterReview: boolean
  /**
   * The reviewer is the agent's owner *as the Identity Registry holds it now*.
   *
   * Not "owns, or has owned": the comparison is against the current holder, so
   * an agent minted by its reviewer and transferred away before the audit ran
   * reads false here. Under the historical reading the figure is not 0, and the
   * old wording promised that reading while the code never computed it.
   */
  selfDealing: boolean
  /** The reviewer holds a Self Agent ID. */
  humanBacked: boolean
  /**
   * The registry has no owner recorded for the agent this review is about.
   *
   * Attribution is impossible for these — there is no counterparty to match a
   * settlement against — so counting them is what separates "we looked and
   * found nothing" from "we could not look".
   */
  unresolvedAgent: boolean
}

/**
 * The core of the audit, and the reason it is worth building.
 *
 * ERC-8004 lets a feedback record *declare* a payment via the optional
 * `proofOfPayment` field, but nothing checks it and — as this audit shows —
 * almost nobody fills it in. So rather than trusting the declaration, we
 * reconstruct the relationship from chain state: did this reviewer actually pay
 * this agent, in a stablecoin, before saying it was good?
 *
 * That question can be answered for every feedback record ever written,
 * including the ones that declared nothing. Ordering matters: a payment that
 * lands *after* the review cannot have motivated it, and the reverse pattern
 * (review first, pay later) is what a reciprocal-rating ring looks like, so the
 * two are counted separately rather than merged.
 */
export function reconcile(params: {
  feedback: FeedbackRecord[]
  settlements: Settlement[]
  identity: AgentOwnership
  selfVerified: Set<string>
  /** Payments this far after the review are treated as unrelated. */
  graceSeconds?: number
}): ReconciledFeedback[] {
  const { feedback, settlements, identity, selfVerified } = params

  // Index settlements by payer→payee so each lookup is O(1) rather than a scan.
  const byPair = new Map<string, Settlement[]>()
  for (const s of settlements) {
    const key = `${s.payer}->${s.payee}`
    const list = byPair.get(key)
    if (list) list.push(s)
    else byPair.set(key, [s])
  }
  for (const list of byPair.values()) list.sort((a, b) => a.timestamp - b.timestamp)

  return feedback.map((record): ReconciledFeedback => {
    const reviewer = record.reviewer.toLowerCase() as Address
    const owner = identity.owners.get(String(record.agentId))?.toLowerCase()

    if (!owner) {
      return {
        record,
        backingSettlement: null,
        paidAfterReview: false,
        selfDealing: false,
        humanBacked: selfVerified.has(reviewer),
        // No owner in the registry: attribution is not possible here, which is
        // a different statement from "attribution was attempted and failed".
        unresolvedAgent: true,
      }
    }

    const candidates = byPair.get(`${reviewer}->${owner}`) ?? []
    const before = candidates.filter((s) => s.timestamp <= record.timestamp)
    const after = candidates.filter((s) => s.timestamp > record.timestamp)

    return {
      record,
      // The most recent payment before the review is the one most plausibly
      // being reviewed.
      backingSettlement: before.length > 0 ? before[before.length - 1]! : null,
      paidAfterReview: before.length === 0 && after.length > 0,
      selfDealing: reviewer === owner,
      humanBacked: selfVerified.has(reviewer),
      unresolvedAgent: false,
    }
  })
}

export interface ReconciliationStats {
  total: number
  backed: number
  backedRate: number
  paidAfterReview: number
  /** Reviewer === the agent's *current* registered owner. See ReconciledFeedback. */
  selfDealing: number
  humanBacked: number
  humanBackedRate: number
  backedAndHumanBacked: number
  /** Feedback whose agent could not be resolved to an owner. */
  unresolvedAgent: number
  /**
   * How concentrated the payment-backed figure is.
   *
   * "One review in five is backed by a real payment" is exact and, on its own,
   * misleading: a single reviewer-to-owner relationship accounts for more than
   * half of them. Published without this, the headline suggests a broad market
   * where the measurement shows a handful of operators and a long tail — the
   * kind of true-but-misleading number this audit exists to object to.
   */
  backingTopPairs: { reviewer: string; owner: string; records: number; share: number }[]
  /** Distinct (reviewer, owner) relationships behind the backed records. */
  backingPairs: number
  /**
   * How concentrated the Self-ID-holder figure is, for the same reason.
   *
   * "One review in eight was written by a verified human" reads as a broad
   * base of verified reviewers. The JSON already published that the whole
   * figure comes from a single-digit number of addresses; the Markdown did
   * not, so the only place a reader would meet the number was the place that
   * withheld what it rests on.
   */
  humanBackedTop: { reviewer: string; records: number; share: number }[]
  /** Distinct Self-ID-holding addresses behind the human-backed records. */
  humanBackedReviewers: number
}

/**
 * Which relationships the payment-backed count actually rests on.
 *
 * Counted over records, not transfers: the question a reader has is how much of
 * the headline one relationship carries, and a pair that paid once and reviewed
 * four hundred times carries four hundred records.
 */
function backingConcentration(rows: ReconciledFeedback[]): {
  backingTopPairs: { reviewer: string; owner: string; records: number; share: number }[]
  backingPairs: number
} {
  const perPair = new Map<string, number>()
  for (const r of rows) {
    const s = r.backingSettlement
    if (!s) continue
    const key = `${s.payer}|${s.payee}`
    perPair.set(key, (perPair.get(key) ?? 0) + 1)
  }
  const backed = [...perPair.values()].reduce((a, b) => a + b, 0) || 1
  const top = [...perPair.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, records]) => {
      const [reviewer, owner] = key.split('|') as [string, string]
      return { reviewer, owner, records, share: records / backed }
    })
  return { backingTopPairs: top, backingPairs: perPair.size }
}

/** The same concentration question, asked of the Self-ID-holder count. */
function humanBackedConcentration(rows: ReconciledFeedback[]): {
  humanBackedTop: { reviewer: string; records: number; share: number }[]
  humanBackedReviewers: number
} {
  const per = new Map<string, number>()
  for (const r of rows) {
    if (!r.humanBacked) continue
    const k = r.record.reviewer.toLowerCase()
    per.set(k, (per.get(k) ?? 0) + 1)
  }
  const total = [...per.values()].reduce((a, b) => a + b, 0) || 1
  const top = [...per.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reviewer, records]) => ({ reviewer, records, share: records / total }))
  return { humanBackedTop: top, humanBackedReviewers: per.size }
}

export function summarize(rows: ReconciledFeedback[]): ReconciliationStats {
  const total = rows.length || 1
  const backed = rows.filter((r) => r.backingSettlement !== null).length
  const humanBacked = rows.filter((r) => r.humanBacked).length
  return {
    total: rows.length,
    backed,
    backedRate: backed / total,
    paidAfterReview: rows.filter((r) => r.paidAfterReview).length,
    selfDealing: rows.filter((r) => r.selfDealing).length,
    humanBacked,
    humanBackedRate: humanBacked / total,
    backedAndHumanBacked: rows.filter((r) => r.backingSettlement !== null && r.humanBacked).length,
    /**
     * Documented as "feedback whose agent could not be resolved to an owner"
     * and computed as "no backing settlement found and not paid afterwards" —
     * a different question with a wildly different answer. It published 27,520
     * (100%) where the true figure is 4 (0.0%), turning a near-complete
     * ownership index into a headline about a broken one.
     */
    unresolvedAgent: rows.filter((r) => r.unresolvedAgent).length,
    ...backingConcentration(rows),
    ...humanBackedConcentration(rows),
  }
}
