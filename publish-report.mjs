/**
 * Snapshot a completed run into docs/, under the block it was pinned to.
 *
 * A published report has to be identifiable by what it measured, not by when
 * it was written. Two runs on the same day over different block ranges are
 * different measurements; two runs a week apart pinned to the same block are
 * the same one. So the filename carries `toBlock`, and the snapshot refuses to
 * overwrite an existing file whose content differs — a published figure that
 * changes silently under a stable name is the defect this whole repository is
 * about.
 *
 *   node publish-report.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'

const md = readFileSync('out/audit.md', 'utf8')
const json = JSON.parse(readFileSync('out/audit.json', 'utf8'))

/**
 * Refuse to publish a run whose provenance fields are missing.
 *
 * `out/` accumulates across runs and older files linger. Publishing one that
 * predates the fields naming the rules its verdicts were decided under would
 * put a report on the record with no way to say what produced it.
 */
for (const key of ['retrievalRules', 'observedRoot', 'toBlock', 'totalFeedback']) {
  if (json[key] === undefined || json[key] === null || json[key] === '') {
    console.error(
      `out/audit.json has no \`${key}\`. This is an output from an older build; ` +
        're-run the audit before publishing.',
    )
    process.exit(1)
  }
}

const name = `audit-${json.toBlock}-${json.retrievalRules}`
mkdirSync('docs', { recursive: true })

for (const [file, body] of [
  [`docs/${name}.md`, md],
  [`docs/${name}.json`, JSON.stringify(json, null, 2) + '\n'],
]) {
  if (existsSync(file)) {
    const old = readFileSync(file, 'utf8')
    if (old === body) {
      console.log(`  = ${file} (unchanged)`)
      continue
    }
    const h = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12)
    console.error(
      `${file} already exists and differs (${h(old)} → ${h(body)}).\n` +
        'The same block range and the same retrieval rules produced two different\n' +
        'reports. That is a finding about this tool, not a file to overwrite.\n' +
        'Diff them before deciding which one is right.',
    )
    process.exit(1)
  }
  writeFileSync(file, body)
  console.log(`  + ${file}`)
}

console.log(
  `\nPublished blocks ${json.fromBlock}–${json.toBlock} under rules ` +
    `${json.retrievalRules}: ${json.totalFeedback.toLocaleString('en-US')} records, ` +
    `coverage root ${json.observedRoot}.`,
)
