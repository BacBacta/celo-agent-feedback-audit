import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { createPublicClient, http, type AbiEvent, type Address } from 'viem'
import { celo } from 'viem/chains'
import { LOG_CHUNK_SIZE } from './config.js'

const RPC_URL = process.env.CELO_RPC_URL ?? 'https://forno.celo.org'
const CONCURRENCY = Math.max(1, Number(process.env.RPC_CONCURRENCY ?? 5))
const CACHE_DIR = process.env.CACHE_DIR ?? 'data'

/**
 * RPC_BATCH=0 disables JSON-RPC request batching. Needed for indexer-backed
 * endpoints (e.g. Blockscout's /api/eth-rpc) that speak single-request JSON-RPC
 * only — and that endpoint matters, because the counter-analysis showed forno's
 * load-balanced nodes returning INCONSISTENT eth_getLogs results for identical
 * immutable ranges. A DB-backed indexer answers deterministically.
 */
export const client = createPublicClient({
  chain: celo,
  transport: http(RPC_URL, {
    batch: process.env.RPC_BATCH !== '0',
    retryCount: 5,
    retryDelay: 400,
  }),
})

/**
 * Timestamps come from block headers — chain data that any node serves
 * consistently. The forno unreliability was in its LOG INDEX, not in blocks,
 * so headers may safely come from a fast node endpoint while the event list
 * comes from the indexer. TS_RPC_URL splits the two; it defaults to the main
 * endpoint when unset.
 */
const TS_RPC_URL = process.env.TS_RPC_URL ?? RPC_URL
const tsClient =
  TS_RPC_URL === RPC_URL
    ? null
    : createPublicClient({
        chain: celo,
        transport: http(TS_RPC_URL, { batch: true, retryCount: 5, retryDelay: 400 }),
      })

/**
 * Retry an RPC call through rate limiting instead of letting it become a wrong
 * answer. viem's own retries give up after ~6 seconds; Cloudflare windows run
 * a minute. Anything still failing after these waits throws — in an audit, a
 * loud failure beats a silently misrecorded one.
 */
export async function throughRateLimit<T>(what: string, fn: () => Promise<T>): Promise<T> {
  const waits = [5_000, 10_000, 20_000, 30_000, 45_000, 60_000]
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (classifyFailure(err) !== 'rate' || attempt >= waits.length) throw err
      const ms = waits[attempt]!
      process.stdout.write(`\r  rate limited (${what}) — waiting ${ms / 1000}s (${attempt + 1}/${waits.length})   `)
      await sleep(ms)
    }
  }
}

export async function latestBlock(): Promise<bigint> {
  return client.getBlockNumber()
}

/**
 * Why a chunk failed decides what to do about it, and the three causes need
 * opposite responses:
 *
 *  - `range`  is a property of the ENDPOINT. Once discovered it never changes,
 *             so it lowers a permanent ceiling we must never probe above again.
 *  - `size`   is a property of the DATA — one dense stretch of blocks returned
 *             too many logs. Lowering the ceiling for it would throttle the
 *             entire rest of the scan because of one busy week, so this only
 *             shrinks the current attempt and is allowed to recover.
 *  - `rate`   is a property of the PACE. Shrinking the window makes it strictly
 *             worse: more requests, more pressure. The only correct response is
 *             to wait.
 *
 * Treating all three the same — which this code did until it was pointed out —
 * turns a rate limit into a slow collapse down to the floor, and reports it as
 * a range problem.
 */
export type FailureKind = 'range' | 'size' | 'rate' | 'unknown'

