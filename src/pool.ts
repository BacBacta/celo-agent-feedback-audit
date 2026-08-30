/**
 * Run `fn` over `items` with at most `concurrency` in flight, pulling.
 *
 * The distinction from `Promise.all` over fixed-size slices is throughput
 * under a skewed latency distribution. A barrier dispatches N, waits for all
 * N, dispatches the next N — so its rate is set by the slowest item in every
 * group. A pool lets each worker take the next item the moment it finishes its
 * own, so its rate is set by the mean.
 *
 * How much that is worth depends entirely on the spread. With one slow item in
 * every group of eight and a 45-second ceiling on it, the two rates differ by
 * roughly six times. With every item slow they converge, and the pool buys
 * almost nothing: measured on this registry's tail — where what remains is
 * unpinned IPFS content that no gateway answers — the rate went from 10.7 to
 * 12 records a minute, about 12%.
 *
 * Both numbers are real and neither is the headline. The barrier's cost is a
 * property of the latency distribution, not a constant, and quoting the
 * favourable case as though it described every workload is the same error this
 * repository exists to object to.
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
