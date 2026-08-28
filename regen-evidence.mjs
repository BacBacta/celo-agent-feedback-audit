/**
 * Regenerate out/evidence.csv under the corrected ladder — from data already on
 * disk, no re-fetching.
 *
 *   node regen-evidence.mjs
 *
 * Everything the corrected rungs need was already recorded per row (fetched,
 * the 'not JSON' note that identifies soft-404s, the attested hash) or sits in
 * the event cache (the hash-only records that never declared a file). An hour
 * of downloads would reproduce exactly this.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'

const SRC = 'out/evidence.csv'
const CACHE = process.env.FEEDBACK_CACHE ?? 'data-bs/feedback-58396729.jsonl'
const TS = process.env.TS_CACHE ?? 'data-bs/timestamps.json'
const ZERO = /^0x0+$/

// ---- parse the existing export (quoted rows, plain header) ----
const lines = readFileSync(SRC, 'utf8').split('\n').filter(Boolean)
const header = lines[0].split(',')
const parse = (l) => l.slice(1, -1).split('","').map((c) => c.replace(/""/g, '"'))
const rows = lines.slice(1).map((l) => Object.fromEntries(header.map((k, i) => [k, parse(l)[i] ?? ''])))

function rung(o) {
  const jsonValid = o.jsonValid !== undefined ? o.jsonValid === 'true' : (o.fetched === 'true' && o.note !== 'not JSON')
  const hasHash = !ZERO.test(o.evidenceHash)
  if (o.paymentVerified === 'true') return 'PaymentVerified'
  if (o.claimsPayment === 'true' && o.txExistsOnCelo !== 'true') return 'PaymentTxNotFound'
  if (o.claimsPayment === 'true') {
    const n = (o.note ?? '').toLowerCase()
    return n.includes('zero') || n.includes('no stablecoin') ? 'PaymentNoValue' : 'PaymentTxFailed'
  }
  if (o.fetched === 'true' && jsonValid) {
    if (!hasHash) return 'EvidenceUnbound'
    return o.hashMatched === 'true' ? 'EvidenceIntact' : 'EvidenceUnhashed'
  }
  if (o.hasURI === 'true') return 'EvidenceUnreachable'
  return 'EvidenceAbsent'
}

// ---- hash-only records from the event cache ----
const big = (v) => (v && typeof v === 'object' && v.__bigint ? BigInt(v.__bigint) : BigInt(v ?? 0))
let tsMap = {}
try { tsMap = JSON.parse(readFileSync(TS, 'utf8')) } catch { /* timestamps optional */ }
const hashOnly = []
for (const line of readFileSync(CACHE, 'utf8').split('\n').filter(Boolean)) {
  const a = JSON.parse(line).args ?? {}
  const uri = String(a.feedbackURI ?? '').trim()
  const hash = String(a.feedbackHash ?? '')
  if (uri.length > 0 || ZERO.test(hash)) continue
  const block = big(JSON.parse(line).blockNumber ?? 0)
  const ts = tsMap[block.toString()]
  hashOnly.push({
    timestamp: ts ? new Date(ts * 1000).toISOString() : '',
    block: block.toString(),
    agentId: big(a.agentId).toString(),
    reviewer: String(a.clientAddress ?? ''),
    rung: 'EvidenceAbsent',
    hasURI: 'false', fetched: 'false', jsonValid: 'false', hashMatched: 'false',
    claimsPayment: 'false', txExistsOnCelo: 'false', paymentVerified: 'false',
    claimTxHash: '', evidenceHash: hash, note: '', feedbackURI: '',
  })
}

// ---- write back ----
const OUT_HEADER = 'timestamp,block,agentId,reviewer,rung,hasURI,fetched,jsonValid,hashMatched,claimsPayment,txExistsOnCelo,paymentVerified,claimTxHash,evidenceHash,note,feedbackURI'
const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
const emit = (o) => OUT_HEADER.split(',').map((k) => esc(o[k] ?? (k === 'rung' ? rung(o) : ''))).join(',')

const corrected = rows.map((o) => ({ ...o, jsonValid: o.jsonValid ?? (o.fetched === 'true' && o.note !== 'not JSON' ? 'true' : 'false'), rung: rung(o) }))
const out = [OUT_HEADER, ...corrected.map(emit), ...hashOnly.map(emit)]

if (!existsSync('out/evidence-v1.csv')) copyFileSync(SRC, 'out/evidence-v1.csv')
writeFileSync(SRC, out.join('\n'))

const tally = {}
for (const o of [...corrected, ...hashOnly]) tally[o.rung] = (tally[o.rung] ?? 0) + 1
console.log(`rows      ${corrected.length} checked + ${hashOnly.length} hash-only = ${out.length - 1}`)
console.log('ladder:')
for (const [k, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(20)} ${String(n).padStart(6)}`)
}
console.log(`\nold file kept as out/evidence-v1.csv`)
