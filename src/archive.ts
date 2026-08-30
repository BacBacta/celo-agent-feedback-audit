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
  /** keccak256 of the WHOLE body — its identity, whether or not a blob was kept. */
  contentId: string
  bytes: number
  /** Whether these bytes were already present before this run. */
  deduped: boolean
  /** Whether a blob was written. False for a body that is not a candidate document. */
  stored: boolean
}

/** How much of a non-document body the manifest keeps, in bytes. */
export const NON_DOCUMENT_PREFIX_BYTES = 512

/**
 * Is this body worth storing whole?
 *
 * Deliberately the cheapest possible test, and deliberately NOT the parser used
 * to decide verdicts: this decides what is kept on disk, and must never be able
 * to change what a record is judged to be. A body that starts with `{` or `[`
 * is a candidate document even if it later fails to parse — a truncated or
 * malformed JSON file is exactly the kind of thing a publisher would want the
 * bytes of.
 */
/** Control characters would make not-stored.jsonl unreadable in a terminal or a diff. */
function printable(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
}

function isProbablyJson(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length && i < 64; i++) {
    const c = bytes[i]!
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0xef || c === 0xbb || c === 0xbf) continue
    return c === 0x7b || c === 0x5b
  }
  return false
}

export class EvidenceArchive {
  private readonly dir: string
  private readonly seen = new Set<string>()
  private manifestPath: string
  private notStoredPath: string
  /** Bodies already described in not-stored.jsonl, so each is described once. */
  private readonly described = new Set<string>()
  private wrote = 0

  constructor(dir: string) {
    this.dir = dir
    this.manifestPath = join(dir, 'manifest.jsonl')
    this.notStoredPath = join(dir, 'not-stored.jsonl')
    mkdirSync(join(dir, 'blobs'), { recursive: true })
    if (existsSync(this.notStoredPath)) {
      for (const line of readFileSync(this.notStoredPath, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try { this.described.add(JSON.parse(line).contentId) } catch { /* torn line */ }
      }
    }
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
    /**
     * A body that is not a document is recorded, not stored whole.
     *
     * Measured on the full-history corpus: 1,712 JSON blobs held 2.4 MB and 295
     * HTML blobs held 150.1 MB — 98.4% of the store was block-explorer pages
     * served where a `feedbackURI` pointed at celoscan.io instead of an evidence
     * file. Half a megabyte of Blockscout markup is a disproportionate way to
     * prove "this was not JSON", and it was crowding out the 2.4 MB that is the
     * actual evidence.
     *
     * It cannot simply be dropped: 38% of retrievals landed on such a body, and
     * those bytes are what justifies every `not JSON` verdict. So the manifest
     * keeps the identity (keccak of the WHOLE body, unchanged), the true length,
     * and a bounded prefix — enough to show a reader it was
     * `<!doctype html>…<title>Address: 0x…` and not a feedback document. What is
     * dropped is only the remainder, which proves nothing the prefix does not.
     *
     * The blob store therefore holds bodies that are candidate evidence, and
     * stays content-addressed: every file in it still hashes to its own name.
     */
    const looksLikeDocument = isProbablyJson(bytes)
    if (!deduped && !looksLikeDocument && !this.described.has(contentId)) {
      this.described.add(contentId)
      appendFileSync(
        this.notStoredPath,
        JSON.stringify({
          contentId,
          bytes: bytes.byteLength,
          prefix: printable(
            new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, NON_DOCUMENT_PREFIX_BYTES)),
          ),
        }) + '\n',
      )
    }
    if (!deduped && looksLikeDocument) {
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
        /**
         * The prefix lives once per BODY, in not-stored.jsonl, not once per
         * retrieval here. The manifest has one line per fetch and the same body
         * is cited an average of twelve times, so carrying the prefix inline
         * wrote 1.9 MB where 0.16 MB says the same thing. Same normalisation as
         * content-addressing: the bytes are named by their hash and described
         * once.
         */
        ...(looksLikeDocument ? {} : { stored: false }),
      }) + '\n',
    )
    return { contentId, bytes: bytes.byteLength, deduped, stored: looksLikeDocument }
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
  /** Bodies the manifest records without a blob, because they are not documents. */
  get recordedNotStored(): number {
    return this.described.size
  }

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
