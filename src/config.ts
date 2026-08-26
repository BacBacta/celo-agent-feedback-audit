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
