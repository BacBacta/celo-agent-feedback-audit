/**
 * Concentration and burst statistics.
 *
 * These are NOT the arXiv study's measures, and this file used to say they
 * were. 2606.26028 reports a Gini over *agents owned per wallet* (0.733 /
 * 0.708 / 0.134) and a top-decile of wallets by agents held; the functions
 * below measure *reviews written per reviewer* and the ten single busiest
 * reviewers. Different populations, different units, and close enough in
 * magnitude that comparing them looks like agreement.
 *
 * That study's headline — 73.6% / 59.2% / 90.6% of reviewers exhibiting
 * coordinated Sybil behaviour — comes from a shared-first-funder funding
 * graph: trace each reviewer to the address that first sent it native tokens,
 * cluster reviewers under a common root. Nothing here implements that. It is
 * implementable against Celo and would be a real addition; until it exists,
 * this module must not be described as producing a comparable number.
 */

/**
 * Gini over reviews-per-reviewer. 0 means every reviewer contributed equally;
 * 1 means a single address wrote everything.
 */
export function gini(counts: number[]): number {
  if (counts.length === 0) return 0
  const sorted = [...counts].sort((a, b) => a - b)
  const n = sorted.length
  const total = sorted.reduce((s, v) => s + v, 0)
  if (total === 0) return 0
  let weighted = 0
  for (let i = 0; i < n; i++) weighted += (i + 1) * (sorted[i] ?? 0)
  return (2 * weighted) / (n * total) - (n + 1) / n
}

export interface ConcentrationStats {
  distinctReviewers: number
  gini: number
  topTenShare: number
  oneShotReviewerRate: number
  maxBySingleReviewer: number
}

export function concentration(reviewers: string[]): ConcentrationStats {
  const counts = new Map<string, number>()
  for (const r of reviewers) counts.set(r, (counts.get(r) ?? 0) + 1)
  const values = [...counts.values()].sort((a, b) => b - a)
  const total = reviewers.length || 1
  const topTen = values.slice(0, 10).reduce((s, v) => s + v, 0)
  const oneShot = values.filter((v) => v === 1).length

  return {
    distinctReviewers: counts.size,
    gini: gini(values),
    topTenShare: topTen / total,
    oneShotReviewerRate: counts.size === 0 ? 0 : oneShot / counts.size,
    maxBySingleReviewer: values[0] ?? 0,
  }
}

export interface Burst {
  startTs: number
  endTs: number
  count: number
  distinctReviewers: number
  oneShotReviewers: number
}

/**
 * A burst is many reviews inside a short window written by addresses that are
 * otherwise inactive. One genuine busy hour looks like this too — which is why
 * this reports clusters for inspection rather than labelling them fraudulent.
 */
export function findBursts(
  events: { timestamp: number; reviewer: string }[],
  windowSeconds = 300,
  minEvents = 5,
): Burst[] {
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp)
  const lifetime = new Map<string, number>()
  for (const e of sorted) lifetime.set(e.reviewer, (lifetime.get(e.reviewer) ?? 0) + 1)

  const bursts: Burst[] = []
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length && (sorted[j + 1]!.timestamp - sorted[i]!.timestamp) <= windowSeconds) {
      j++
    }
    const span = sorted.slice(i, j + 1)
    if (span.length >= minEvents) {
      const reviewers = new Set(span.map((e) => e.reviewer))
      bursts.push({
        startTs: sorted[i]!.timestamp,
        endTs: sorted[j]!.timestamp,
        count: span.length,
        distinctReviewers: reviewers.size,
        oneShotReviewers: [...reviewers].filter((r) => (lifetime.get(r) ?? 0) === 1).length,
      })
      i = j + 1
    } else {
      i++
    }
  }
  return bursts
}
