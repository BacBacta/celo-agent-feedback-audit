import type { Address, Hex } from 'viem'
import { client, throughRateLimit } from '../rpc.js'
import { SETTLEMENT_TOKENS, ERC20_TRANSFER_EVENT, QUERYABLE_CHAIN_IDS } from '../config.js'
import { decodeEventLog } from 'viem'

/** One settlement-token movement inside the transaction a review names. */
export interface TokenTransfer {
  token: Address
  symbol: string
  decimals: number
  from: Address
  to: Address
  value: bigint
}

export interface PaymentCheck {
  /** The declared hash resolves to a transaction that exists on this chain. */
  exists: boolean
  /** It executed successfully. */
  succeeded: boolean
  /** It moved one of the settlement stablecoins. */
  movedValue: boolean
  amount: bigint | null
  symbol: string | null
  decimals: number | null
  token: Address | null
  from: Address | null
  to: Address | null
  /**
   * Every settlement-token transfer in the transaction, not just the one that
   * was picked. A payment routed through a contract moves several legs, and
   * reporting one of them as "the payment" without saying how many there were
   * hides the ambiguity instead of measuring it.
   */
  transfers: TokenTransfer[]
  /** The declared network is one this audit can actually query. */
  onQueryableChain: boolean
  reason?: string
}

const NOT_FOUND: PaymentCheck = {
  exists: false,
  succeeded: false,
  movedValue: false,
  amount: null,
  symbol: null,
  decimals: null,
  token: null,
  from: null,
  to: null,
  transfers: [],
  onQueryableChain: true,
  reason: 'transaction not found on chain',
}

const cache = new Map<string, PaymentCheck>()

/**
 * Is the network a file declares one we are in a position to check?
 *
 * `claimNetwork` was extracted from day one and never consulted: every declared
 * transaction was looked up on Celo regardless. A payment settled on Base is
 * then reported as "not found", which is a claim about Base that this audit
 * never tested. Records naming another chain are now counted apart, so the
 * headline number stops absorbing them.
 */
export function isQueryableNetwork(network: string | null): boolean {
  if (network == null || network === '') return true // undeclared: assume the chain we audit
  return QUERYABLE_CHAIN_IDS.has(String(network).trim().toLowerCase())
}

/**
 * Verify a payment a feedback record claims happened.
 *
 * This is the step the whole audit turns on, and it cannot be shortcut by
 * matching against settlements indexed elsewhere: a platform may pay from an
 * address other than the one that writes the rating, so "not in my index" and
 * "does not exist" are different findings and must not be conflated. The only
 * honest check is to ask the chain for the transaction by hash.
 */
export async function verifyPaymentTx(
  txHash: string,
  network: string | null = null,
): Promise<PaymentCheck> {
  if (!isQueryableNetwork(network)) {
    return {
      ...NOT_FOUND,
      onQueryableChain: false,
      reason: `declared on network "${network}", which this audit does not query`,
    }
  }

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
  const transfers: TokenTransfer[] = []

  for (const log of receipt.logs) {
    const token = tokens.get(log.address.toLowerCase())
    if (!token) continue
    try {
      const decoded = decodeEventLog({ abi: [ERC20_TRANSFER_EVENT], data: log.data, topics: log.topics })
      const a = decoded.args as unknown as { from: Address; to: Address; value: bigint }
      transfers.push({
        token: token.address,
        symbol: token.symbol,
        decimals: token.decimals,
        from: a.from.toLowerCase() as Address,
        to: a.to.toLowerCase() as Address,
        value: a.value,
      })
    } catch {
      /* not a Transfer log */
    }
  }

  const succeeded = receipt.status === 'success'
  // Largest leg, not first leg. In a routed payment the first Transfer is often
  // a fee or an intermediate hop, and calling that "the payment" understates
  // the amount and names the wrong parties.
  const principal = transfers.reduce<TokenTransfer | null>(
    (best, t) => (best === null || t.value > best.value ? t : best),
    null,
  )

  const found: PaymentCheck = {
    exists: true,
    succeeded,
    movedValue: principal !== null && principal.value > 0n,
    amount: principal?.value ?? null,
    symbol: principal?.symbol ?? null,
    decimals: principal?.decimals ?? null,
    token: principal?.token ?? null,
    from: principal?.from ?? null,
    to: principal?.to ?? null,
    transfers,
    onQueryableChain: true,
    reason:
      principal === null
        ? 'no stablecoin transfer in transaction'
        : principal.value > 0n
          ? undefined
          : 'transfer of zero',
  }

  cache.set(key, found)
  return found
}

/**
 * Does the settlement actually belong to this review?
 *
 * `paymentVerified` only ever asked whether the named transaction exists,
 * succeeded and moved value — never whether it had anything to do with the
 * reviewer or the agent being rated. Under that rule the strongest verdict in
 * the system is also the cheapest to usurp: cite any real stablecoin transfer
 * on the chain and collect it. The parties were already being read out of both
 * the receipt and the file; they were simply never compared.
 *
 * Attribution needs both ends to hold. A payer who is not the reviewer proves
 * nothing about the reviewer, and a payee who is not the agent proves nothing
 * about the agent — so `attributed` requires each side to be positively
 * confirmed, and unknown ownership yields "unattributed", never "attributed".
 */
export interface PartyMatch {
  /** The transfer's payer is the address that wrote the review. */
  payerIsReviewer: boolean
  /** The transfer's payee is the agent's registered owner. */
  payeeIsAgentOwner: boolean
  /** The file's own declared parties agree with the transfer it names. */
  declarationHonest: boolean | null
  /** Both ends tie this settlement to this review. */
  attributed: boolean
  /** Some end provably belongs to somebody else. */
  contradicted: boolean
  note: string
}

