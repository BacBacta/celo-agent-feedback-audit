import { keccak256, type Hex } from 'viem'
import { createHash } from 'node:crypto'
import type { FeedbackRecord } from '../sources/feedback.js'
import { extractPaymentClaim, verifyPaymentTx, matchParties, isQueryableNetwork } from './payment.js'
import { fetchEvidence } from '../net/fetch-evidence.js'
import type { EvidenceArchive } from '../archive.js'
import { EVIDENCE_TIMEOUT_MS } from '../config.js'

export interface EvidenceVerdict {
  /** The record points at an evidence file. */
  hasPointer: boolean
  /** The file was retrievable. */
  fetched: boolean
  /** The retrieved content parsed as a JSON object — an HTML soft-404 fails this. */
  jsonValid: boolean
  /** keccak256(file bytes) matched the on-chain feedbackHash — this is the attested file. */
  hashMatches: boolean
  /**
   * Retrieval failed in a way that proves nothing: a rate limit, a timeout, a
   * gateway outage. Distinct from a host answering 404. Half of this audit's
   * verdicts were negatives of this kind, published as if they were findings.
   */
  inconclusive: boolean
  /** The file contains a payment claim, in any of the shapes seen in the wild. */
  claimsPayment: boolean
  /** Which key shape the claim used, for reporting. */
  shape: string | null
  /** The claimed transaction exists on the chain the file names. */
  txExists: boolean
  /** It exists, succeeded, and moved a non-zero stablecoin amount. */
  paymentVerified: boolean
  /** …and its parties are this reviewer and this agent's owner. */
  paymentAttributed: boolean
  /** …or its parties provably belong to somebody else. */
  partiesContradicted: boolean
  /** The declared network is one this audit can query at all. */
  onQueryableChain: boolean
  amount: bigint | null
  symbol: string | null
  decimals: number | null
  /**
   * Address of the token the amount is denominated in.
   *
   * Carried explicitly because an amount without its token cannot be compared
   * to a threshold, which is the only reason to publish one — and because the
   * attestation contract refuses the pair outright.
   */
  token: string | null
  claimTxHash: string | null
  claimNetwork: string | null
  declaredFrom: string | null
  declaredTo: string | null
  transferFrom: string | null
  transferTo: string | null
  transferCount: number
  /**
   * sha256 of the same bytes. A publisher whose file does not match its
   * keccak-256 digest may simply have hashed it another way; publishing the
   * alternative digest turns "does not match" into something they can act on.
   */
  sha256: string | null
  /** keccak256 of the retrieved bytes — the corpus key, present even on mismatch. */
  contentId: string | null
  bytes: number | null
  /** Unix seconds at which the check actually ran, as opposed to was written. */
  observedAt: number
  /** Host that served the bytes, when several gateways were tried. */
  via: string | null
  note?: string
  partyNote?: string
}

