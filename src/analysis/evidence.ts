import { keccak256, toBytes, type Hex } from 'viem'
import type { FeedbackRecord } from '../sources/feedback.js'
import { extractPaymentClaim, verifyPaymentTx } from './payment.js'

export interface EvidenceVerdict {
  /** The record points at an evidence file. */
  hasPointer: boolean
  /** The file was retrievable. */
  fetched: boolean
  /** keccak256(file) matched the on-chain feedbackHash — this is the attested file. */
  hashMatches: boolean
  /** The file contains a payment claim, in any of the shapes seen in the wild. */
  claimsPayment: boolean
  /** Which key shape the claim used, for reporting. */
  shape: string | null
  /** The claimed transaction exists on the chain the file names. */
  txExists: boolean
  /** It exists, succeeded, and moved a non-zero stablecoin amount. */
  paymentVerified: boolean
  amount: bigint | null
  symbol: string | null
  claimTxHash: string | null
  claimNetwork: string | null
  note?: string
}

const EMPTY: EvidenceVerdict = {
  hasPointer: false,
  fetched: false,
  hashMatches: false,
  claimsPayment: false,
  shape: null,
  txExists: false,
  paymentVerified: false,
  amount: null,
  symbol: null,
  claimTxHash: null,
  claimNetwork: null,
}

function resolveURI(uri: string): string | null {
  const u = uri.trim()
  if (!u) return null
  if (u.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${u.slice('ipfs://'.length)}`
  if (u.startsWith('http://') || u.startsWith('https://')) return u
  return null
}

/**
 * Follow a feedback record's evidence to the end, or to wherever it breaks.
 *
 * Four things must hold for a claim to mean anything: the file must be
 * retrievable, it must be the file that was attested, it must contain a payment
 * claim, and that payment must exist on chain and have moved value. Each is
 * recorded separately, because *where* the chain of evidence breaks is the
 * finding — a well-formed proof naming a transaction that was never mined is a
 * different and more interesting failure than no proof at all.
 */
export async function checkEvidence(
  record: FeedbackRecord,
  timeoutMs = 8000,
): Promise<EvidenceVerdict> {
  if (!record.hasURI) return { ...EMPTY }

  const url = resolveURI(record.feedbackURI)
  if (!url) return { ...EMPTY, hasPointer: true, note: 'unresolvable URI scheme' }

  let text: string
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(url, { signal: ctrl.signal })
    clearTimeout(timer)
    if (!res.ok) return { ...EMPTY, hasPointer: true, note: `HTTP ${res.status}` }
    text = await res.text()
  } catch {
    return { ...EMPTY, hasPointer: true, note: 'fetch failed' }
  }

  const hashMatches = keccak256(toBytes(text)) === (record.feedbackHash as Hex)

  let parsed: Record<string, any>
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ...EMPTY, hasPointer: true, fetched: true, hashMatches, note: 'not JSON' }
  }

  const claim = extractPaymentClaim(parsed)
  if (!claim.txHash) {
    return { ...EMPTY, hasPointer: true, fetched: true, hashMatches, note: 'no payment claim' }
  }

  const check = await verifyPaymentTx(claim.txHash)

  return {
    hasPointer: true,
    fetched: true,
    hashMatches,
    claimsPayment: true,
    shape: claim.shape,
    txExists: check.exists,
    paymentVerified: check.exists && check.succeeded && check.movedValue,
    amount: check.amount,
    symbol: check.symbol,
    claimTxHash: claim.txHash,
    claimNetwork: claim.network,
    note: check.reason,
  }
}
