import type { Address, Hex } from 'viem'
import { getLogsChunked, blockTimestamps } from '../rpc.js'
import {
  AUTHORIZATION_USED_EVENT,
  ERC20_TRANSFER_EVENT,
  SETTLEMENT_TOKENS,
  TOPIC_BATCH_SIZE,
} from '../config.js'

export interface Settlement {
  payer: Address
  payee: Address
  amount: bigint
  symbol: string
  decimals: number
  blockNumber: bigint
  timestamp: number
  txHash: Hex
  /** True when the same transaction emitted EIP-3009 AuthorizationUsed. */
  gaslessAuthorized: boolean
}

/**
 * The naive approach — index every stablecoin Transfer on Celo and look for
 * matches — is not runnable on a laptop: USDT alone moves millions of transfers.
 *
 * We invert it. The feedback side is small (tens of thousands of records, a few
 * thousand distinct reviewers), so we ask the node only for Transfers whose
 * indexed `from` is one of those reviewers. eth_getLogs accepts an array of
 * values per indexed topic, so this costs a few hundred requests instead of
 * scanning the whole chain — and it is exact, not sampled.
 *
 * DO NOT invert it the other way. Filtering on `to` — the 565 distinct agent
 * owners rather than the 4,252 reviewers — is seven times cheaper and looks
 * strictly better, and it would also catch a platform paying on the reviewer's
 * behalf, which this design currently reports as unattributed. It is a trap.
 * Measured on 2026-08-30: the default endpoint, celo.blockscout.com/api/eth-rpc,
 * honours a filter on the FIRST indexed argument and silently ignores the
 * second. Asked for Transfers with `to` set to an address that demonstrably
 * appears in the window, it returns an empty array — no error — which reads
 * exactly like "this owner received nothing". forno and Ankr answer correctly.
 * `probeTopicFiltering` in rpc.ts exists to stop that idea with a failing
 * check rather than a published zero.
 */
export async function loadSettlementsFrom(
  payers: Address[],
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Settlement[]> {
  const batches: Address[][] = []
  for (let i = 0; i < payers.length; i += TOPIC_BATCH_SIZE) {
    batches.push(payers.slice(i, i + TOPIC_BATCH_SIZE))
  }

  const transfers: any[] = []
  let done = 0
  for (const batch of batches) {
    for (const token of SETTLEMENT_TOKENS) {
      const logs = await getLogsChunked({
        address: token.address,
        event: ERC20_TRANSFER_EVENT,
        fromBlock,
        toBlock,
        args: { from: batch },
        cacheKey: `settle-${token.symbol}-${done}-${fromBlock}`,
      })
      for (const l of logs) transfers.push({ ...l, token })
    }
    done++
    process.stdout.write(
      `\r  settlements: batch ${done}/${batches.length} — ${transfers.length} transfers`,
    )
  }
  process.stdout.write('\n')

  // Mark which transfers were gasless EIP-3009 settlements. AuthorizationUsed is
  // rare enough to sweep directly, and joining on txHash avoids one receipt
  // fetch per transfer.
  const authTxs = new Set<string>()
  for (const token of SETTLEMENT_TOKENS) {
    const logs = await getLogsChunked({
      address: token.address,
      event: AUTHORIZATION_USED_EVENT,
      fromBlock,
      toBlock,
      cacheKey: `auth-${token.symbol}-${fromBlock}`,
    })
    for (const l of logs) authTxs.add((l.transactionHash as string).toLowerCase())
  }

  const times = await blockTimestamps(transfers.map((t) => t.blockNumber as bigint))

  return transfers.map((t): Settlement => {
    const a = t.args as Record<string, any>
    return {
      payer: (a.from as Address).toLowerCase() as Address,
      payee: (a.to as Address).toLowerCase() as Address,
      amount: a.value as bigint,
      symbol: t.token.symbol,
      decimals: t.token.decimals,
      blockNumber: t.blockNumber as bigint,
      timestamp: times.get(t.blockNumber as bigint) ?? 0,
      txHash: t.transactionHash as Hex,
      gaslessAuthorized: authTxs.has((t.transactionHash as string).toLowerCase()),
    }
  })
}
