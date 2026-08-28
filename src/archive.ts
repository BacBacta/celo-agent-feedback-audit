import { mkdirSync, writeFileSync, existsSync, readFileSync, appendFileSync } from 'node:fs'
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

  get size(): number {
    return this.seen.size
  }
}
