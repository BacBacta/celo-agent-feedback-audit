import { createHash } from 'node:crypto'
import { parseAbiItem, type Address } from 'viem'

/**
 * All addresses verified live on Celo mainnet (chainId 42220) on 2026-08-25
 * via the Blockscout explorer. Each is linked in README.md so a reader can
 * re-check them independently.
 */
export const AUDIT_VERSION = '0.4.0'

export const CHAIN_ID = 42220

/** ERC-8004 canonical registries, deployed on Celo 2026-02-05. */
export const REPUTATION_REGISTRY = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63' as Address
export const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as Address

/** Self Protocol's human-backed agent identity registry. */
export const SELF_AGENT_REGISTRY = '0xaC3DF9ABf80d0F5c020C06B04Cced27763355944' as Address

/** Signer used by the Celo Core Co. x402 facilitator to submit settlements. */
export const X402_FACILITATOR = '0x0d74D5Cefd2e7F24E623330ebE3d8D4cB45fFB48' as Address

/**
 * Stablecoins that the facilitator settles in. All are EIP-3009 capable, which
 * is what makes gasless x402 settlement possible on Celo.
 */
export const SETTLEMENT_TOKENS: { address: Address; symbol: string; decimals: number }[] = [
  { address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', symbol: 'USDC', decimals: 6 },
  { address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e', symbol: 'USDT', decimals: 6 },
  { address: '0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771', symbol: 'USAT', decimals: 6 },
]

/**
 * Block that created the Reputation Registry proxy, 2026-02-05T13:18:07Z
 * (tx 0xfad77a41…f2bbf). Read from the chain, not estimated: a start block
 * guessed from a date silently truncates the earliest history and the audit
 * reports a clean number for an incomplete scan.
 */
export const REGISTRY_DEPLOY_BLOCK = 58_396_729n

/** Celo produces a block every second, so this is a reliable day-to-block ratio. */
export const BLOCKS_PER_DAY = 86_400n

/**
 * eth_getLogs range cap. Public RPCs reject wide ranges — forno.celo.org caps
 * at 5,000 blocks (~83 minutes), which is the tightest limit observed, so it is
 * the default.
 *
 * Chunks are only ever NARROWED at runtime, never widened: `ceiling` in
 * getLogsChunked starts here and a range rejection or a capped response lowers
 * it. An earlier comment claimed the opposite — that wider ranges were
 * discovered — which was both false and, given the cap below, the dangerous
 * direction to be wrong in.
 */
export const LOG_CHUNK_SIZE = BigInt(envNumber('LOG_CHUNK_SIZE', 5_000))

/**
 * A response this large is treated as truncated rather than complete.
 *
 * celo.blockscout.com/api/eth-rpc returns at most 1,000 logs and reports
 * nothing: 100,000 and 400,000 block ranges both come back with exactly 1,000.
 * The densest 5,000-block window this audit scans holds 471 NewFeedback
 * events, so there is a factor of two of headroom and no more.
 */
export const TRUNCATION_SUSPECT = envNumber('TRUNCATION_SUSPECT', 1_000)

/** Indexed-argument batch size for targeted Transfer queries. */
/**
 * How many addresses go into one indexed-topic filter.
 *
 * It was 100, which made the settlement sweep 43 batches x 3 tokens = 129
 * full-history passes, measured at 5.9 hours — enough that a guard skipped the
 * sweep outright and the audit published a blank where its only chain-only
 * figure belongs.
 *
 * Measured on 2026-08-30 against celo.blockscout.com: batches of 100, 250,
 * 500, 1,000 and 2,000 all return exactly the same transfers as the
 * unfiltered ground truth for the same window, at 0.2s and 0.4s respectively.
 * The request cost barely moves; only the number of passes does. 4,252
 * reviewers become 3 batches, and the sweep becomes 9 passes.
 *
 * A wider filter matches more logs per chunk, which moves the sweep closer to
 * the endpoint's silent 1,000-log cap — so this number is only safe because
 * getLogsChunked now treats a capped response as truncated and narrows. Do not
 * raise it further without re-reading that guard.
 */
export const TOPIC_BATCH_SIZE = envNumber('TOPIC_BATCH_SIZE', 2_000)

// ---------------------------------------------------------------------------
// Event signatures
// ---------------------------------------------------------------------------

/**
 * Exact signature read from the verified implementation contract
 * (0x16e0FA7f7C56B9a767E34B192B51f921BE31dA34), not guessed.
 *
 * `feedbackURI` and `feedbackHash` are the only two fields that can carry
 * evidence: the ERC-8004 `proofOfPayment` object lives in the off-chain file
 * that `feedbackURI` points at. An empty URI therefore means the feedback
 * asserts a score with nothing whatsoever behind it.
 */
export const NEW_FEEDBACK_EVENT = parseAbiItem(
  'event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
)

export const FEEDBACK_REVOKED_EVENT = parseAbiItem(
  'event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex)',
)

/**
 * The Identity Registry is an ERC-721. Agent registration is a mint, so a
 * Transfer from the zero address is the registration record, and later
 * Transfers are ownership changes. Using the ERC-721 event rather than a custom
 * one keeps this robust against registry upgrades.
 */
export const ERC721_TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
)

export const ERC20_TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
)

