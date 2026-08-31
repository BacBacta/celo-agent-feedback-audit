/**
 * Decide the block range a run covers, as a pure function.
 *
 * This lives apart from main() because it is the one decision that determines
 * what a published report is ABOUT. Every other setting changes how carefully a
 * record is checked; this one changes which records exist. A run that silently
 * covers the wrong span produces a report that is internally consistent, names
 * a range in its own filename, and is wrong about the world — which is the
 * failure this repository keeps finding and the reason the range is now
 * testable without a chain.
 */

export interface RangeInput {
  /** AUDIT_WINDOW: 'all', or a number of days back from the end of the range. */
  window?: string
  /** AUDIT_FROM_BLOCK, verbatim from the environment. */
  from?: string
  /** AUDIT_TO_BLOCK, verbatim from the environment. */
  to?: string
  head: bigint
  deployBlock: bigint
  blocksPerDay: bigint
}

export type RangeResult =
  | { ok: true; fromBlock: bigint; toBlock: bigint; pinnedFrom: boolean; pinnedTo: boolean }
  | { ok: false; lines: string[] }

const digits = (v: string) => /^\d+$/.test(v)
const clean = (v: string | undefined) => (v ?? '').trim()

export function resolveRange(input: RangeInput): RangeResult {
  const { head, deployBlock, blocksPerDay } = input
  const from = clean(input.from)
  const to = clean(input.to)
  const window = clean(input.window)

  if (to && !digits(to)) {
    return { ok: false, lines: [`AUDIT_TO_BLOCK must be a block number; got ${JSON.stringify(to)}.`] }
  }
  if (to && BigInt(to) > head) {
    return { ok: false, lines: [`AUDIT_TO_BLOCK=${to} is beyond the chain head (${head}).`] }
  }
  const toBlock = to ? BigInt(to) : head

  if (from && !digits(from)) {
    return { ok: false, lines: [`AUDIT_FROM_BLOCK must be a block number; got ${JSON.stringify(from)}.`] }
  }
  /**
   * Both name where to start, so setting both is refused rather than silently
   * resolved. A precedence rule is exactly the kind of thing an operator reads
   * once and mis-remembers on the run that spends money.
   */
  if (from && window) {
    return {
      ok: false,
      lines: [
        `AUDIT_FROM_BLOCK=${from} and AUDIT_WINDOW=${window} both say where to start.`,
        'Set one. A window is days back from the end of the range; a from-block is exact.',
      ],
    }
  }
  if (from && BigInt(from) < deployBlock) {
    return { ok: false, lines: [`AUDIT_FROM_BLOCK=${from} is before the registry existed (${deployBlock}).`] }
  }
  if (window && window !== 'all' && !/^\d+(\.\d+)?$/.test(window)) {
    return { ok: false, lines: [`AUDIT_WINDOW must be 'all' or a number of days; got ${JSON.stringify(window)}.`] }
  }

  /**
   * A window is measured back from the END of the range, not from the head.
   *
   * It used to be `head - window`, which is the same thing only when the end IS
   * the head. Pin AUDIT_TO_BLOCK to anything older than the window and the
   * start lands after the end: an inverted range, which finds no logs and
   * reports as a quiet window rather than as the contradiction it is.
   */
  let fromBlock: bigint
  if (from) fromBlock = BigInt(from)
  else if (!window || window === 'all') fromBlock = deployBlock
  else {
    const back = BigInt(Math.floor(Number(window) * Number(blocksPerDay)))
    // A window wider than the chain clamps to the registry rather than
    // underflowing into a negative block, which BigInt would happily produce.
    fromBlock = toBlock > back && toBlock - back > deployBlock ? toBlock - back : deployBlock
  }

  if (fromBlock > toBlock) {
    return {
      ok: false,
      lines: [
        `The range starts after it ends: ${fromBlock} → ${toBlock}.`,
        'An inverted range finds no logs, which reads exactly like a quiet window.',
      ],
    }
  }

  return { ok: true, fromBlock, toBlock, pinnedFrom: Boolean(from), pinnedTo: Boolean(to) }
}
