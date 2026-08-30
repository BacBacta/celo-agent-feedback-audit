/**
 * Run `fn` over `items` with at most `concurrency` in flight, pulling.
 *
 * The distinction from `Promise.all` over fixed-size slices is throughput
 * under a skewed latency distribution. A barrier dispatches N, waits for all
 * N, dispatches the next N — so its rate is set by the slowest item in every
 * group. A pool lets each worker take the next item the moment it finishes its
 * own, so its rate is set by the mean.
 *
 * With one slow item in every group of eight and a 45-second ceiling on it,
 * those two rates differ by roughly six times. That is the difference between
 * a full evidence pass taking an afternoon and taking a night.
 *
 * `next++` is safe without a lock because there is no `await` between reading
 * the index and incrementing it: on a single-threaded event loop that pair is
 * indivisible, so no item is claimed twice and none is skipped.
 */
export async function pool<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const width = Math.max(1, Math.min(Math.floor(concurrency), items.length))
  if (items.length === 0) return
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      await fn(items[i]!, i)
    }
  }
  await Promise.all(Array.from({ length: width }, worker))
}
