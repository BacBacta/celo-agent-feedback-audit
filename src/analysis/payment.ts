import type { Address, Hex } from 'viem'
import { client, throughRateLimit } from '../rpc.js'
import { SETTLEMENT_TOKENS, ERC20_TRANSFER_EVENT } from '../config.js'
import { decodeEventLog } from 'viem'

export interface PaymentCheck {
  /** The declared hash resolves to a transaction that exists on this chain. */
  exists: boolean
  /** It executed successfully. */
  succeeded: boolean
  /** It moved one of the settlement stablecoins. */
  movedValue: boolean
  amount: bigint | null
  symbol: string | null
  from: Address | null
  to: Address | null
  reason?: string
}

const NOT_FOUND: PaymentCheck = {
  exists: false,
  succeeded: false,
  movedValue: false,
  amount: null,
  symbol: null,
  from: null,
  to: null,
  reason: 'transaction not found on chain',
}

const cache = new Map<string, PaymentCheck>()

/**
 * Verify a payment a feedback record claims happened.
 *
 * This is the step the whole audit turns on, and it cannot be shortcut by
 * matching against settlements indexed elsewhere: a platform may pay from an
 * address other than the one that writes the rating, so "not in my index" and
 * "does not exist" are different findings and must not be conflated. The only
 * honest check is to ask the chain for the transaction by hash.
 */
export async function verifyPaymentTx(txHash: string): Promise<PaymentCheck> {
  const key = txHash.toLowerCase()
  const hit = cache.get(key)
  if (hit) return hit

  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    const bad = { ...NOT_FOUND, reason: 'malformed transaction hash' }
    cache.set(key, bad)
    return bad
  }

  let receipt
  try {
    // A rate-limited lookup is retried at length rather than recorded: writing
    // "transaction not found" because Cloudflare said 429 would be exactly the
    // kind of silent misclassification this audit exists to expose.
    receipt = await throughRateLimit('receipts', () =>
      client.getTransactionReceipt({ hash: txHash as Hex }),
    )
  } catch (err) {
    if (/not.*found|could not be found/i.test((err as Error).message ?? '')) {
      cache.set(key, NOT_FOUND)
      return NOT_FOUND
    }
    throw err
  }
  if (!receipt) {
    cache.set(key, NOT_FOUND)
    return NOT_FOUND
  }

  const tokens = new Map(SETTLEMENT_TOKENS.map((t) => [t.address.toLowerCase(), t]))
  let found: PaymentCheck = {
    exists: true,
    succeeded: receipt.status === 'success',
    movedValue: false,
    amount: null,
    symbol: null,
    from: null,
    to: null,
    reason: 'no stablecoin transfer in transaction',
  }

  for (const log of receipt.logs) {
    const token = tokens.get(log.address.toLowerCase())
    if (!token) continue
    try {
      const decoded = decodeEventLog({ abi: [ERC20_TRANSFER_EVENT], data: log.data, topics: log.topics })
      const a = decoded.args as unknown as { from: Address; to: Address; value: bigint }
      found = {
        exists: true,
        succeeded: receipt.status === 'success',
        movedValue: a.value > 0n,
        amount: a.value,
        symbol: token.symbol,
        from: a.from.toLowerCase() as Address,
        to: a.to.toLowerCase() as Address,
        reason: a.value > 0n ? undefined : 'transfer of zero',
      }
      break
    } catch {
      /* not a Transfer log */
    }
  }

  cache.set(key, found)
  return found
}

/**
 * Pull a payment claim out of a feedback file.
 *
 * ERC-8004 specifies `proofOfPayment` with a `txHash`, but real files in the
 * wild use other shapes — snake_case keys, `payment_tx` instead of `txHash`,
 * the claim nested under `transactions`. Reading only the spec shape reports
 * "no proof" for files that plainly contain one, which is the wrong finding for
 * the wrong reason. So we accept the variants and record which shape was used.
 */
export function extractPaymentClaim(parsed: Record<string, any>): {
  txHash: string | null
  network: string | null
  declaredFrom: string | null
  declaredTo: string | null
  shape: string | null
} {
  const proof = parsed.proofOfPayment ?? parsed.proof_of_payment ?? null
  const txns = parsed.transactions ?? null

  const txHash =
    proof?.txHash ?? proof?.payment_tx ?? proof?.paymentTx ?? proof?.tx_hash ??
    txns?.payment_tx ?? txns?.paymentTx ?? null

  const shape = proof?.txHash
    ? 'erc8004'
    : proof?.payment_tx || proof?.paymentTx
      ? 'proof_of_payment.payment_tx'
      : txns?.payment_tx || txns?.paymentTx
        ? 'transactions.payment_tx'
        : null

  return {
    txHash: txHash ? String(txHash) : null,
    network: proof?.chainId != null ? String(proof.chainId) : (proof?.network ?? parsed.network ?? null),
    declaredFrom: proof?.fromAddress ?? proof?.from_address ?? null,
    declaredTo: proof?.toAddress ?? proof?.to_address ?? parsed?.rating?.target_address ?? null,
    shape,
  }
}
