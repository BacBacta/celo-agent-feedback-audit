/**
 * Why do fetched files mismatch their attested hash?
 * Samples EvidenceUnhashed rows, fetches each file, and tests which byte
 * variant reproduces the on-chain feedbackHash:
 *   exact bytes · trailing-whitespace stripped · trailing newline added ·
 *   JSON re-serialized compact · JSON re-serialized 2-space
 * Controls: a few EvidenceIntact rows (expected: exact).
 *
 *   node probe-hash.mjs            # from the audit repo directory
 */
import { readFileSync } from 'node:fs'
import { keccak256, toBytes } from 'viem'

function rows(csv) {
  const lines = readFileSync(csv, 'utf8').split('\n').filter(Boolean)
  const head = split(lines[0])
  return lines.slice(1).map((l) => Object.fromEntries(head.map((h, i) => [h, split(l)[i] ?? ''])))
}
function split(line) {
  const out = []; let cur = '', q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) { if (c === '"' && line[i+1] === '"') { cur += '"'; i++ } else if (c === '"') q = false; else cur += c }
    else if (c === '"') q = true
    else if (c === ',') { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur); return out
}

const all = rows('out/evidence.csv')
const pick = (rung, n) => {
  const set = all.filter((r) => r.rung === rung && /^https?:/.test(r.feedbackURI))
  const stride = Math.max(1, Math.floor(set.length / n))
  return set.filter((_, i) => i % stride === 0).slice(0, n)
}

const variants = (buf) => {
  const text = Buffer.from(buf).toString('utf8')
  const out = { exact: keccak256(new Uint8Array(buf)) }
  out.trimmed = keccak256(toBytes(text.replace(/\s+$/, '')))
  out.plusNL = keccak256(toBytes(text.replace(/\s+$/, '') + '\n'))
  try {
    const j = JSON.parse(text)
    out.jsonCompact = keccak256(toBytes(JSON.stringify(j)))
    out.json2space = keccak256(toBytes(JSON.stringify(j, null, 2)))
  } catch { out.notJson = true }
  return out
}

const tally = {}
async function probe(r, label) {
  let res
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000)
    res = await fetch(r.feedbackURI, { signal: ctrl.signal }); clearTimeout(t)
  } catch { record(label, 'fetch-failed'); return }
  if (!res.ok) { record(label, `http-${res.status}`); return }
  const ct = (res.headers.get('content-type') ?? '').split(';')[0]
  const buf = await res.arrayBuffer()
  const v = variants(buf)
  const target = r.evidenceHash.toLowerCase()
  const hit = Object.entries(v).find(([k, h]) => k !== 'notJson' && h === target)?.[0]
  record(label, hit ?? (v.notJson ? `no-match:not-json(${ct})` : `no-match(${ct})`))
}
function record(label, outcome) {
  tally[label] ??= {}; tally[label][outcome] = (tally[label][outcome] ?? 0) + 1
}

for (const r of pick('EvidenceUnhashed', 20)) await probe(r, 'Unhashed')
for (const r of pick('EvidenceIntact', 5)) await probe(r, 'Intact(control)')

for (const [label, outs] of Object.entries(tally)) {
  console.log(`\n${label}:`)
  for (const [k, n] of Object.entries(outs).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${k}`)
  }
}
console.log('\nLecture: "exact" = mon hachage est bon et le fichier correspond aujourd\'hui ;')
console.log('"trimmed/plusNL/json*" = le serveur re-sérialise, l\'empreinte ne peut pas tenir ;')
console.log('"no-match:not-json" = soft-404, le fichier est en réalité disparu.')