/** EIP-3009. Emitted alongside Transfer when a gasless authorized transfer settles. */
export const AUTHORIZATION_USED_EVENT = parseAbiItem(
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
)

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address
export const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000'

// ---------------------------------------------------------------------------
// Evidence retrieval
// ---------------------------------------------------------------------------

/**
 * Ceiling on a retrieved evidence file, in bytes.
 *
 * `feedbackURI` is attacker-controlled, so the response size is chosen by the
 * party being audited. Without a cap, one two-gigabyte body ends the run with
 * an out-of-memory kill instead of a verdict — free for them, fatal for us.
 * A megabyte is two orders of magnitude above any real feedback file.
 */
/**
 * Numbers read from the environment, with the fallback applied when the value
 * is not a usable positive number.
 *
 * `Number('a lot')` is NaN, and every comparison against NaN is false — so a
 * typo in EVIDENCE_MAX_BYTES silently removed the size cap, and one in
 * EVIDENCE_ATTEMPTS reduced the retry loop to zero passes, which reports every
 * file in the registry as unreachable.
 */
function envNumber(name: string, fallback: number, min = 1): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < min) {
    console.warn(`  ! ${name}=${JSON.stringify(raw)} is not a number >= ${min}; using ${fallback}`)
    return fallback
  }
  return n
}

export const EVIDENCE_MAX_BYTES = envNumber('EVIDENCE_MAX_BYTES', 1_048_576)

/** Deadline covering headers AND body, per attempt. */
export const EVIDENCE_TIMEOUT_MS = envNumber('EVIDENCE_TIMEOUT_MS', 8_000)

/**
 * Passes over the full gateway list before a file is called unreachable.
 *
 * One GET cannot tell a dead link from a busy gateway, and a verdict published
 * on that basis is exactly the silent misclassification this audit exists to
 * expose. Two passes, spread in time, is the cheapest honest minimum.
 */
export const EVIDENCE_ATTEMPTS = envNumber('EVIDENCE_ATTEMPTS', 2)

/**
 * Wall-clock ceiling for everything one record may cost.
 *
 * The per-attempt deadline bounds a request; it does not bound a record. Two
 * passes over five targets is ten attempts plus the backoff between them, so a
 * host that stalls every time held one worker for more than eighty seconds —
 * and the result was `inconclusive`, which is to say the adversary bought the
 * audit's time and paid in nothing. This bounds the whole race.
 */
export const EVIDENCE_BUDGET_MS = envNumber('EVIDENCE_BUDGET_MS', 45_000)

/** Base backoff between passes; multiplied by the pass number. */
export const EVIDENCE_RETRY_DELAY_MS = envNumber('EVIDENCE_RETRY_DELAY_MS', 2_000, 0)