const EMPTY: EvidenceVerdict = {
  hasPointer: false,
  fetched: false,
  jsonValid: false,
  hashMatches: false,
  inconclusive: false,
  claimsPayment: false,
  shape: null,
  txExists: false,
  paymentVerified: false,
  paymentAttributed: false,
  partiesContradicted: false,
  onQueryableChain: true,
  amount: null,
  symbol: null,
  decimals: null,
  token: null,
  claimTxHash: null,
  claimNetwork: null,
  declaredFrom: null,
  declaredTo: null,
  transferFrom: null,
  transferTo: null,
  transferCount: 0,
  sha256: null,
  contentId: null,
  bytes: null,
  observedAt: 0,
  via: null,
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

/**
 * Follow a feedback record's evidence to the end, or to wherever it breaks.
 *
 * Five things must hold for a claim to mean anything: the file must be
 * retrievable, it must be the file that was attested, it must contain a payment
 * claim, that payment must exist on chain and have moved value, and the parties
 * to it must be the ones the review is about. Each is recorded separately,
 * because *where* the chain of evidence breaks is the finding — a well-formed
 * proof naming a transaction that was never mined is a different and more
 * interesting failure than no proof at all, and a real settlement between two
 * strangers is a different failure again.
 *
 * A sixth outcome is recorded and deliberately not treated as a finding: the
 * retrieval that told us nothing.
 */
export async function checkEvidence(
  record: FeedbackRecord,
  opts: {
    timeoutMs?: number
    /** Current owner of the rated agent, for attributing the settlement. */
    agentOwner?: string | null
    archive?: EvidenceArchive | null
  } = {},
): Promise<EvidenceVerdict> {
  const observedAt = nowSeconds()
  const base = { ...EMPTY, observedAt }
  if (!record.hasURI) return base

  const outcome = await fetchEvidence(record.feedbackURI, {
    timeoutMs: opts.timeoutMs ?? EVIDENCE_TIMEOUT_MS,
  })

  if (outcome.kind !== 'ok') {
    /**
     * Three outcomes, and only one of them is a failure to measure.
     *
     *  - `dead`     a host answered 404 or 410: it asserts the file is gone.
     *  - `unusable` the URI itself cannot be retrieved by anyone — an unknown
     *               scheme, a malformed URL, a target in private address space.
     *               Decided locally, with no network involved, so it is a fact
     *               about the record. Filing it as "inconclusive" would make a
     *               junk URI strictly safer to publish than an honest dead link.
     *  - anything else was never tested: rate limits, timeouts, gateway
     *    outages. Recording those as dead links is the misclassification this
     *    audit exists to expose, and it used to commit it 9,409 times.
     */
    const inconclusive = outcome.kind !== 'dead' && outcome.kind !== 'unusable'
    return {
      ...base,
      hasPointer: true,
      inconclusive,
      note: inconclusive ? `${outcome.note} (inconclusive)` : outcome.note,
    }
  }

  const { bytes, text, via } = outcome
  const contentId = keccak256(bytes)
  // Hash the BYTES, not a re-encoding of the decoded string: `toBytes(text)`
  // hex-decodes any body that happens to start with "0x", so those files were
  // compared against the digest of something they never were.
  const hashMatches = contentId === (record.feedbackHash as Hex)
  const sha256 = '0x' + createHash('sha256').update(bytes).digest('hex')
  const archived = opts.archive
    ? opts.archive.put(bytes, { uri: record.feedbackURI, url: outcome.url, observedAt })
    : null
  void archived

  const withBody = {
    ...base,
    hasPointer: true,
    fetched: true,
    hashMatches,
    sha256,
    contentId,
    bytes: bytes.byteLength,
    via,
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // A dead file behind a CDN often comes back as an HTML error page with
    // HTTP 200. That is not "evidence that fails its hash" — it is evidence
    // that is gone. jsonValid carries the distinction to the ladder.
    return { ...withBody, jsonValid: false, note: 'not JSON' }
  }
  // `JSON.parse` also succeeds on `null`, `7` and `"text"`. Treating those as
  // objects threw a TypeError outside every handler, so a four-byte file could
  // end the whole run.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...withBody, jsonValid: false, note: 'not a JSON object' }
  }

  const claim = extractPaymentClaim(parsed)
  if (!claim.txHash) {
    return { ...withBody, jsonValid: true, note: 'no payment claim' }
  }

  const claimed = {
    ...withBody,
    jsonValid: true,
    claimsPayment: true,
    shape: claim.shape,
    claimTxHash: claim.txHash,
    claimNetwork: claim.network,
    declaredFrom: claim.declaredFrom,
    declaredTo: claim.declaredTo,
    onQueryableChain: isQueryableNetwork(claim.network),
  }

  const check = await verifyPaymentTx(claim.txHash, claim.network)
  const parties = matchParties({
    check,
    reviewer: record.reviewer,
    agentOwner: opts.agentOwner ?? null,
    declaredFrom: claim.declaredFrom,
    declaredTo: claim.declaredTo,
  })

  const paymentVerified = check.exists && check.succeeded && check.movedValue
  const paymentAttributed = paymentVerified && parties.attributed

  /**
   * An attributed record publishes the attributed amount, not the transaction's
   * largest transfer. They are the same number for an ordinary payment and
   * wildly different for a crafted one, and it is the published figure that a
   * consumer applies its threshold to.
   */
  const amount = paymentAttributed ? parties.attributedAmount : check.amount
  const symbol = paymentAttributed ? parties.attributedSymbol : check.symbol
  const decimals = paymentAttributed ? parties.attributedDecimals : check.decimals
  const token = paymentAttributed ? parties.attributedToken : check.token

  return {
    ...claimed,
    txExists: check.exists,
    paymentVerified,
    paymentAttributed,
    partiesContradicted: paymentVerified && parties.contradicted,
    onQueryableChain: check.onQueryableChain,
    amount,
    symbol,
    decimals,
    token,
    transferFrom: check.from,
    transferTo: check.to,
    transferCount: check.transfers.length,
    note: check.reason,
    partyNote: parties.note,
  }
}
