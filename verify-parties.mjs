/**
 * Confront every verified payment with the parties it is supposed to be about.
 *
 *   node verify-parties.mjs                 # reads out/evidence.csv
 *
 * `paymentVerified` only ever asked three questions: does the transaction
 * exist, did it succeed, did it move value. It never asked whether the money
 * went from the reviewer to the agent being rated — so the strongest verdict in
 * the system was also the cheapest to usurp: cite any real stablecoin transfer
 * on Celo and collect it.
 *
 * The pipeline now performs this check inline, but the question is worth
 * answering on its own, against the chain, for verdicts already published. This
 * script re-reads each transaction from a node, re-derives the agent's owner
 * from the Identity Registry, and prints who actually paid whom.
 *
 * Exits non-zero if any published PaymentVerified turns out to be a settlement
 * between parties unrelated to the review.
 */
import fs from 'node:fs'
import { createPublicClient, http, decodeEventLog, parseAbiItem, formatUnits } from 'viem'
import { celo } from 'viem/chains'
import { parseCsv } from './src/csv.mjs'

const RPC = process.env.CELO_RPC_URL ?? 'https://forno.celo.org'
const SRC = process.env.EVIDENCE_CSV ?? 'out/evidence.csv'
const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'
const TOKENS = new Map([
  ['0xceba9300f2b948710d2653dd7b07f33a8b32118c', { symbol: 'USDC', decimals: 6 }],
  ['0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e', { symbol: 'USDT', decimals: 6 }],
  ['0xd2ab3c9a02dbbab236bfec45d1d755df4267f771', { symbol: 'USAT', decimals: 6 }],
])
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
const OWNER_OF = parseAbiItem('function ownerOf(uint256 tokenId) view returns (address)')

if (!fs.existsSync(SRC)) {
  console.error(`${SRC} not found — run \`npm run audit\` first, or set EVIDENCE_CSV.`)
  process.exit(1)
}

const rows = parseCsv(fs.readFileSync(SRC, 'utf8')).filter((r) => r.paymentVerified === 'true')
if (!rows.length) {
  console.log('No verified payments in this export — nothing to attribute.')
  process.exit(0)
}

const client = createPublicClient({ chain: celo, transport: http(RPC, { retryCount: 5, retryDelay: 400 }) })
const eq = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase()

console.log(`\nverify-parties — ${rows.length} verified payment(s) via ${RPC}\n${'─'.repeat(74)}`)

const ownerCache = new Map()
async function agentOwner(agentId) {
  if (ownerCache.has(agentId)) return ownerCache.get(agentId)
  let owner = null
  try {
    owner = await client.readContract({
      address: IDENTITY_REGISTRY, abi: [OWNER_OF], functionName: 'ownerOf', args: [BigInt(agentId)],
    })
  } catch {
    // A burned or never-minted agent has no owner. That is ignorance about the
    // payee, not evidence against the payment.
    owner = null
  }
  ownerCache.set(agentId, owner)
  return owner
}

let attributed = 0
let unattributed = 0
let contradicted = 0
let unreadable = 0

for (const r of rows) {
  const label = `agent ${r.agentId} · ${r.reviewer.slice(0, 10)}… · ${(r.claimTxHash ?? '').slice(0, 12)}…`
  let receipt
  try {
    receipt = await client.getTransactionReceipt({ hash: r.claimTxHash })
  } catch (e) {
    // Never round a failed lookup down to a finding: that is the exact
    // misclassification this project exists to expose.
    unreadable++
    console.log(`  ?  ${label}\n       could not read the receipt (${e.shortMessage ?? e.message}) — no conclusion drawn`)
    continue
  }

  const legs = []
  for (const log of receipt.logs) {
    const token = TOKENS.get(log.address.toLowerCase())
    if (!token) continue
    try {
      const { args } = decodeEventLog({ abi: [TRANSFER], data: log.data, topics: log.topics })
      if (args.value > 0n) legs.push({ ...token, from: args.from.toLowerCase(), to: args.to.toLowerCase(), value: args.value })
    } catch { /* not a Transfer */ }
  }

  const owner = await agentOwner(r.agentId)
  const payerIsReviewer = legs.some((l) => eq(l.from, r.reviewer))
  const payeeIsOwner = owner ? legs.some((l) => eq(l.to, owner)) : false
  const declaredOk =
    r.declaredFrom || r.declaredTo
      ? legs.some((l) => (!r.declaredFrom || eq(l.from, r.declaredFrom)) && (!r.declaredTo || eq(l.to, r.declaredTo)))
      : null
  const strangersOnly = owner !== null && !payerIsReviewer && !payeeIsOwner && legs.length > 0

  const principal = legs.reduce((b, l) => (b === null || l.value > b.value ? l : b), null)
  const amount = principal ? `${formatUnits(principal.value, principal.decimals)} ${principal.symbol}` : 'none'

  if (payerIsReviewer && payeeIsOwner) {
    attributed++
    console.log(`  ✓  ${label}\n       ${amount} — reviewer paid the agent owner`)
  } else if (declaredOk === false || strangersOnly) {
    contradicted++
    console.log(`  ✗  ${label}\n       ${amount} — ${strangersOnly ? 'settlement touches neither the reviewer nor the agent owner' : 'the file declares parties this transfer does not contain'}`)
    console.log(`       reviewer ${r.reviewer}`)
    console.log(`       agent owner ${owner ?? '(unknown)'}`)
    for (const l of legs.slice(0, 4)) console.log(`       leg ${l.from} → ${l.to}  ${formatUnits(l.value, l.decimals)} ${l.symbol}`)
  } else {
    unattributed++
    const why = owner === null ? 'agent owner unknown' : !payerIsReviewer ? 'paid by somebody other than the reviewer' : 'payee is not the registered agent owner'
    console.log(`  ·  ${label}\n       ${amount} — settled, not attributable (${why})`)
  }
}

console.log(`${'─'.repeat(74)}`)
console.log(`  attributed     ${attributed}`)
console.log(`  unattributed   ${unattributed}`)
console.log(`  contradicted   ${contradicted}`)
if (unreadable) console.log(`  unreadable     ${unreadable}  (no conclusion drawn)`)
console.log()
if (contradicted) {
  console.log('A contradicted payment is a review pointed at somebody else\'s transaction.')
  console.log('These must not carry the top rung.\n')
}
process.exit(contradicted ? 2 : 0)
