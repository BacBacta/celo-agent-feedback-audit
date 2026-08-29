/**
 * Analysis unit tests. The indexing layer needs a live chain, but the maths
 * that produces the headline numbers must be correct regardless of who runs it,
 * so it is tested against fixtures with known answers.
 *
 *   npx tsx test/analysis.test.ts
 */
import assert from 'node:assert/strict'
import type { Address, Hex } from 'viem'
import { gini, concentration, findBursts } from '../src/analysis/concentration.js'
import { reconcile, summarize } from '../src/analysis/reconcile.js'
import { extractPaymentClaim } from '../src/analysis/payment.js'
import { classifyFailure } from '../src/rpc.js'
import type { FeedbackRecord } from '../src/sources/feedback.js'
import type { Settlement } from '../src/sources/settlements.js'

let passed = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    console.error(`  ✗ ${name}`)
    throw e
  }
}

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address

function fb(over: Partial<FeedbackRecord> = {}): FeedbackRecord {
  return {
    agentId: 1n,
    reviewer: addr(1),
    feedbackIndex: 0n,
    value: 100n,
    valueDecimals: 0,
    tag1: '',
    tag2: '',
    endpoint: '',
    feedbackURI: '',
    feedbackHash: ('0x' + '0'.repeat(64)) as Hex,
    blockNumber: 1n,
    timestamp: 1000,
    txHash: ('0x' + '1'.repeat(64)) as Hex,
    revoked: false,
    hasEvidencePointer: false,
    ...over,
  }
}

function st(payer: Address, payee: Address, timestamp: number): Settlement {
  return {
    payer: payer.toLowerCase() as Address,
    payee: payee.toLowerCase() as Address,
    amount: 1_000_000n,
    symbol: 'USDC',
    decimals: 6,
    blockNumber: 1n,
    timestamp,
    txHash: ('0x' + '2'.repeat(64)) as Hex,
    gaslessAuthorized: true,
  }
}

console.log('\nconcentration')

check('gini is 0 when every reviewer contributes equally', () => {
  assert.equal(gini([5, 5, 5, 5]), 0)
})

check('gini approaches 1 when one address writes almost everything', () => {
  const g = gini([1, 1, 1, 997])
  assert.ok(g > 0.7, `expected > 0.7, got ${g}`)
})

check('gini handles the empty and zero cases without dividing by zero', () => {
  assert.equal(gini([]), 0)
  assert.equal(gini([0, 0]), 0)
})

check('one-shot rate counts reviewers, not reviews', () => {
  // 3 reviewers: one wrote 8, two wrote 1 each.
  const c = concentration([...Array(8).fill('a'), 'b', 'c'])
  assert.equal(c.distinctReviewers, 3)
  assert.equal(c.maxBySingleReviewer, 8)
  assert.ok(Math.abs(c.oneShotReviewerRate - 2 / 3) < 1e-9)
})

console.log('\nbursts')

check('a tight cluster of one-shot reviewers is detected', () => {
  const events = [0, 10, 20, 30, 40].map((t, i) => ({ timestamp: 1000 + t, reviewer: `r${i}` }))
  const [b] = findBursts(events, 300, 5)
  assert.ok(b, 'expected one burst')
  assert.equal(b!.count, 5)
  assert.equal(b!.distinctReviewers, 5)
  assert.equal(b!.oneShotReviewers, 5)
})

check('activity spread beyond the window is not a burst', () => {
  const events = [0, 400, 800, 1200, 1600].map((t, i) => ({ timestamp: 1000 + t, reviewer: `r${i}` }))
  assert.equal(findBursts(events, 300, 5).length, 0)
})

check('a reviewer active elsewhere is not counted as one-shot inside a burst', () => {
  const events = [
    ...[0, 10, 20, 30, 40].map((t, i) => ({ timestamp: 1000 + t, reviewer: `r${i}` })),
    { timestamp: 99_999, reviewer: 'r0' },
  ]
  const [b] = findBursts(events, 300, 5)
  assert.equal(b!.oneShotReviewers, 4)
})

console.log('\nreconciliation')

const identity = {
  owners: new Map([['1', addr(9)], ['2', addr(8)]]),
  registeredAt: new Map([['1', 1n], ['2', 1n]]),
  operators: new Set([addr(9).toLowerCase(), addr(8).toLowerCase()]),
}

