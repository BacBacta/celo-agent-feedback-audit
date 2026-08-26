import type { Address, Hex } from 'viem'
import { getLogsChunked, blockTimestamps } from '../rpc.js'
import {
  NEW_FEEDBACK_EVENT,
  FEEDBACK_REVOKED_EVENT,
  REPUTATION_REGISTRY,
  ZERO_HASH,
} from '../config.js'

export interface FeedbackRecord {
  agentId: bigint
  reviewer: Address
  feedbackIndex: bigint
  value: bigint
  valueDecimals: number
  tag1: string
  tag2: string
  endpoint: string
  feedbackURI: string
  feedbackHash: Hex
  blockNumber: bigint
  timestamp: number
  txHash: Hex
  revoked: boolean
  /**
   * A retrievable pointer to an evidence file. This is the only thing that can
   * actually be checked, so it is what "declares evidence" means here.
   */
  hasURI: boolean
  /**
   * A non-zero attested digest. On its own — with no URI to fetch — it is an
   * unfalsifiable claim: nothing can be compared against it. Counted
   * separately for exactly that reason.
   */
  hasHash: boolean
}

export async function loadFeedback(fromBlock: bigint, toBlock: bigint): Promise<FeedbackRecord[]> {
  const logs = await getLogsChunked({
    address: REPUTATION_REGISTRY,
    event: NEW_FEEDBACK_EVENT,
    fromBlock,
    toBlock,
    cacheKey: `feedback-${fromBlock}`,
    onProgress: (done, total, found) => {
      const pct = total === 0n ? 100 : Number((done * 100n) / total)
      process.stdout.write(`\r  feedback: ${pct}% — ${found} events`)
    },
  })
  process.stdout.write('\n')

  const revokedLogs = await getLogsChunked({
    address: REPUTATION_REGISTRY,
    event: FEEDBACK_REVOKED_EVENT,
    fromBlock,
    toBlock,
    cacheKey: `revoked-${fromBlock}`,
  })
  const revokedKeys = new Set(
    revokedLogs.map((l) => `${l.args.agentId}:${l.args.clientAddress}:${l.args.feedbackIndex}`),
  )

  const times = await blockTimestamps(logs.map((l) => l.blockNumber as bigint))

  return logs.map((l): FeedbackRecord => {
    const a = l.args as Record<string, any>
    const uri: string = a.feedbackURI ?? ''
    const hash: Hex = a.feedbackHash ?? (ZERO_HASH as Hex)
    return {
      agentId: a.agentId,
      reviewer: a.clientAddress,
      feedbackIndex: a.feedbackIndex,
      value: a.value,
      valueDecimals: Number(a.valueDecimals ?? 0),
      tag1: a.tag1 ?? '',
      tag2: a.tag2 ?? '',
      endpoint: a.endpoint ?? '',
      feedbackURI: uri,
      feedbackHash: hash,
      blockNumber: l.blockNumber as bigint,
      timestamp: times.get(l.blockNumber as bigint) ?? 0,
      txHash: l.transactionHash as Hex,
      revoked: revokedKeys.has(`${a.agentId}:${a.clientAddress}:${a.feedbackIndex}`),
      hasURI: uri.trim().length > 0,
      hasHash: hash !== ZERO_HASH,
    }
  })
}
