/**
 * Take at most `max` items, spread evenly across the whole array.
 *
 * Sampling matters more than it looks. The records are ordered by block, so
 * `slice(0, max)` takes only the oldest cohort — that is not a sample, it is a
 * truncation, and it produced a headline of "0% claim a payment" for a period
 * whose recent half is 100%. Every Nth spreads the sample across the period,
 * and being deterministic it stays reproducible, which a random sample in an
 * audit would not be.
 *
 * It lives in its own module because the test used to define its own copy of
 * it: four assertions proving that a function in the test file behaved, while
 * the sampler the audit actually runs was inline in main.ts and untested.
 */
export function sample(items, max) {
  if (!(max > 0)) return []
  if (items.length <= max) return items
  const stride = Math.ceil(items.length / max)
  return items.filter((_, i) => i % stride === 0).slice(0, max)
}

/** The stride `sample` would use, for reporting what the numbers cover. */
export function sampleStride(total, max) {
  if (!(max > 0) || total <= max) return 1
  return Math.ceil(total / max)
}
