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
/**
 * `retrievalRulesName` is in this list because leaving it out cost a bad publish.
 *
 * The filename below used `json.retrievalRulesName ?? 'rules'`, so an output
 * predating that field was published as `audit-…-rules-<fingerprint>` — a
 * literal placeholder standing where the semantics are supposed to be named,
 * in the identity of the artefact. A fallback that invents part of a published
 * name is the same defect as a template printing NaN: the value is missing and
 * the output does not say so.
 */
for (const key of ['retrievalRules', 'retrievalRulesName', 'observedRoot', 'fromBlock', 'toBlock', 'totalFeedback']) {
  if (json[key] === undefined || json[key] === null || json[key] === '') {
    console.error(
      `out/audit.json has no \`${key}\`. This is an output from an older build; ` +
        're-run the audit before publishing.',
    )
    process.exit(1)
  }
}

/**
 * The .md and the .json must come from the SAME run.
 *
 * The identity below is read entirely from audit.json, and audit.md was
 * published under it with nothing checking the two agreed. out/ accumulates
 * across runs and a crash between the two writes is enough: the snapshot would
 * then carry one run's prose under another run's block range, root and rules —
 * a provenance record that is exactly wrong, and unfalsifiable, because the
 * only thing naming the run is the half that is right.
 *
 * The report prints its own root and block range, so the cheapest true check
 * is that the prose contains them.
 */
for (const [label, needle] of [
  ['coverage root', String(json.observedRoot)],
  ['toBlock', String(json.toBlock)],
  ['fromBlock', String(json.fromBlock)],
]) {
  if (!md.includes(needle)) {
    console.error(
      `out/audit.md does not mention the ${label} (${needle}) that out/audit.json records.\n` +
        'The two are from different runs, or the report no longer prints its own\n' +
        'provenance. Either way this pair must not be published under one identity.',
    )
    process.exit(1)
  }
}

/**
 * The identity carries BOTH endpoints of the range, and both the rules name and
 * their fingerprint.
 *
 * `audit-<toBlock>-<rules>` collided for a windowed run and a full-history run
 * pinned to the same head — different measurements, one filename — and the
 * refusal then claimed "the same block range" about two ranges that differ.
 * And `rules` is the fingerprint, a hex digest that tells a reader nothing
 * about which semantics decided the verdicts; the name is what says that.
 */
const name = `audit-${json.fromBlock}-${json.toBlock}-${json.retrievalRulesName}-${json.retrievalRules}`
mkdirSync('docs', { recursive: true })

/**
 * Decide on BOTH files before writing EITHER.
 *
 * The loop wrote docs/<name>.md, then hit the mismatch on the .json and exited
 * 1 — leaving half a publication on disk under a name whose other half was
 * refused. A refusal that leaves output behind is not a refusal.
 */
/**
 * The row-level export travels with the report, under the same identity.
 *
 * The report says what was found; `evidence.csv` is the 20,097 rows it was
 * found from, and the rows the attestation ledger is written from. Publishing
 * one without the other makes the aggregate checkable only by re-running the
 * whole audit — and the export lives under out/, which is gitignored, so it
 * existed on exactly one machine.
 *
 * That was not theoretical: a backfill run on a second machine read that
 * machine's own months-old export, which predated the `feedbackIndex` and
 * `observedAt` columns, and every one of its 20,097 rows was rejected. The
 * script refused correctly, but it should not have been possible to be that
 * far out of step in the first place.
 *
 * `sweep.json` is here for the same reason: it is what commitSweep publishes,
 * so a reader checking a coverage claim needs the manifest it came from.
 */
const exports_ = [
  ['evidence.csv', 'out/evidence.csv'],
  ['claims.csv', 'out/claims.csv'],
  ['sweep.json', 'out/sweep.json'],
]

const planned = [
  [`docs/${name}.md`, md],
  [`docs/${name}.json`, JSON.stringify(json, null, 2) + '\n'],
]
for (const [label, src] of exports_) {
  if (!existsSync(src)) {
    console.error(`out/ is missing ${label}, which the report's rows come from.`)
    console.error('  Re-run the audit before publishing: a report whose export is absent')
    console.error('  can only be checked by reproducing the whole run.')
    process.exit(1)
  }
  planned.push([`docs/${name}.${label}`, readFileSync(src, 'utf8')])
}
const h = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12)
const toWrite = []
for (const [file, body] of planned) {
  if (existsSync(file)) {
    const old = readFileSync(file, 'utf8')
    if (old === body) {
      console.log(`  = ${file} (unchanged)`)
      continue
    }
    console.error(
      `${file} already exists and differs (${h(old)} → ${h(body)}).\n` +
        'The same block range under the same retrieval rules produced two different\n' +
        'reports. That is a finding about this tool, not a file to overwrite.\n' +
        'Diff them before deciding which one is right. Nothing was written.',
    )
    process.exit(1)
  }
  toWrite.push([file, body])
}
for (const [file, body] of toWrite) {
  writeFileSync(file, body)
  console.log(`  + ${file}`)
}

console.log(
  `\nPublished blocks ${json.fromBlock}–${json.toBlock} under rules ` +
    `${json.retrievalRulesName} (fingerprint ${json.retrievalRules}): ` +
    `${json.totalFeedback.toLocaleString('en-US')} records, ` +
    `coverage root ${json.observedRoot}.`,
)
