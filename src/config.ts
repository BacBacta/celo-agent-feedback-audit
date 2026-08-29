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
 * the default. Endpoints that allow more are discovered at runtime.
 */
export const LOG_CHUNK_SIZE = 5_000n

/** Indexed-argument batch size for targeted Transfer queries. */
export const TOPIC_BATCH_SIZE = 100

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
