/**
 * Bring an existing corpus in line with the store-documents-only policy.
 *
 * Measured before this existed: 1,712 JSON blobs held 2.4 MB and 295 HTML blobs
 * held 150.1 MB. The store was 98.4% block-explorer pages, served where a
 * `feedbackURI` pointed at celoscan.io or a transaction page instead of an
 * evidence file.
 *
 * This does NOT delete the record of those bodies. For each blob that is not a
 * candidate document it rewrites the manifest entries to carry `stored: false`
 * and a bounded prefix — the identity (keccak of the whole body) and the true
 * length were already there and are untouched. What goes is the remainder,
 * which proves nothing the prefix does not.
 *
 *   node prune-corpus.mjs           # report what would change, write nothing
 *   node prune-corpus.mjs --apply   # do it
 */
import { readFileSync, writeFileSync, readdirSync, unlinkSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.CORPUS_DIR ?? 'out/evidence-corpus'
const PREFIX_BYTES = 512
const APPLY = process.argv.includes('--apply')

const blobs = join(DIR, 'blobs')
const manifestPath = join(DIR, 'manifest.jsonl')
if (!existsSync(blobs) || !existsSync(manifestPath)) {
  console.error(`No corpus at ${DIR}. Set CORPUS_DIR or run from the repository root.`)
  process.exit(1)
}

/**
 * The cheapest possible test, and deliberately NOT the parser that decides
 * verdicts: this chooses what is kept on disk and must never be able to change
 * what a record was judged to be. A body starting with `{` or `[` is a
 * candidate document even if it later fails to parse — a truncated or malformed
 * JSON file is exactly the kind of thing a publisher would want the bytes of.
 */
const SKIP = new Set([0x20, 0x09, 0x0a, 0x0d, 0xef, 0xbb, 0xbf])
const isProbablyJson = (buf) => {
  for (let i = 0; i < buf.length && i < 64; i++) {
    const c = buf[i]
    if (SKIP.has(c)) continue
    return c === 0x7b || c === 0x5b
  }
  return false
}

/** Control characters would make the manifest unreadable in a terminal or a diff. */
const printable = (s) => s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ')

/** contentId -> { path, size, prefix } for every blob that is not a document. */
const drop = new Map()
let keptBlobs = 0
let keptBytes = 0
for (const f of readdirSync(blobs)) {
  if (!f.endsWith('.bin')) continue
  const p = join(blobs, f)
  const size = statSync(p).size
  const head = readFileSync(p).subarray(0, Math.max(PREFIX_BYTES, 64))
  if (isProbablyJson(head)) {
    keptBlobs++
    keptBytes += size
    continue
  }
  drop.set('0x' + f.slice(0, -4), {
    path: p,
    size,
    prefix: printable(
      new TextDecoder('utf-8', { fatal: false }).decode(head.subarray(0, PREFIX_BYTES)),
    ),
  })
}

/**
 * A body already pruned by an earlier run has no blob left to read.
 *
 * Its description then lives inline in the manifest, which is where the first
 * version of this script put it. Collect those too, so running this again
 * migrates them into not-stored.jsonl instead of finding nothing to do and
 * leaving 1.9 MB of duplicated prefixes in place. This makes the script
 * idempotent, which a data migration has to be.
 */
let migrated = 0
for (const line of readFileSync(manifestPath, 'utf8').split('\n')) {
  if (!line.trim()) continue
  let e
  try { e = JSON.parse(line) } catch { continue }
  if (e.stored !== false || drop.has(e.contentId)) continue
  if (typeof e.prefix !== 'string') continue
  drop.set(e.contentId, { path: null, size: e.bytes ?? 0, prefix: e.prefix })
  migrated++
}
if (migrated) console.log(`  descriptions recovered from an earlier prune: ${migrated.toLocaleString('en-US')}`)

const droppedBytes = [...drop.values()].reduce((a, d) => a + d.size, 0)
const mb = (n) => (n / 1048576).toFixed(1)

console.log(`corpus ${DIR}`)
console.log(`  documents kept   ${keptBlobs.toLocaleString('en-US')} blobs, ${mb(keptBytes)} MB`)
console.log(
  `  non-documents    ${drop.size.toLocaleString('en-US')} bodies, ${mb(droppedBytes)} MB` +
    '  -> described once in not-stored.jsonl, blob removed',
)

/**
 * The prefix is written once per BODY, not once per retrieval.
 *
 * The manifest has one line per fetch and the same body is cited an average of
 * twelve times, so an inline prefix wrote 1.9 MB where 0.16 MB says the same
 * thing. Same normalisation as content-addressing: bytes are named by their
 * hash and described once, in not-stored.jsonl.
 */
let rewritten = 0
const out = []
for (const line of readFileSync(manifestPath, 'utf8').split('\n')) {
  if (!line.trim()) continue
  let e
  try {
    e = JSON.parse(line)
  } catch {
    out.push(line)
    continue
  }
  if (!drop.has(e.contentId)) {
    out.push(JSON.stringify(e))
    continue
  }
  if (e.stored !== false || e.prefix !== undefined) rewritten++
  const { prefix: _drop, ...rest } = e
  out.push(JSON.stringify({ ...rest, stored: false }))
}
const described = [...drop.entries()].map(([contentId, d]) =>
  JSON.stringify({ contentId, bytes: d.size, prefix: d.prefix }),
)
console.log(`  manifest entries rewritten: ${rewritten.toLocaleString('en-US')}`)
console.log(`  bodies described once in not-stored.jsonl: ${described.length.toLocaleString('en-US')}`)

if (!APPLY) {
  console.log('\nNothing written. Re-run with --apply to make these changes.')
  process.exit(0)
}

writeFileSync(manifestPath, out.join('\n') + '\n')
writeFileSync(join(DIR, 'not-stored.jsonl'), described.join('\n') + '\n')
for (const d of drop.values()) { if (d.path && existsSync(d.path)) unlinkSync(d.path) }
console.log(`\nApplied. Corpus is now ${keptBlobs.toLocaleString('en-US')} blobs, ${mb(keptBytes)} MB.`)
