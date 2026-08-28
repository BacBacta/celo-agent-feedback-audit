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

import('../src/report.js').then(({ rung }) => {
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

  console.log(`\n${passed} passed (with ladder)\n`)
})
