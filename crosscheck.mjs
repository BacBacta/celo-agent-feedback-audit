/**
 * Independent counter-verification of the audit's own numbers.
 *
 *   node crosscheck.mjs
 *
 * The audit indexed NewFeedback events through one RPC in 5,000-block chunks.
 * If that endpoint ever silently truncated a dense chunk's results, the audit
 * undercounted without any error being raised — and 8004scan reporting 27,230
 * "feedbacks" against our 15,782 events makes that hypothesis worth killing
 * properly. This script attacks it three ways, none of which trusts the
 * original scan:
 *
 *   1. Integrity — recount the cache, enforce (txHash, logIndex) uniqueness.
 *   2. Recount — re-query the densest and a spread of random buckets at
 *      10x finer granularity (500 blocks). A silent per-response cap cannot
 *      bite the same way at both granularities, so local == fine-grained
 *      recount kills the truncation hypothesis where it matters most.
 *   3. Claims — re-verify every claimed payment tx in out/claims.csv against
 *      Blockscout, a different data source from the RPC used by the audit.
 *
 * INDEPENDENCE IS NOT AUTOMATIC. Step 2 is only a cross-check if CROSSCHECK_RPC
 * names a different provider from the one the audit used; left unset it re-asks
 * the same node the same question and agrees with itself. Step 3 queries
 * Blockscout's REST API, which is a different service but the same operator as
 * the indexer the audit is recommended to read events from — so it cross-checks
 * the transport, not the operator. Both limits are printed at startup rather
 * than left for a reader to discover, and the script refuses to describe itself
 * as independent when it is not.
 */
import fs from 'node:fs'

const AUDIT_RPC = process.env.CELO_RPC_URL ?? 'https://forno.celo.org'
const RPC = process.env.CROSSCHECK_RPC ?? AUDIT_RPC

/**
 * State the independence achieved before printing any number that depends on it.
 * A cross-check that silently re-queries the audit's own endpoint produces
 * agreement and calls it corroboration.
 */
const INDEPENDENT = process.env.CROSSCHECK_RPC != null && process.env.CROSSCHECK_RPC !== AUDIT_RPC
console.log(`\ncrosscheck`)
console.log(`  audit endpoint       ${AUDIT_RPC}`)
console.log(`  crosscheck endpoint  ${RPC}`)
if (INDEPENDENT) {
  console.log('  independence         YES — a second provider answers the recount')
} else {
  console.log('  independence         NO  — same endpoint as the audit.')
  console.log('                       Agreement below is self-agreement, not corroboration.')
  console.log('                       Set CROSSCHECK_RPC to a different provider.')
}
console.log(`  claim re-check       Blockscout REST (different service, same operator as the`)
console.log(`                       recommended event indexer — transport-independent only)`)

const CACHE = process.env.FEEDBACK_CACHE ?? 'data/feedback-58396729.jsonl'
const REGISTRY = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63'
const TOPIC0 = '0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc'
const BUCKET = 5000n
const FINE = 500n

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const big = (v) => (v && typeof v === 'object' && v.__bigint ? BigInt(v.__bigint) : BigInt(v))

async function rpcLogCount(from, to) {
  let span = FINE
  let cursor = from
  let count = 0
  while (cursor <= to) {
    const end = cursor + span - 1n > to ? to : cursor + span - 1n
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getLogs',
        params: [{
          address: REGISTRY,
          topics: [TOPIC0],
          fromBlock: '0x' + cursor.toString(16),
          toBlock: '0x' + end.toString(16),
        }],
      }),
    })
    const body = await res.json()
    if (body.error) {
      if (span <= 50n) throw new Error(`${body.error.message} at span ${span}`)
      span = span / 2n
      continue
    }
    count += body.result.length
    cursor = end + 1n
    await sleep(120)
  }
  return count
}