export function classifyFailure(err: unknown): FailureKind {
  const e = err as { message?: string; details?: string; status?: number; code?: number }
  const text = `${e?.message ?? ''} ${e?.details ?? ''}`.toLowerCase()

  if (e?.status === 429 || e?.code === -32005 || /rate limit|too many requests|429|throttl/.test(text)) {
    return 'rate'
  }
  if (/response size|too many results|more than .* results|result set|query returned more/.test(text)) {
    return 'size'
  }
  if (/block range|exceeds range|range too|up to a \d+ block|retry smaller|query timeout/.test(text)) {
    return 'range'
  }
  return 'unknown'
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * (txHash, logIndex) uniquely identifies a log. Duplicates can only enter
 * through the resume cache — a crash landing between the data append and the
 * state write makes the next run re-fetch a wave it already stored. Rare, but
 * an audit that can silently double-count is not an audit, so uniqueness is
 * enforced at the exit rather than assumed.
 */
export function dedupeLogs<T extends { transactionHash?: unknown; logIndex?: unknown }>(
  logs: T[],
): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const l of logs) {
    const k = `${l.transactionHash}:${l.logIndex}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(l)
  }
  return out
}

// BigInt survives neither JSON.stringify nor JSON.parse, and logs are full of
// it. Tagging preserves the type across a cache round-trip.
const replacer = (_k: string, v: unknown) =>
  typeof v === 'bigint' ? { __bigint: v.toString() } : v
const reviver = (_k: string, v: any) =>
  v && typeof v === 'object' && typeof v.__bigint === 'string' ? BigInt(v.__bigint) : v

interface CacheState { completedUpTo: string }

function cachePaths(key: string) {
  return { logs: `${CACHE_DIR}/${key}.jsonl`, state: `${CACHE_DIR}/${key}.state` }
}

/**
 * Chunked eth_getLogs, resumable and parallel.
 *
 * A full-history scan of this registry is roughly 3,500 requests per event, and
 * the audit runs five of them. Sequentially, on a phone, over a public endpoint,
 * that is hours — and an interruption at hour three that loses everything makes
 * the whole exercise impractical. So each sweep streams to disk as it goes and
 * records how far it got: re-running resumes instead of restarting.
 *
 * Requests go out in waves. The cursor only advances once a whole wave lands,
 * so a crash mid-wave costs one wave, never a partial range that would later
 * look complete.
 *
 * Endpoints disagree about the maximum block range and rarely document it —
 * forno.celo.org allows 5,000. The span halves on rejection and creeps back up
 * on success, but never past a span already refused: without that ceiling the
 * creep-back walks into the same wall on every wave.
 */
export async function getLogsChunked<T extends AbiEvent>(params: {
  address: Address | Address[]
  event: T
  fromBlock: bigint
  toBlock: bigint
  args?: Record<string, unknown>
  cacheKey?: string
  onProgress?: (done: bigint, total: bigint, found: number) => void
}): Promise<any[]> {
  const { address, event, fromBlock, toBlock, args, cacheKey, onProgress } = params
  const total = toBlock - fromBlock
  let out: any[] = []
  let cursor = fromBlock

  let paths: ReturnType<typeof cachePaths> | null = null
  if (cacheKey) {
    mkdirSync(CACHE_DIR, { recursive: true })
    paths = cachePaths(cacheKey)
    if (existsSync(paths.state) && existsSync(paths.logs)) {
      try {
        const state: CacheState = JSON.parse(readFileSync(paths.state, 'utf8'))
        const resumeAt = BigInt(state.completedUpTo) + 1n
        if (resumeAt > fromBlock && resumeAt <= toBlock + 1n) {
          out = readFileSync(paths.logs, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line, reviver))
          cursor = resumeAt
          process.stdout.write(`  resuming ${cacheKey} at block ${cursor} (${out.length} cached)\n`)
        }
      } catch {
        /* unreadable cache is simply ignored and refetched */
      }
    }
  }

  // Permanent: only a range rejection lowers this.
  let ceiling = LOG_CHUNK_SIZE
  // Current attempt: may dip below the ceiling for a dense stretch, then recover.
  let span = LOG_CHUNK_SIZE
  let rateWaits = 0

  while (cursor <= toBlock) {
    const ranges: { from: bigint; to: bigint }[] = []
    let probe = cursor
    for (let i = 0; i < CONCURRENCY && probe <= toBlock; i++) {
      const end = probe + span - 1n > toBlock ? toBlock : probe + span - 1n
      ranges.push({ from: probe, to: end })
      probe = end + 1n
    }

    try {
      const waves = await Promise.all(
        ranges.map((r) =>
          client.getLogs({
            address,
            event,
            fromBlock: r.from,
            toBlock: r.to,
            ...(args ? { args } : {}),
          } as any),
        ),
      )

      const fresh = waves.flat()
      out.push(...fresh)
      const waveEnd = ranges[ranges.length - 1]!.to

      if (paths) {
        if (fresh.length) {
          appendFileSync(
            paths.logs,
            fresh.map((l) => JSON.stringify(l, replacer)).join('\n') + '\n',
          )
        }
        writeFileSync(paths.state, JSON.stringify({ completedUpTo: waveEnd.toString() }))
      }

      cursor = waveEnd + 1n
      rateWaits = 0
      onProgress?.(cursor - fromBlock, total, out.length)
      if (span < ceiling) span = span * 2n > ceiling ? ceiling : span * 2n
    } catch (err) {
      const kind = classifyFailure(err)

      if (kind === 'rate') {
        // Back off and retry the same wave. Capped so a permanently throttled
        // endpoint fails loudly instead of hanging overnight.
        if (rateWaits >= 8) {
          throw new Error(
            `Rate limited by the RPC endpoint after ${rateWaits} backoffs. ` +
              `Lower RPC_CONCURRENCY (currently ${CONCURRENCY}) and re-run — the scan resumes ` +
              `where it stopped.\nOriginal error: ${(err as Error).message?.split('\n')[0]}`,
          )
        }
        const waitMs = Math.min(30_000, 1_000 * 2 ** rateWaits)
        rateWaits++
        process.stdout.write(`\r  rate limited — waiting ${waitMs / 1000}s (${rateWaits}/8)          `)
        await sleep(waitMs)
        continue
      }

      if (kind === 'size') {
        // Dense stretch of blocks, not an endpoint limit. Shrink this attempt
        // only; the ceiling stays put so the scan speeds back up afterwards.
        if (span <= 10n) throw err
        span = span / 2n
        continue
      }

      if (span <= 100n) {
        // The span has been halved to the point of uselessness, which means the
        // endpoint's eth_getLogs range limit is too small to scan with — not
        // that the query is wrong. Say so, because the provider's own error
        // ("invalid request") points at the wrong thing entirely.
        throw new Error(
          `This RPC endpoint caps eth_getLogs below ${span} blocks, which cannot scan ` +
            `a range of ${total} blocks in any reasonable number of requests.\n` +
            `Some free tiers cap at 10 blocks; https://forno.celo.org allows 5,000 and ` +
            `is the better choice here.\nOriginal error: ${(err as Error).message?.split('\n')[0]}`,
        )
      }
      ceiling = span / 2n
      span = ceiling
    }
  }

  const unique = dedupeLogs(out)
  if (unique.length !== out.length) {
    process.stdout.write(`\n  note: ${out.length - unique.length} duplicate log(s) removed (resume overlap)\n`)
  }
  return unique
}