check('a payment before the review counts as backing', () => {
  const rows = reconcile({
    feedback: [fb({ reviewer: addr(1), agentId: 1n, timestamp: 2000 })],
    settlements: [st(addr(1), addr(9), 1500)],
    identity,
    selfVerified: new Set(),
  })
  assert.ok(rows[0]!.backingSettlement)
  assert.equal(rows[0]!.paidAfterReview, false)
})

check('a payment after the review does NOT count as backing', () => {
  const rows = reconcile({
    feedback: [fb({ reviewer: addr(1), agentId: 1n, timestamp: 2000 })],
    settlements: [st(addr(1), addr(9), 2500)],
    identity,
    selfVerified: new Set(),
  })
  assert.equal(rows[0]!.backingSettlement, null)
  assert.equal(rows[0]!.paidAfterReview, true)
})

check('paying a different agent does not back this review', () => {
  const rows = reconcile({
    feedback: [fb({ reviewer: addr(1), agentId: 1n, timestamp: 2000 })],
    settlements: [st(addr(1), addr(8), 1500)],
    identity,
    selfVerified: new Set(),
  })
  assert.equal(rows[0]!.backingSettlement, null)
})

check('the most recent qualifying payment is the one attributed', () => {
  const rows = reconcile({
    feedback: [fb({ reviewer: addr(1), agentId: 1n, timestamp: 3000 })],
    settlements: [st(addr(1), addr(9), 1000), st(addr(1), addr(9), 2000)],
    identity,
    selfVerified: new Set(),
  })
  assert.equal(rows[0]!.backingSettlement!.timestamp, 2000)
})

check('reviewing an agent you own is flagged as self-dealing', () => {
  const rows = reconcile({
    feedback: [fb({ reviewer: addr(9), agentId: 1n, timestamp: 2000 })],
    settlements: [],
    identity,
    selfVerified: new Set(),
  })
  assert.equal(rows[0]!.selfDealing, true)
})

check('address casing does not break matching', () => {
  const rows = reconcile({
    feedback: [fb({ reviewer: addr(1).toUpperCase() as Address, agentId: 1n, timestamp: 2000 })],
    settlements: [st(addr(1), addr(9), 1500)],
    identity,
    selfVerified: new Set([addr(1).toLowerCase()]),
  })
  assert.ok(rows[0]!.backingSettlement, 'settlement should match despite casing')
  assert.equal(rows[0]!.humanBacked, true)
})

check('summary rates are consistent with the rows', () => {
  const rows = reconcile({
    feedback: [
      fb({ reviewer: addr(1), agentId: 1n, timestamp: 2000 }),
      fb({ reviewer: addr(2), agentId: 1n, timestamp: 2000 }),
    ],
    settlements: [st(addr(1), addr(9), 1500)],
    identity,
    selfVerified: new Set([addr(1).toLowerCase()]),
  })
  const s = summarize(rows)
  assert.equal(s.total, 2)
  assert.equal(s.backed, 1)
  assert.equal(s.backedRate, 0.5)
  assert.equal(s.humanBacked, 1)
  assert.equal(s.backedAndHumanBacked, 1)
})



console.log('\nevidence classification')

check('a hash with no URI is not counted as retrievable evidence', () => {
  const r = fb({ feedbackURI: '', feedbackHash: ('0x' + 'a'.repeat(64)) as Hex })
  const hasURI = r.feedbackURI.trim().length > 0
  const hasHash = r.feedbackHash !== (('0x' + '0'.repeat(64)) as Hex)
  assert.equal(hasURI, false)
  assert.equal(hasHash, true)
})

check('an empty record declares neither', () => {
  const r = fb()
  assert.equal(r.feedbackURI.trim().length > 0, false)
  assert.equal(r.feedbackHash !== (('0x' + '0'.repeat(64)) as Hex), false)
})


console.log('\npayment claim extraction')

check('reads the ERC-8004 spec shape', () => {
  const c = extractPaymentClaim({
    proofOfPayment: { txHash: '0xabc', chainId: 42220, fromAddress: '0x1', toAddress: '0x2' },
  })
  assert.equal(c.txHash, '0xabc')
  assert.equal(c.shape, 'erc8004')
  assert.equal(c.network, '42220')
})

check('reads the snake_case payment_tx shape found in the wild', () => {
  // Real structure observed on execution.market feedback files, Aug 2026.
  const c = extractPaymentClaim({
    network: 'celo',
    proof_of_payment: { network: 'celo', payment_tx: '0xdef', status: 'anchored' },
    rating: { target_address: '0x945659f0eb9c34487b0c0f61ed7e9d279ace8f09' },
    transactions: { payment_tx: '0xdef', reputation_tx: '' },
  })
  assert.equal(c.txHash, '0xdef')
  assert.equal(c.shape, 'proof_of_payment.payment_tx')
  assert.equal(c.network, 'celo')
  assert.equal(c.declaredTo, '0x945659f0eb9c34487b0c0f61ed7e9d279ace8f09')
})