const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase()

export function matchParties(params: {
  check: PaymentCheck
  reviewer: string
  agentOwner: string | null
  declaredFrom: string | null
  declaredTo: string | null
}): PartyMatch {
  const { check, reviewer, agentOwner, declaredFrom, declaredTo } = params

  const none: PartyMatch = {
    payerIsReviewer: false,
    payeeIsAgentOwner: false,
    declarationHonest: null,
    attributed: false,
    contradicted: false,
    note: 'no settlement transfer to attribute',
  }
  if (!check.exists || !check.succeeded || !check.movedValue) return none

  /**
   * A reviewer rating an agent it owns is not a customer, and money it sends
   * itself is not a payment. Both ends match trivially in that case, so the
   * strongest rung in the system would be available to anyone willing to spend
   * gas transferring a stablecoin from one of their addresses to another. Self
   * dealing is measured elsewhere in this audit and is never attribution.
   */
  if (agentOwner && same(reviewer, agentOwner)) {
    return {
      ...none,
      note: 'reviewer owns the agent it reviewed: a self-payment is not attribution',
    }
  }

  // Any leg may carry the attribution: a routed payment can settle the agent
  // through an intermediary while the principal leg names the router. A leg
  // that pays its own sender moves no value between parties, so it cannot
  // carry attribution either.
  const legs = check.transfers.filter((t) => t.value > 0n && !same(t.from, t.to))
  const direct = legs.find((t) => same(t.from, reviewer) && (!agentOwner || same(t.to, agentOwner)))
  const payerIsReviewer = legs.some((t) => same(t.from, reviewer))
  const payeeIsAgentOwner = agentOwner ? legs.some((t) => same(t.to, agentOwner)) : false

  const declarationHonest =
    declaredFrom || declaredTo
      ? legs.some((t) => (!declaredFrom || same(t.from, declaredFrom)) && (!declaredTo || same(t.to, declaredTo)))
      : null

  const attributed = payerIsReviewer && payeeIsAgentOwner

  /**
   * "Contradicted" is deliberately narrow, and narrower than the first draft of
   * this function. A payer who is not the reviewer is NOT a contradiction: a
   * platform routinely settles from its own treasury on behalf of the user who
   * then rates the agent, and calling that fraud would convict the honest
   * majority. Only two patterns are provable:
   *
   *   - the file names a payer or payee that the transfer it cites does not
   *     contain, which is the publisher contradicting their own document; or
   *   - we know who the agent's owner is, and the settlement touches neither
   *     the reviewer nor that owner at any leg — the signature of a review
   *     pointed at somebody else's transaction.
   *
   * Not knowing the agent's owner is ignorance, and stays unattributed.
   */
  const strangersOnly = agentOwner !== null && !payerIsReviewer && !payeeIsAgentOwner && legs.length > 0
  const contradicted = declarationHonest === false || strangersOnly

  const parts: string[] = []
  parts.push(payerIsReviewer ? 'payer is the reviewer' : 'payer is not the reviewer')
  parts.push(
    agentOwner === null
      ? 'agent owner unknown'
      : payeeIsAgentOwner
        ? 'payee is the agent owner'
        : 'payee is not the agent owner',
  )
  if (declarationHonest === false) parts.push('file declares parties the transfer contradicts')
  if (strangersOnly) parts.push('settlement touches neither the reviewer nor the agent owner')
  // Worth recording: attribution held across two legs rather than one transfer,
  // so the money reached the agent by a route rather than directly.
  if (attributed && !direct) parts.push('attributed across separate legs, not one direct transfer')

  return { payerIsReviewer, payeeIsAgentOwner, declarationHonest, attributed, contradicted, note: parts.join('; ') }
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
export function extractPaymentClaim(parsed: unknown): {
  txHash: string | null
  network: string | null
  declaredFrom: string | null
  declaredTo: string | null
  shape: string | null
} {
  const EMPTY = { txHash: null, network: null, declaredFrom: null, declaredTo: null, shape: null }
  // `JSON.parse` succeeds on `null`, `7` and `"text"` as readily as on an
  // object. Reading a property off the first of those throws, and the throw is
  // outside any handler, so one four-byte file used to end the entire run.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY

  const doc = parsed as Record<string, any>
  const proof = doc.proofOfPayment ?? doc.proof_of_payment ?? null
  const txns = doc.transactions ?? null
  const obj = (v: unknown) => (v !== null && typeof v === 'object' ? (v as Record<string, any>) : null)
  const p = obj(proof)
  const t = obj(txns)

  const txHash =
    p?.txHash ?? p?.payment_tx ?? p?.paymentTx ?? p?.tx_hash ??
    t?.payment_tx ?? t?.paymentTx ?? null

  const shape = p?.txHash
    ? 'erc8004'
    : p?.payment_tx || p?.paymentTx
      ? 'proof_of_payment.payment_tx'
      : t?.payment_tx || t?.paymentTx
        ? 'transactions.payment_tx'
        : null

  const str = (v: unknown) => {
    if (v == null) return null
    const out = String(v).trim()
    return out === '' ? null : out
  }

  return {
    // An empty string is not a claim. Coercing it to `''` would make every
    // file carrying a blank `payment_tx` field look like it declared a payment,
    // and each of them would then be reported as a transaction that does not
    // exist — a finding manufactured out of an empty field.
    txHash: txHash ? String(txHash) : null,
    network: p?.chainId != null ? str(p.chainId) : str(p?.network ?? doc.network ?? null),
    declaredFrom: str(p?.fromAddress ?? p?.from_address ?? null),
    declaredTo: str(p?.toAddress ?? p?.to_address ?? obj(doc.rating)?.target_address ?? null),
    shape,
  }
}