/** Redirect hops followed before giving up. Each hop is re-checked for SSRF. */
export const MAX_REDIRECTS = envNumber('MAX_REDIRECTS', 5, 0)

/**
 * Independent IPFS gateways, tried in order.
 *
 * A CID resolves to the same bytes everywhere, so "ipfs.io said no" is a fact
 * about ipfs.io. Auditing 10,000 files through one notoriously rate-limited
 * gateway manufactured an unknown number of false "dead link" findings; the
 * only fix that costs nothing is to ask somebody else too.
 */
export const IPFS_GATEWAYS = (process.env.IPFS_GATEWAYS ?? [
  'https://ipfs.io/ipfs/',
  'https://dweb.link/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
  'https://4everland.io/ipfs/',
].join(',')).split(',').map((g) => g.trim()).filter(Boolean)
// cloudflare-ipfs.com was in this list and no longer resolves at all —
// Cloudflare retired the gateway. A dead entry here is not free: it spends an
// attempt on every single file, and until the fix above it also condemned them.

/** Same reasoning for Arweave, whose `ar://` scheme was previously undecodable. */
export const ARWEAVE_GATEWAYS = (process.env.ARWEAVE_GATEWAYS ?? [
  'https://arweave.net/',
  'https://ar-io.net/',
].join(',')).split(',').map((g) => g.trim()).filter(Boolean)

/**
 * The chain this audit can actually query.
 *
 * A file may declare its payment on another network. We cannot confirm or deny
 * those, and saying "not found on Celo" about a Base transaction reports a
 * finding we did not make.
 */
export const QUERYABLE_CHAIN_IDS = new Set<string>(['42220', 'celo', 'celo-mainnet'])

/**
 * A fingerprint of the rules a retrieval verdict was decided under.
 *
 * The verdict cache is keyed by the registry's own tuple and nothing else, so
 * a run under corrected retrieval rules replayed verdicts decided under the
 * broken ones and published them as this run's measurement — a stale answer
 * wearing a fresh date, which is the exact failure this audit accuses others
 * of. Verdicts now live in a file named after the rules that produced them: a
 * change starts a fresh cache rather than silently inheriting an old one, and
 * re-running under the old rules still finds the old cache.
 *
 * `RETRIEVAL_RULES` is bumped by hand when the semantics of a verdict change —
 * which is forgettable, so a test hashes the modules that decide one and fails
 * if they moved without it. The gateway lists are folded in automatically:
 * they are data, they are the most likely thing to change, and a different set
 * of gateways is a different measurement.
 */
export const RETRIEVAL_RULES = 'r8-ssrf-cid-datauri'

/**
 * Everything that can change a verdict, hashed with a real hash.
 *
 * Three separate holes, all of them the same mistake — believing a shorter
 * list was enough:
 *
 *   * The digest was a home-made pair of 32-bit mixes truncated to twelve
 *     base36 characters. FNV-1a is invertible, so a meet-in-the-middle search
 *     finds two different gateway lists with the same fingerprint — and the
 *     fingerprint is what decides whether cached verdicts are reused. sha256
 *     costs nothing here and is not a puzzle anyone can solve.
 *
 *   * The gateway lists were SORTED into the digest, so [slow, fast] and
 *     [fast, slow] hashed identically. Order decides the verdict under the
 *     wall-clock budget: fetchEvidence walks targets in order and checks the
 *     deadline before each, so a slow gateway placed first can spend the
 *     budget and leave the rest unasked. Order is an input; it is hashed.
 *
 *   * Only the retrieval settings were in it. A verdict also carries
 *     txExists, paymentVerified, paymentAttributed, amounts and tokens, all
 *     produced against CELO_RPC_URL — and the proxy decides both the network
 *     path and whether address pinning happens at all. Each of those changes
 *     what a verdict means, and none of them was named.
 */
/**
 * The first of these environment variables that is set to a non-empty value.
 *
 * Kept identical to `envProxy` in net/fetch-evidence.ts. It cannot be imported
 * from there — that module imports this one — so the duplication is deliberate
 * and guarded by a test rather than left to drift.
 */