check('falls back to the transactions block', () => {
  const c = extractPaymentClaim({ transactions: { payment_tx: '0x123' } })
  assert.equal(c.txHash, '0x123')
  assert.equal(c.shape, 'transactions.payment_tx')
})

check('a file with no claim yields nothing rather than throwing', () => {
  const c = extractPaymentClaim({ comment: 'good work' })
  assert.equal(c.txHash, null)
  assert.equal(c.shape, null)
})

check('an empty reputation_tx is not mistaken for a payment', () => {
  const c = extractPaymentClaim({ transactions: { payment_tx: '', reputation_tx: '' } })
  assert.equal(c.txHash, null)
})



console.log('\nRPC failure classification')

check('forno range rejection is a range limit', () => {
  assert.equal(
    classifyFailure({ details: 'query exceeds range, retry smaller (max block range 5000, got 49999)' }),
    'range',
  )
})

check('a free-tier 10-block cap is a range limit', () => {
  assert.equal(
    classifyFailure({ details: 'Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.' }),
    'range',
  )
})

check('HTTP 429 is a rate limit, not a range problem', () => {
  assert.equal(classifyFailure({ status: 429, message: 'HTTP request failed' }), 'rate')
})

check('the -32005 code is a rate limit', () => {
  assert.equal(classifyFailure({ code: -32005, message: 'limit exceeded' }), 'rate')
})

check('an oversized result set is a data problem, not an endpoint one', () => {
  assert.equal(classifyFailure({ message: 'query returned more than 10000 results' }), 'size')
  assert.equal(classifyFailure({ details: 'Log response size exceeded' }), 'size')
})

check('a rate limit is never misread as a range limit', () => {
  // The bug this classification exists to prevent: shrinking the window in
  // response to throttling, which increases request count and makes it worse.
  assert.notEqual(classifyFailure({ status: 429, message: 'Too Many Requests' }), 'range')
})

check('an unrecognised error stays unknown rather than being guessed at', () => {
  assert.equal(classifyFailure({ message: 'socket hang up' }), 'unknown')
})



console.log('\nevidence sampling')

// The bug this replaces: slice(0, n) on a block-ordered array samples only the
// oldest cohort, which reported 0% payment claims for a period whose recent
// half is 100%.
function sample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items
  const stride = Math.ceil(items.length / max)
  return items.filter((_, i) => i % stride === 0).slice(0, max)
}

check('a sample spans the whole range, not just its start', () => {
  const items = Array.from({ length: 6586 }, (_, i) => i)
  const picked = sample(items, 2000)
  assert.ok(picked.length <= 2000)
  assert.equal(picked[0], 0)
  // The decisive property: the last element must come from the far end.
  assert.ok(picked[picked.length - 1]! > 6000, `last picked was ${picked[picked.length - 1]}`)
})

check('a truncating sample would have missed the recent half entirely', () => {
  const items = Array.from({ length: 6586 }, (_, i) => i)
  const truncated = items.slice(0, 2000)
  assert.ok(truncated[truncated.length - 1]! < 3293, 'slice never reaches the second half')
})

check('everything is returned when it fits under the cap', () => {
  const items = [1, 2, 3]
  assert.deepEqual(sample(items, 2000), items)
})

check('the sample is deterministic, so the audit is reproducible', () => {
  const items = Array.from({ length: 5000 }, (_, i) => i)
  assert.deepEqual(sample(items, 500), sample(items, 500))
})

console.log(`\n${passed} passed\n`)

console.log('\nlog deduplication')

import('../src/rpc.js').then(({ dedupeLogs }) => {
  check('an exact duplicate from a resume overlap is removed', () => {
    const logs = [
      { transactionHash: '0xaa', logIndex: 1, v: 'first' },
      { transactionHash: '0xaa', logIndex: 1, v: 'dup' },
      { transactionHash: '0xaa', logIndex: 2, v: 'other-log-same-tx' },
      { transactionHash: '0xbb', logIndex: 1, v: 'other-tx' },
    ]
    const out = dedupeLogs(logs)
    assert.equal(out.length, 3)
    assert.equal((out[0] as any).v, 'first')
  })

  check('two logs of the same transaction are both kept', () => {
    const out = dedupeLogs([
      { transactionHash: '0xcc', logIndex: 0 },
      { transactionHash: '0xcc', logIndex: 1 },
    ])
    assert.equal(out.length, 2)
  })

  console.log(`\n${passed} passed (async suite)\n`)
})

