import { mkdirSync, writeFileSync, existsSync, readFileSync, appendFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { keccak256 } from 'viem'

/**
 * A content-addressed copy of every evidence file this audit actually read.
 *
 * Without it the audit's own verdicts decay into the thing they accuse: an
 * assertion whose proof is a dead link. If the live files disappear tomorrow,
 * an unarchived `EvidenceIntact` becomes uncheckable and an unarchived
 * `EvidenceUnhashed` loses the document it convicts. Keys are the keccak-256 of
 * the bytes, so the corpus verifies itself — anyone can re-hash a file and see
 * it is the one that was judged, and no index has to be trusted for that.
 *
 * The store is append-only and deduplicating: identical bytes cited by a
 * hundred records cost one copy.
 */
export interface ArchiveEntry {
  /** keccak256 of the stored bytes — the file's name in the corpus. */
  contentId: string
  bytes: number
  /** Whether these bytes were already present before this run. */
  deduped: boolean
}

export class EvidenceArchive {
  private readonly dir: string
  private readonly seen = new Set<string>()
  private manifestPath: string
  private wrote = 0

  constructor(dir: string) {
    this.dir = dir
    this.manifestPath = join(dir, 'manifest.jsonl')
    mkdirSync(join(dir, 'blobs'), { recursive: true })
    if (existsSync(this.manifestPath)) {
      for (const line of readFileSync(this.manifestPath, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try { this.seen.add(JSON.parse(line).contentId) } catch { /* torn line */ }
      }
    }
  }

  /**
   * Store one retrieved body. The manifest records where it came from and when,
   * because the bytes alone cannot say which URI served them or on what day —
   * and a corpus that cannot be dated is not evidence of a moment.
   */
  put(bytes: Uint8Array, meta: { uri: string; url: string; observedAt: number }): ArchiveEntry {
    const contentId = keccak256(bytes)
    const deduped = this.seen.has(contentId)
    if (!deduped) {
      writeFileSync(join(this.dir, 'blobs', `${contentId.slice(2)}.bin`), bytes)
      this.seen.add(contentId)
      this.wrote += 1
    }
    appendFileSync(
      this.manifestPath,
      JSON.stringify({
        contentId,
        bytes: bytes.byteLength,
        uri: meta.uri,
        servedBy: meta.url,
        observedAt: new Date(meta.observedAt * 1000).toISOString(),
      }) + '\n',
    )
    return { contentId, bytes: bytes.byteLength, deduped }
  }

  /**
   * Distinct blobs in the store, ACROSS ALL RUNS.
   *
   * The constructor preloads `seen` from manifest.jsonl, so this is the
   * cumulative corpus and never what one run produced. It was published as
   * "N file(s) were written by THIS run" — twice, under two different wrong
   * numbers: first a count of verdicts carrying a content id, then this. On a
   * run resumed from a warm verdict cache `put()` is never called at all, and
   * the sentence still claimed a thousand-odd files had just been written.
   */
  get size(): number {
    return this.seen.size
  }

  /**
   * Blobs actually present in the store, counted from the directory.
   *
   * `size` is the manifest's view: every content id any run has ever recorded.
   * The report's sentence is a promise that a verdict stays checkable against
   * the bytes it judged, and only a file on disk keeps that promise — a blob
   * deleted under a manifest line that survives it would still be counted.
   * Cheap to check (one readdir), so it is checked rather than assumed.
   */
  get onDisk(): number {
    try {
      return readdirSync(join(this.dir, 'blobs')).filter((f) => f.endsWith('.bin')).length
    } catch {
      return 0
    }
  }

  /** Blobs this run actually wrote to disk. Zero on a fully cached run. */
  get written(): number {
    return this.wrote
  }
}