export function firstSet(...names: string[]): string {
  for (const n of names) {
    const v = (process.env[n] ?? '').trim()
    if (v) return v
  }
  return ''
}

export function retrievalFingerprint(): string {
  const parts = [
    `rules=${RETRIEVAL_RULES}`,
    `audit=${AUDIT_VERSION}`,
    `attempts=${EVIDENCE_ATTEMPTS}`,
    `bytes=${EVIDENCE_MAX_BYTES}`,
    `timeout=${EVIDENCE_TIMEOUT_MS}`,
    `budget=${EVIDENCE_BUDGET_MS}`,
    `backoff=${EVIDENCE_RETRY_DELAY_MS}`,
    `dns=${DNS_TIMEOUT_MS}`,
    `redirects=${MAX_REDIRECTS}`,
    // In order, not sorted: order is what the budget spends.
    `ipfs=${IPFS_GATEWAYS.join('|')}`,
    `ar=${ARWEAVE_GATEWAYS.join('|')}`,
    // The payment half of every verdict comes from this endpoint.
    `rpc=${process.env.CELO_RPC_URL ?? '(default)'}`,
    /**
     * Whether traffic is proxied, and to which host — never the port.
     *
     * This hashed the full proxy URLs, and a sandboxed runner assigns a fresh
     * port to its local proxy on every process: 35647, then 42287, then
     * another. So the fingerprint changed on every run, the verdict cache was
     * never once reused, and a full-history audit re-fetched all 10,469 files
     * each time — five hours, every time, to reach verdicts already on disk.
     *
     * What changes a verdict is that the request is proxied at all: the path
     * differs and address pinning is off. The port it happens to listen on
     * changes nothing about the answer, so it is not an input.
     */
    `proxy=${['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']
      .map((k) => {
        const v = (process.env[k] ?? '').trim()
        if (!v) return `${k}=`
        try { return `${k}=${new URL(v).hostname}` } catch { return `${k}=set` }
      }).join(',')}`,
    /**
     * Resolved exactly as the fetcher resolves it, or the digest lies.
     *
     * This was `NO_PROXY ?? no_proxy`, and `??` only skips null and undefined.
     * An exported-but-empty `NO_PROXY=""` therefore won and the lowercase
     * variable was never read — while `envProxy()` in net/fetch-evidence.ts
     * skips empty strings and honours `no_proxy`. So a run with
     * `NO_PROXY="" no_proxy=gateway.pinata.cloud` fetched the primary IPFS
     * gateway direct with address pinning, and a run with neither set fetched
     * it through the proxy, and both produced fingerprint 4ffcef7480884a56 and
     * shared one verdict cache. That is the precise failure this fingerprint
     * exists to make impossible, introduced by the commit that made the
     * fingerprint stable. `firstSet` mirrors envProxy; a test asserts they
     * still agree.
     */
    `noproxy=${firstSet('NO_PROXY', 'no_proxy')}`,
  ].join(';')
  return createHash('sha256').update(parts).digest('hex').slice(0, 16)
}

/**
 * How long one name resolution may take.
 *
 * Its own budget rather than the request timeout: c-ares self-bounds and is
 * cancellable, but a resolver that never answers should still cost less than a
 * whole request's deadline, because a record can need several of them.
 */
export const DNS_TIMEOUT_MS = envNumber('DNS_TIMEOUT_MS', 4_000)

/**
 * A full-history `eth_getLogs` pass per token per batch of reviewers. Measured
 * at roughly 3 minutes each against the default endpoint, so this ceiling is
 * about an hour of scanning.
 */
export const MAX_SETTLEMENT_PASSES = envNumber('MAX_SETTLEMENT_PASSES', 24)

/** How many passes the settlement sweep would cost for this many reviewers. */
export function settlementPasses(reviewers: number): number {
  return Math.ceil(reviewers / TOPIC_BATCH_SIZE) * SETTLEMENT_TOKENS.length
}