console.log('\nevidence ladder mapping')

import('../src/report.js').then(({ rung, evidenceRung, RUNG_ORDER }) => {
  const rec = (hasURI: boolean, hasHash = true) => ({ hasURI, hasHash })
  const v = (o: Partial<{ fetched: boolean; jsonValid: boolean; hashMatches: boolean; claimsPayment: boolean; txExists: boolean; paymentVerified: boolean; note: string }>) => ({
    fetched: false, jsonValid: false, hashMatches: false, claimsPayment: false, txExists: false, paymentVerified: false, ...o,
  })

  check('a verified payment is the top rung', () => {
    assert.equal(rung(rec(true), v({ fetched: true, claimsPayment: true, txExists: true, paymentVerified: true })), 'PaymentVerified')
  })

  check('a declared payment that is not on chain is named as such', () => {
    assert.equal(rung(rec(true), v({ fetched: true, claimsPayment: true, txExists: false })), 'PaymentTxNotFound')
  })

  check('a zero-value settlement is distinguished from a failed one', () => {
    assert.equal(rung(rec(true), v({ fetched: true, claimsPayment: true, txExists: true, note: 'transfer of zero' })), 'PaymentNoValue')
    assert.equal(rung(rec(true), v({ fetched: true, claimsPayment: true, txExists: true, note: 'reverted' })), 'PaymentTxFailed')
  })

  check('a file that resolves and hash-matches without a payment is intact, not a failure', () => {
    assert.equal(rung(rec(true), v({ fetched: true, jsonValid: true, hashMatches: true })), 'EvidenceIntact')
  })

  check('a real mismatch requires a real hash and real JSON', () => {
    assert.equal(rung(rec(true), v({ fetched: true, jsonValid: true, hashMatches: false })), 'EvidenceUnhashed')
  })

  check('a soft-404 — HTML behind HTTP 200 — is a dead file, not a mismatched one', () => {
    // The bug this ladder revision exists for: 1,582 of 2,055 "mismatches"
    // were CDN error pages counted as altered evidence.
    assert.equal(rung(rec(true), v({ fetched: true, jsonValid: false, note: 'not JSON' })), 'EvidenceUnreachable')
  })

  check('a live valid file with no attested hash is unbound, not mismatched', () => {
    assert.equal(rung(rec(true, false), v({ fetched: true, jsonValid: true })), 'EvidenceUnbound')
  })

  check('a declared file that no longer resolves is unreachable', () => {
    assert.equal(rung(rec(true), v({})), 'EvidenceUnreachable')
  })

  check('a hash attested with no file at all is the bottom rung', () => {
    assert.equal(rung(rec(false), v({})), 'EvidenceAbsent')
  })

  check('an attributed settlement outranks a merely verified one', () => {
    assert.equal(
      rung(rec(true), v({ fetched: true, jsonValid: true, claimsPayment: true, txExists: true, paymentVerified: true, paymentAttributed: true })),
      'PaymentAttributed',
    )
  })

  check('a settlement whose parties contradict the claim is demoted, not promoted', () => {
    assert.equal(
      rung(rec(true), v({ fetched: true, jsonValid: true, claimsPayment: true, txExists: true, paymentVerified: true, partiesContradicted: true })),
      'PaymentPartyMismatch',
    )
  })

  check('a payment declared on another chain is not reported as missing from this one', () => {
    // "Not found on Celo" about a Base transaction is a finding we never made.
    assert.equal(
      rung(rec(true), v({ fetched: true, jsonValid: true, claimsPayment: true, txExists: false, onQueryableChain: false })),
      'PaymentForeignChain',
    )
  })

  check('a retrieval that was rate-limited is inconclusive, never a dead link', () => {
    assert.equal(rung(rec(true), v({ inconclusive: true })), 'EvidenceInconclusive')
  })

  check('inconclusive never outranks a file we actually read', () => {
    assert.equal(
      rung(rec(true), v({ fetched: true, jsonValid: true, hashMatches: true, inconclusive: false })),
      'EvidenceIntact',
    )
  })

  check('the evidence dimension survives a payment verdict that would mask it', () => {
    // The whole point of the second column: a record whose headline is a
    // payment still records whether its file was intact.
    const withPayment = v({ fetched: true, jsonValid: true, hashMatches: true, claimsPayment: true, txExists: true, paymentVerified: true, paymentAttributed: true })
    assert.equal(rung(rec(true), withPayment), 'PaymentAttributed')
    assert.equal(evidenceRung(rec(true), withPayment), 'Intact')
  })

  check('every rung name has an on-chain enum slot, and the order is append-only', () => {
    for (const name of ['PaymentAttributed', 'PaymentPartyMismatch', 'PaymentForeignChain', 'EvidenceInconclusive']) {
      assert.ok(RUNG_ORDER.includes(name as never), `${name} missing from RUNG_ORDER`)
    }
    // The first ten values are already published on chain under these names.
    assert.deepEqual(RUNG_ORDER.slice(0, 10), [
      'None', 'PaymentVerified', 'EvidenceIntact', 'EvidenceUnbound', 'EvidenceUnhashed',
      'PaymentTxNotFound', 'PaymentTxFailed', 'PaymentNoValue', 'EvidenceUnreachable', 'EvidenceAbsent',
    ])
  })

  console.log(`\n${passed} passed (with ladder)\n`)
})

