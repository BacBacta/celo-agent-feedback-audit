import { mkdirSync, existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { EvidenceVerdict } from './analysis/evidence.js'

/**
 * A resume point for the retrieval phase.
 *
 * Indexing has always been cached; retrieval never was, and it is the part that
 * takes hours — ten thousand files, each tried across several gateways, twice.
 * A run interrupted at 90% repeated all of it, which in practice means a
 * full-history audit only completes if nothing goes wrong for the whole
 * afternoon. That is not a property to rely on, and it silently pushes an
 * operator towards sampling instead.
 *
 * Verdicts are appended as they are decided, keyed by the registry's own tuple.
 * A restart re-reads them and asks only for what is missing. The file is
 * append-only and line-delimited, so a process killed mid-write loses at most
 * the line it was writing, and that line is simply re-fetched.
 */
export class VerdictCache {
  private readonly path: string
  private readonly done = new Map<string, EvidenceVerdict>()

  constructor(path: string) {
    this.path = path
    mkdirSync(dirname(path), { recursive: true })
    if (!existsSync(path)) return
    /**
     * Repair a line the last run was killed in the middle of.
     *
     * The file is opened in append mode, so a process killed inside
     * appendFileSync leaves a line with no newline — and the NEXT run glued
     * its first verdict onto that fragment, producing one invalid line that
     * the silent catch below then threw away. Two verdicts lost, not one, and
     * the comment promised at most one. Truncating the fragment up front makes
     * the promise true.
     */
    const raw = readFileSync(path, 'utf8')
    if (raw.length && !raw.endsWith('\n')) {
      const keep = raw.lastIndexOf('\n')
      writeFileSync(path, keep < 0 ? '' : raw.slice(0, keep + 1))
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const { key, verdict } = JSON.parse(line)
        // `amount` is the only bigint on the record; JSON gave it back as text.
        if (verdict && verdict.amount !== null && verdict.amount !== undefined) {
          verdict.amount = BigInt(verdict.amount)
        }
        this.done.set(key, verdict)
      } catch {
        // A torn final line from a killed process. Dropping it costs one refetch.
      }
    }
  }

  static key(rec: { agentId: bigint; reviewer: string; feedbackIndex: bigint }): string {
    return `${rec.agentId}|${rec.reviewer.toLowerCase()}|${rec.feedbackIndex}`
  }

  get(key: string): EvidenceVerdict | undefined {
    return this.done.get(key)
  }

  put(key: string, verdict: EvidenceVerdict): void {
    this.done.set(key, verdict)
    appendFileSync(
      this.path,
      JSON.stringify({ key, verdict }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n',
    )
  }

  get size(): number {
    return this.done.size
  }
}