/**
 * Block timestamps, cached in memory AND on disk. Real times are needed for
 * clustering, but a full-history run resolves tens of thousands of unique
 * blocks — refetching those on every re-run (and every source switch) turned
 * out to be the single largest avoidable cost, so the cache persists.
 */
const tsCache = new Map<bigint, number>()
const TS_FILE = `${CACHE_DIR}/timestamps.json`
let tsLoaded = false

function loadTsCache() {
  if (tsLoaded) return
  tsLoaded = true
  try {
    const raw = JSON.parse(readFileSync(TS_FILE, 'utf8')) as Record<string, number>
    for (const [k, v] of Object.entries(raw)) tsCache.set(BigInt(k), v)
  } catch {
    /* first run */
  }
}

function saveTsCache() {
  mkdirSync(CACHE_DIR, { recursive: true })
  const obj: Record<string, number> = {}
  for (const [k, v] of tsCache) obj[k.toString()] = v
  writeFileSync(TS_FILE, JSON.stringify(obj))
}

export async function blockTimestamp(n: bigint): Promise<number> {
  loadTsCache()
  const hit = tsCache.get(n)
  if (hit !== undefined) return hit
  const block = await throughRateLimit('timestamps', () =>
    (tsClient ?? client).getBlock({ blockNumber: n }),
  )
  const ts = Number(block.timestamp)
  tsCache.set(n, ts)
  return ts
}

export async function blockTimestamps(blocks: bigint[]): Promise<Map<bigint, number>> {
  loadTsCache()
  const unique = [...new Set(blocks)].filter((b) => !tsCache.has(b))
  const conc = Math.max(1, Number(process.env.TS_CONCURRENCY ?? CONCURRENCY))
  const waveDelay = Number(process.env.TS_WAVE_DELAY_MS ?? 300)
  for (let i = 0; i < unique.length; i += conc) {
    await Promise.all(unique.slice(i, i + conc).map((b) => blockTimestamp(b)))
    process.stdout.write(`\r  timestamps: ${Math.min(i + conc, unique.length)}/${unique.length}`)
    if (i % (conc * 50) === 0) saveTsCache()
    if (waveDelay > 0) await sleep(waveDelay)
  }
  if (unique.length) {
    saveTsCache()
    process.stdout.write('\n')
  }
  return tsCache
}