// ---------------------------------------------------------------------------

console.log('\nSSRF guard')

const { isPrivateAddress, resolveTargets } = await import('../src/net/fetch-evidence.js')

check('loopback, link-local and RFC1918 space are refused', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '172.31.255.255',
                    '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fe80::1', 'fd00::1',
                    '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be refused`)
  }
})

check('ordinary public addresses are allowed through', () => {
  for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '192.169.0.1', '2606:4700::1']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be allowed`)
  }
})

check('the cloud metadata endpoint is refused specifically', () => {
  // The single most valuable SSRF target on any hosted runner.
  assert.equal(isPrivateAddress('169.254.169.254'), true)
})

check('IPv4-mapped IPv6 is refused in the spelling new URL actually produces', () => {
  /**
   * The bypass that made the whole guard decorative. `new URL()` normalises
   * ::ffff:127.0.0.1 to ::ffff:7f00:1, so a check matching only the dotted
   * spelling could never fire on a hostname taken from a parsed URL — and
   * http://[::ffff:a9fe:a9fe]/ walked straight to the metadata endpoint.
   */
  assert.equal(new URL('http://[::ffff:127.0.0.1]/').hostname, '[::ffff:7f00:1]')
  for (const ip of ['::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:0a00:1', '::ffff:c0a8:1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be refused`)
  }
})

check('link-local and unique-local cover their whole ranges, not just one prefix', () => {
  // fe80::/10 is fe80 through febf, not fe80 alone.
  for (const ip of ['fe80::1', 'fe90::1', 'feab::1', 'fc00::1', 'fd12:3456::1', '64:ff9b::7f00:1']) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be refused`)
  }
})

check('public IPv6 is still reachable', () => {
  for (const ip of ['2606:4700::1', '2001:4860:4860::8888', 'fe00::1']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be allowed`)
  }
})

const GATEWAYS = await import('../src/config.js')

console.log('\nURI resolution')

check('a content-addressed URI fans out across independent gateways', () => {
  const { targets, scheme } = resolveTargets('ipfs://bafyfake')
  assert.equal(scheme, 'ipfs')
  assert.ok(targets.length > 1, 'one gateway is not a measurement')
  assert.ok(targets.every((t) => t.endsWith('bafyfake')))
})

check('scheme comparison is case-insensitive', () => {
  // `HTTPS://` and `IPFS://` are valid and were previously called unresolvable.
  assert.equal(resolveTargets('HTTPS://example.test/a.json').scheme, 'http')
  assert.equal(resolveTargets('IPFS://bafyfake').scheme, 'ipfs')
})

check('Arweave and data URIs resolve instead of being written off', () => {
  assert.equal(resolveTargets('ar://abc').scheme, 'ar')
  assert.ok(resolveTargets('ar://abc').targets.length >= 1)
  assert.equal(resolveTargets('data:application/json,{}').scheme, 'data')
})

