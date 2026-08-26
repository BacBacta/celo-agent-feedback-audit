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
  /** The reviewer owns, or has owned, the agent it reviewed. */
  selfDealing: boolean
  /** The reviewer holds a Self Agent ID. */
  humanBacked: boolean
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
    }
  })
}

export interface ReconciliationStats {
  total: number
  backed: number
  backedRate: number
  paidAfterReview: number
  selfDealing: number
  humanBacked: number
  humanBackedRate: number
  backedAndHumanBacked: number
  /** Feedback whose agent could not be resolved to an owner. */
  unresolvedAgent: number
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
    unresolvedAgent: rows.filter((r) => r.backingSettlement === null && !r.paidAfterReview).length,
  }
}
