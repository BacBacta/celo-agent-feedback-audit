/**
 * Turn three doubts about this audit into numbers, offline.
 *
 *   node counter-checks.mjs            # reads out/evidence.csv, no network
 *
 * The audit's own counter-analysis raised three objections that it answered
 * with adjectives instead of counts. Each is answerable from the exported CSV
 * alone, in seconds, with no key and no connection:
 *
 *   1. How many "unreachable" files are solidly dead (a host said 404) versus
 *      merely unproven (rate limit, timeout, a scheme we never resolved)? The
 *      headline treated both as findings.
 *   2. How many distinct payments back the payment-backed reviews? Nothing
 *      enforces uniqueness, so one real transfer can underwrite a hundred
 *      claims — and if it does, it is visible right here.
 *   3. Which networks do the not-found payments name? A transaction settled on
 *      Base is not a transaction missing from Celo.
 *
 * Exits non-zero if a check finds something that should block publication.
 */
import fs from 'node:fs'
import { parseCsv } from './src/csv.mjs'

const SRC = process.env.EVIDENCE_CSV ?? 'out/evidence.csv'
if (!fs.existsSync(SRC)) {
  console.error(`${SRC} not found — run \`npm run audit\` first, or set EVIDENCE_CSV.`)
  process.exit(1)
}

const rows = parseCsv(fs.readFileSync(SRC, 'utf8'))
const pct = (n, d) => (d === 0 ? '0.0%' : `${((n / d) * 100).toFixed(1)}%`)
const bar = (n, d, width = 28) => '█'.repeat(Math.round((d ? n / d : 0) * width)).padEnd(width, '·')

console.log(`\ncounter-checks — ${rows.length} rows from ${SRC}\n${'─'.repeat(64)}`)

let blocking = 0

// ---------------------------------------------------------------------------
// 1. What is actually dead, and what did we merely fail to reach?
// ---------------------------------------------------------------------------
const negatives = rows.filter((r) => r.rung === 'EvidenceUnreachable' || r.rung === 'EvidenceInconclusive')
const byCause = new Map()
for (const r of negatives) {
  const note = (r.note ?? '').trim() || '(no note)'
  // Group by cause, not by message: "HTTP 404" and "HTTP 410" are the same
  // kind of fact, and "429" and "timeout" are the same kind of non-fact.
  const cause = /HTTP 404|HTTP 410|HTTP 451/.test(note) ? 'dead — host asserts absence'
    : /HTTP 4\d\d/.test(note) ? 'refused — host declined to serve'
    : /oversize/.test(note) ? 'oversize — body above the cap'
    : /unresolvable URI scheme/.test(note) ? 'unresolvable — no transport for this scheme'
    : /refused private/.test(note) ? 'refused — pointed inside our own network'
    : /429|timeout|inconclusive|fetch failed|HTTP 5\d\d/.test(note) ? 'INCONCLUSIVE — proves nothing'
    : /not checked/.test(note) ? 'INCONCLUSIVE — never attempted (sampling cap)'
    : note
  byCause.set(cause, (byCause.get(cause) ?? 0) + 1)
}

console.log(`\n1. The ${negatives.length} negative verdicts, by cause`)
if (!negatives.length) console.log('   none')
const sortedCauses = [...byCause.entries()].sort((a, b) => b[1] - a[1])
let inconclusive = 0
for (const [cause, n] of sortedCauses) {
  if (cause.startsWith('INCONCLUSIVE')) inconclusive += n
  console.log(`   ${bar(n, negatives.length)} ${String(n).padStart(6)}  ${pct(n, negatives.length).padStart(6)}  ${cause}`)
}
if (inconclusive) {
  console.log(`\n   ${inconclusive} of ${negatives.length} (${pct(inconclusive, negatives.length)}) prove nothing about the file.`)
  console.log('   These must not be published as dead links.')
}

// ---------------------------------------------------------------------------
// 2. Is one payment underwriting many reviews?
// ---------------------------------------------------------------------------
const withTx = rows.filter((r) => (r.claimTxHash ?? '').trim() !== '')
const byTx = new Map()
for (const r of withTx) {
  const k = r.claimTxHash.toLowerCase()
  if (!byTx.has(k)) byTx.set(k, [])
  byTx.get(k).push(r)
}
const reused = [...byTx.entries()].filter(([, rs]) => rs.length > 1).sort((a, b) => b[1].length - a[1].length)

console.log(`\n2. Payment reuse — ${byTx.size} distinct transactions across ${withTx.length} claims`)
if (!reused.length) {
  console.log('   no transaction is cited by more than one review')
} else {
  blocking++
  console.log(`   ${reused.length} transaction(s) cited by more than one review:`)
  for (const [tx, rs] of reused.slice(0, 15)) {
    const reviewers = new Set(rs.map((r) => (r.reviewer ?? '').toLowerCase()))
    const agents = new Set(rs.map((r) => r.agentId))
    console.log(`     ${tx.slice(0, 18)}…  ${String(rs.length).padStart(4)} reviews  ` +
      `${reviewers.size} reviewer(s)  ${agents.size} agent(s)`)
  }
  if (reused.length > 15) console.log(`     … and ${reused.length - 15} more`)
  console.log('\n   A payment cited by several reviews backs at most one of them.')
}

// ---------------------------------------------------------------------------
// 3. What networks do the "missing" payments actually name?
// ---------------------------------------------------------------------------
const notFound = rows.filter((r) => r.rung === 'PaymentTxNotFound' || r.rung === 'PaymentForeignChain')
const byNetwork = new Map()
for (const r of notFound) {
  const n = (r.claimNetwork ?? '').trim() || '(undeclared)'
  byNetwork.set(n, (byNetwork.get(n) ?? 0) + 1)
}
console.log(`\n3. The ${notFound.length} unfound payments, by declared network`)
if (!notFound.length) console.log('   none')
for (const [net, n] of [...byNetwork.entries()].sort((a, b) => b[1] - a[1])) {
  const queryable = net === '(undeclared)' || /^(42220|celo|celo-mainnet)$/i.test(net)
  console.log(`   ${String(n).padStart(6)}  ${net.padEnd(22)} ${queryable ? '' : '← never queried; "not found" was never tested'}`)
}

// ---------------------------------------------------------------------------
// 4. Attribution — is the top rung actually earned?
// ---------------------------------------------------------------------------
const verified = rows.filter((r) => r.paymentVerified === 'true')
const attributed = rows.filter((r) => r.paymentAttributed === 'true')
const mismatched = rows.filter((r) => r.partiesContradicted === 'true')
console.log(`\n4. Attribution of the ${verified.length} verified payments`)
console.log(`   ${String(attributed.length).padStart(6)}  paid by this reviewer to this agent (attributed)`)
console.log(`   ${String(mismatched.length).padStart(6)}  parties contradict the claim`)
console.log(`   ${String(verified.length - attributed.length - mismatched.length).padStart(6)}  settled but unattributable`)
if (verified.length && !rows.some((r) => 'paymentAttributed' in r)) {
  console.log('   (this export predates party checking — re-run the audit)')
}

console.log(`\n${'─'.repeat(64)}`)
console.log(blocking ? `${blocking} check(s) found something that needs saying out loud.\n`
                     : 'No blocking finding.\n')
process.exit(blocking ? 2 : 0)
