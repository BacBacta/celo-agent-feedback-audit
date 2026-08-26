import type { Address } from 'viem'
import { getLogsChunked } from '../rpc.js'
import { ERC721_TRANSFER_EVENT, IDENTITY_REGISTRY, SELF_AGENT_REGISTRY, ZERO_ADDRESS } from '../config.js'

export interface AgentOwnership {
  /** agentId -> current owner. */
  owners: Map<string, Address>
  /** agentId -> block at which the agent was first registered (minted). */
  registeredAt: Map<string, bigint>
  /** Every address that has ever held an agent NFT. */
  operators: Set<string>
}

/**
 * The Identity Registry is an ERC-721, so a mint (Transfer from 0x0) is a
 * registration and later Transfers are ownership changes. Replaying them in
 * order gives current ownership without needing a view call per agent.
 */
export async function loadIdentity(fromBlock: bigint, toBlock: bigint): Promise<AgentOwnership> {
  const logs = await getLogsChunked({
    address: IDENTITY_REGISTRY,
    event: ERC721_TRANSFER_EVENT,
    fromBlock,
    toBlock,
    cacheKey: `identity-${fromBlock}`,
    onProgress: (done, total, found) => {
      const pct = total === 0n ? 100 : Number((done * 100n) / total)
      process.stdout.write(`\r  identity: ${pct}% — ${found} transfers`)
    },
  })
  process.stdout.write('\n')

  logs.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? Number(a.logIndex) - Number(b.logIndex)
      : Number(a.blockNumber - b.blockNumber),
  )

  const owners = new Map<string, Address>()
  const registeredAt = new Map<string, bigint>()
  const operators = new Set<string>()

  for (const l of logs) {
    const a = l.args as Record<string, any>
    const id = String(a.tokenId)
    const to = (a.to as Address).toLowerCase() as Address
    if ((a.from as Address).toLowerCase() === ZERO_ADDRESS && !registeredAt.has(id)) {
      registeredAt.set(id, l.blockNumber as bigint)
    }
    owners.set(id, to)
    operators.add(to)
  }

  return { owners, registeredAt, operators }
}

/**
 * Which addresses hold a Self Agent ID. Self mints a soulbound ERC-721 backed
 * by a zero-knowledge passport proof, one per unique human, so holding one is
 * the strongest sybil signal available on Celo today.
 */
export async function loadSelfVerified(fromBlock: bigint, toBlock: bigint): Promise<Set<string>> {
  const logs = await getLogsChunked({
    address: SELF_AGENT_REGISTRY,
    event: ERC721_TRANSFER_EVENT,
    fromBlock,
    toBlock,
    cacheKey: `self-${fromBlock}`,
  })
  const holders = new Set<string>()
  for (const l of logs) {
    const a = l.args as Record<string, any>
    if ((a.from as Address).toLowerCase() === ZERO_ADDRESS) {
      holders.add((a.to as Address).toLowerCase())
    }
  }
  return holders
}