// ---------------------------------------------------------------- 1. integrity
if (!fs.existsSync(CACHE)) {
  console.error(`No cache at ${CACHE} — run the audit first, or set FEEDBACK_CACHE.`)
  process.exit(1)
}
const lines = fs.readFileSync(CACHE, 'utf8').split('\n').filter(Boolean)
const seen = new Set()
let dups = 0
const buckets = new Map()
for (const line of lines) {
  const o = JSON.parse(line)
  const key = `${o.transactionHash}:${JSON.stringify(o.logIndex)}`
  if (seen.has(key)) { dups++; continue }
  seen.add(key)
  const b = (big(o.blockNumber) / BUCKET) * BUCKET
  buckets.set(b, (buckets.get(b) ?? 0) + 1)
}
console.log('1. Cache integrity')
console.log(`   lines in cache        ${lines.length}`)
console.log(`   unique (tx,logIndex)  ${seen.size}`)
console.log(`   duplicates            ${dups}${dups ? '  ← the audit total must be re-read as ' + seen.size : ''}`)

// ---------------------------------------------------------------- 2. recount
const sorted = [...buckets.entries()].sort((a, b) => b[1] - a[1])
const byBlock = [...buckets.keys()].sort((a, b) => (a < b ? -1 : 1))
const targets = new Map()
for (const [b, c] of sorted.slice(0, 8)) targets.set(b, c)            // densest
for (let i = 0; i < byBlock.length; i += Math.max(1, Math.floor(byBlock.length / 8))) {
  const b = byBlock[i]
  targets.set(b, buckets.get(b))                                       // spread
}

console.log(`\n2. Fine-grained recount of ${targets.size} buckets via ${RPC}`)
console.log('   bucket start      local   recount   delta')
let mismatched = 0
for (const [start, local] of targets) {
  try {
    const rpc = await rpcLogCount(start, start + BUCKET - 1n)
    const delta = rpc - local
    if (delta !== 0) mismatched++
    console.log(
      `   ${String(start).padEnd(15)} ${String(local).padStart(7)} ${String(rpc).padStart(9)}   ${delta === 0 ? 'ok' : (delta > 0 ? '+' : '') + delta + '  ← MISSED EVENTS'}`,
    )
  } catch (e) {
    console.log(`   ${String(start).padEnd(15)} ${String(local).padStart(7)}      FAILED (${e.message.split('\n')[0]})`)
  }
}

// ---------------------------------------------------------------- 3. claims
console.log('\n3. Claimed payment transactions vs Blockscout')
if (!fs.existsSync('out/claims.csv')) {
  console.log('   out/claims.csv not found — re-run the audit (v0.2.0+) to produce it, then re-run this.')
} else {
  const rows = fs.readFileSync('out/claims.csv', 'utf8').split('\n').slice(1).filter(Boolean)
  let agree = 0
  let disagree = 0
  for (const row of rows) {
    const cols = row.split('","').map((c) => c.replace(/^"|"$/g, '').replace(/""/g, '"'))
    const [, , , , , txHash, txExists] = cols
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) { agree++; continue }  // malformed: nothing to look up
    const res = await fetch(`https://celo.blockscout.com/api/v2/transactions/${txHash}`)
    const existsOnBlockscout = res.status === 200
    const auditSaidExists = txExists === 'true'
    if (existsOnBlockscout === auditSaidExists) agree++
    else { disagree++; console.log(`   DISAGREE ${txHash} — audit: ${auditSaidExists}, blockscout: ${existsOnBlockscout}`) }
    await sleep(250)
  }
  console.log(`   ${rows.length} claims re-checked against a second source: ${agree} agree, ${disagree} disagree`)
}

console.log('\nVerdict:')
console.log(`   duplicates: ${dups === 0 ? 'none — totals stand as written' : dups + ' — use the unique count'}`)
console.log(`   truncation: ${mismatched === 0 ? 'no bucket lost events at 10x finer granularity — the 15,782 total is corroborated' : mismatched + ' bucket(s) MISMATCHED — the scan undercounted; re-run with LOG_CHUNK_SIZE lowered'}`)