check('the gateway list contains no host that has stopped existing', () => {
  /**
   * A dead entry is not free. cloudflare-ipfs.com shipped in this list and has
   * since been retired: it spent an attempt on every content-addressed file,
   * and — until the classification was fixed — its DNS failure was recorded as
   * a fact about the file rather than about the gateway, writing live evidence
   * off as a dead link.
   */
  const { IPFS_GATEWAYS, ARWEAVE_GATEWAYS } = GATEWAYS
  for (const g of [...IPFS_GATEWAYS, ...ARWEAVE_GATEWAYS]) {
    assert.doesNotMatch(g, /cloudflare-ipfs\.com/, 'cloudflare retired this gateway')
    assert.match(g, /^https:\/\/[^/]+\//, `${g} should be an https gateway prefix`)
  }
  assert.ok(IPFS_GATEWAYS.length >= 2, 'one gateway is not a measurement')
})

check('a scheme with no transport is named, not silently dropped', () => {
  const { targets, scheme } = resolveTargets('magnet:?xt=urn:btih:abc')
  assert.equal(targets.length, 0)
  assert.equal(scheme, 'magnet')
})

console.log('\npayment attribution')

const { matchParties, isQueryableNetwork } = await import('../src/analysis/payment.js')

const REVIEWER_A = '0xaaaa000000000000000000000000000000000001'
const AGENT_OWNER = '0xbbbb000000000000000000000000000000000002'
const STRANGER_1 = '0xcccc000000000000000000000000000000000003'
const STRANGER_2 = '0xdddd000000000000000000000000000000000004'

const settled = (from: string, to: string) => ({
  exists: true, succeeded: true, movedValue: true,
  amount: 1_000_000n, symbol: 'USDC', decimals: 6,
  token: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C' as Address,
  from: from as Address, to: to as Address,
  transfers: [{ token: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C' as Address, symbol: 'USDC', decimals: 6, from: from as Address, to: to as Address, value: 1_000_000n }],
  onQueryableChain: true,
})

check('a settlement from the reviewer to the agent owner is attributed', () => {
  const m = matchParties({ check: settled(REVIEWER_A, AGENT_OWNER), reviewer: REVIEWER_A, agentOwner: AGENT_OWNER, declaredFrom: null, declaredTo: null })
  assert.equal(m.attributed, true)
  assert.equal(m.contradicted, false)
})

check('citing a transfer between two strangers is a contradiction, not a verification', () => {
  // The §3.1 attack in its pure form: point at any real payment on the chain.
  const m = matchParties({ check: settled(STRANGER_1, STRANGER_2), reviewer: REVIEWER_A, agentOwner: AGENT_OWNER, declaredFrom: null, declaredTo: null })
  assert.equal(m.attributed, false)
  assert.equal(m.contradicted, true)
})

check('a platform paying on the reviewer\'s behalf is unattributed, never accused', () => {
  // Legitimate and common: the payer is the platform treasury, the payee is
  // still the agent. Convicting this would convict the honest majority.
  const m = matchParties({ check: settled(STRANGER_1, AGENT_OWNER), reviewer: REVIEWER_A, agentOwner: AGENT_OWNER, declaredFrom: null, declaredTo: null })
  assert.equal(m.attributed, false)
  assert.equal(m.contradicted, false)
})

check('an unknown agent owner yields ignorance, not attribution and not accusation', () => {
  const m = matchParties({ check: settled(REVIEWER_A, STRANGER_2), reviewer: REVIEWER_A, agentOwner: null, declaredFrom: null, declaredTo: null })
  assert.equal(m.attributed, false)
  assert.equal(m.contradicted, false)
})

check('a file whose declared parties the transfer denies is caught', () => {
  const m = matchParties({ check: settled(REVIEWER_A, AGENT_OWNER), reviewer: REVIEWER_A, agentOwner: AGENT_OWNER, declaredFrom: STRANGER_1, declaredTo: null })
  assert.equal(m.declarationHonest, false)
  assert.equal(m.contradicted, true)
})

check('a reviewer paying an agent it owns is not attribution', () => {
  // Otherwise the strongest rung in the system costs one self-transfer of dust:
  // both ends match trivially when the reviewer IS the agent owner.
  const m = matchParties({ check: settled(REVIEWER_A, REVIEWER_A), reviewer: REVIEWER_A, agentOwner: REVIEWER_A, declaredFrom: null, declaredTo: null })
  assert.equal(m.attributed, false)
  assert.match(m.note, /self-payment/)
})

check('a transfer to its own sender carries no attribution', () => {
  const m = matchParties({ check: settled(AGENT_OWNER, AGENT_OWNER), reviewer: REVIEWER_A, agentOwner: AGENT_OWNER, declaredFrom: null, declaredTo: null })
  assert.equal(m.attributed, false)
})

check('a routed payment still attributes, and says it was routed', () => {
  // Reviewer pays an intermediary, the intermediary pays the agent: two legs,
  // one real settlement. Refusing this would convict ordinary platform routing.
  const routed = {
    ...settled(REVIEWER_A, STRANGER_1),
    transfers: [
      { token: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C' as Address, symbol: 'USDC', decimals: 6, from: REVIEWER_A as Address, to: STRANGER_1 as Address, value: 1_000_000n },
      { token: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C' as Address, symbol: 'USDC', decimals: 6, from: STRANGER_1 as Address, to: AGENT_OWNER as Address, value: 990_000n },
    ],
  }
  const m = matchParties({ check: routed, reviewer: REVIEWER_A, agentOwner: AGENT_OWNER, declaredFrom: null, declaredTo: null })
  assert.equal(m.attributed, true)
  assert.match(m.note, /through intermediaries/)
})

check('the attributed amount is bounded by what the agent actually received', () => {
  /**
   * The inflation attack. One transaction, two legs: 500 USDC to the
   * reviewer's own second address, and one millionth of a dollar to the agent.
   * Both ends of the attribution check pass. Publishing the transaction's
   * largest transfer would advertise 500 USDC of backing for a review that paid
   * the agent 0.000001, and a consumer filtering at 500 would admit it.
   */
  const USDC = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C' as Address
  const inflated = {
    ...settled(REVIEWER_A, AGENT_OWNER),
    amount: 500_000_000n,
    transfers: [
      { token: USDC, symbol: 'USDC', decimals: 6, from: REVIEWER_A as Address, to: '0xaaaa000000000000000000000000000000000099' as Address, value: 500_000_000n },
      { token: USDC, symbol: 'USDC', decimals: 6, from: REVIEWER_A as Address, to: AGENT_OWNER as Address, value: 1n },
    ],
  }
  const m = matchParties({ check: inflated, reviewer: REVIEWER_A, agentOwner: AGENT_OWNER, declaredFrom: null, declaredTo: null })
  assert.equal(m.attributed, true, 'the agent was paid, so attribution holds')
  assert.equal(m.attributedAmount, 1n, 'but only for what it actually received')
  assert.equal(m.attributedToken?.toLowerCase(), USDC.toLowerCase())
})

check('an ordinary single-leg payment reports its full value', () => {
  const m = matchParties({ check: settled(REVIEWER_A, AGENT_OWNER), reviewer: REVIEWER_A, agentOwner: AGENT_OWNER, declaredFrom: null, declaredTo: null })
  assert.equal(m.attributed, true)
  assert.equal(m.attributedAmount, 1_000_000n)
})

check('a routed payment is bounded by the smaller of the two hops', () => {
  const USDC = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C' as Address
  const routed = {
    ...settled(REVIEWER_A, STRANGER_1),
    transfers: [
      { token: USDC, symbol: 'USDC', decimals: 6, from: REVIEWER_A as Address, to: STRANGER_1 as Address, value: 1_000_000n },
      { token: USDC, symbol: 'USDC', decimals: 6, from: STRANGER_1 as Address, to: AGENT_OWNER as Address, value: 990_000n },
    ],
  }
  const m = matchParties({ check: routed, reviewer: REVIEWER_A, agentOwner: AGENT_OWNER, declaredFrom: null, declaredTo: null })
  assert.equal(m.attributed, true)
  assert.equal(m.attributedAmount, 990_000n, 'the agent received 990,000, so that is the backing')
})

check('a file honestly declaring a routed payment is not accused', () => {
  // declarationHonest used to require both declared parties on ONE leg, so a
  // correct declaration of a routed payment was marked self-contradicting.
  const USDC = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C' as Address
  const routed = {
    ...settled(REVIEWER_A, STRANGER_1),
    transfers: [
      { token: USDC, symbol: 'USDC', decimals: 6, from: REVIEWER_A as Address, to: STRANGER_1 as Address, value: 1_000_000n },
      { token: USDC, symbol: 'USDC', decimals: 6, from: STRANGER_1 as Address, to: AGENT_OWNER as Address, value: 990_000n },
    ],
  }
  const m = matchParties({ check: routed, reviewer: REVIEWER_A, agentOwner: AGENT_OWNER, declaredFrom: REVIEWER_A, declaredTo: AGENT_OWNER })
  assert.equal(m.declarationHonest, true)
  assert.equal(m.contradicted, false)
})

const USDC_ADDR = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C' as Address
const leg = (from: string, to: string, value: bigint) =>
  ({ token: USDC_ADDR, symbol: 'USDC', decimals: 6, from: from as Address, to: to as Address, value })

check('two unconnected legs in one transaction are not a payment path', () => {
  /**
   * What checking the two ends independently allowed: the reviewer pays one
   * address, an unrelated address pays the agent, and nothing joins them.
   * "The reviewer paid someone" and "someone paid the agent" are both true; no
   * value can have gone from one to the other.
   */
  const disconnected = {
    ...settled(REVIEWER_A, AGENT_OWNER),
    transfers: [leg(REVIEWER_A, STRANGER_1, 1_000_000n), leg(STRANGER_2, AGENT_OWNER, 1_000_000n)],
  }
  const m = matchParties({ check: disconnected, reviewer: REVIEWER_A, agentOwner: AGENT_OWNER, declaredFrom: null, declaredTo: null })
  assert.equal(m.payerIsReviewer, true, 'the reviewer did pay someone')
  assert.equal(m.payeeIsAgentOwner, true, 'and the agent was paid by someone')
  assert.equal(m.attributed, false, 'but not by any path between them')
  assert.match(m.note, /unconnected transfers/)
})

check('a connected path carrying dust is attributed for the dust, not for the decoy', () => {
  /**
   * The other half of the same attack, and the reason the amount is bounded
   * rather than the rung refused. Here the legs DO connect, so a payment of one
   * millionth of a dollar really did reach the agent — through addresses that
   * also moved a thousand dollars between themselves. On chain that is
   * indistinguishable from a genuine tiny routed payment, so the honest answer
   * is to attribute it and publish what it was actually worth.
   */
  const decoy = {
    ...settled(REVIEWER_A, AGENT_OWNER),
    transfers: [
      leg(STRANGER_1, STRANGER_2, 1_000_000_000n),
      leg(REVIEWER_A, STRANGER_1, 1n),
      leg(STRANGER_2, AGENT_OWNER, 1n),
    ],
  }
  const m = matchParties({ check: decoy, reviewer: REVIEWER_A, agentOwner: AGENT_OWNER, declaredFrom: null, declaredTo: null })
  assert.equal(m.attributed, true)
  assert.equal(m.attributedAmount, 1n, 'the decoy leg backs nothing')
})

check('a genuine multi-hop route is still attributed, and bounded', () => {
  const routed = {
    ...settled(REVIEWER_A, STRANGER_1),
    transfers: [
      leg(REVIEWER_A, STRANGER_1, 1_000_000n),
      leg(STRANGER_1, STRANGER_2, 995_000n),
      leg(STRANGER_2, AGENT_OWNER, 990_000n),
    ],
  }
  const m = matchParties({ check: routed, reviewer: REVIEWER_A, agentOwner: AGENT_OWNER, declaredFrom: null, declaredTo: null })
  assert.equal(m.attributed, true)
  assert.equal(m.attributedAmount, 990_000n)
})

check('a transaction that moved nothing cannot be attributed to anyone', () => {
  const dead = { ...settled(REVIEWER_A, AGENT_OWNER), movedValue: false, transfers: [] }
  const m = matchParties({ check: dead, reviewer: REVIEWER_A, agentOwner: AGENT_OWNER, declaredFrom: null, declaredTo: null })
  assert.equal(m.attributed, false)
  assert.equal(m.contradicted, false)
})

check('only chains this audit queries may produce a "not found" finding', () => {
  assert.equal(isQueryableNetwork('42220'), true)
  assert.equal(isQueryableNetwork('celo'), true)
  assert.equal(isQueryableNetwork(null), true)
  assert.equal(isQueryableNetwork('8453'), false)
  assert.equal(isQueryableNetwork('base'), false)
})

console.log('\nhostile evidence files')

const { extractPaymentClaim: extract2 } = await import('../src/analysis/payment.js')

check('a file that is literally `null` is handled, not fatal', () => {
  // `JSON.parse("null")` does not throw — it returns null, and reading a
  // property off it used to end the entire audit from four bytes.
  assert.doesNotThrow(() => extract2(null))
  assert.equal(extract2(null).txHash, null)
})

check('primitives and arrays are rejected as documents', () => {
  for (const bad of [7, 'text', true, [1, 2, 3]]) {
    assert.doesNotThrow(() => extract2(bad as never))
    assert.equal(extract2(bad as never).txHash, null)
  }
})

check('a claim nested under a null proof object does not throw', () => {
  assert.equal(extract2({ proofOfPayment: null }).txHash, null)
  assert.equal(extract2({ proofOfPayment: 'a string' }).txHash, null)
  assert.equal(extract2({ transactions: 42 }).txHash, null)
})

console.log(`\n${passed} passed (full suite)\n`)
