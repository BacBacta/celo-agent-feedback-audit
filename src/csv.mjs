/**
 * The CSV contract shared by the audit and the attestation service.
 *
 * This file exists in two repositories and must stay byte-for-byte identical:
 * `celo-agent-feedback-audit/src/csv.mjs` writes the rows, and
 * `provenance-attestations/script/csv.mjs` reads them before turning them into
 * on-chain verdicts. A CSV whose writer and reader disagree is not a format,
 * and this one is the input to a public ledger — a torn row becomes a wrong
 * attestation nobody can retract. The attestation service's test suite compares
 * the two copies and fails if they drift.
 *
 * The writer guarantees one record per physical line by escaping control
 * characters rather than quoting them, because `feedbackURI` is
 * attacker-controlled and a literal newline inside a quoted field would let one
 * review forge a second row. The reader below is nonetheless a full RFC 4180
 * state machine that handles embedded newlines correctly: the format promises
 * the stronger property, and the parser refuses to be the weak link if some
 * other producer ever breaks that promise.
 */

/**
 * Split CSV text into rows of raw cells.
 *
 * Quote state is carried ACROSS line boundaries, which the previous
 * implementation could not do: it split on newlines before looking at quotes,
 * so a quoted field containing one tore into two rows — one truncated, one
 * forged.
 */
export function parseCsvRows(text) {
  const rows = []
  let row = []
  let cur = ''
  let inQuotes = false
  let sawAny = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++ }
        else inQuotes = false
      } else cur += ch
      continue
    }
    if (ch === '"') { inQuotes = true; sawAny = true; continue }
    if (ch === ',') { row.push(cur); cur = ''; sawAny = true; continue }
    if (ch === '\r') {
      // Tolerate CRLF without letting the CR survive into the last cell, which
      // silently corrupted every value of the final column.
      if (text[i + 1] === '\n') i++
      row.push(cur); rows.push(row); row = []; cur = ''; sawAny = false
      continue
    }
    if (ch === '\n') {
      row.push(cur); rows.push(row); row = []; cur = ''; sawAny = false
      continue
    }
    cur += ch
    sawAny = true
  }
  if (sawAny || cur !== '' || row.length) { row.push(cur); rows.push(row) }
  return rows.filter((r) => r.length > 1 || (r[0] ?? '') !== '')
}

/**
 * Undo the writer's control-character escaping.
 *
 * Backslash last, so that a literal backslash in the source does not get
 * re-read as the escape character of whatever follows it.
 */
export function unescapeCell(cell) {
  let out = ''
  for (let i = 0; i < cell.length; i++) {
    if (cell[i] !== '\\') { out += cell[i]; continue }
    const next = cell[i + 1]
    if (next === 'n') { out += '\n'; i++ }
    else if (next === 'r') { out += '\r'; i++ }
    else if (next === 't') { out += '\t'; i++ }
    else if (next === '\\') { out += '\\'; i++ }
    else out += '\\'
  }
  return out
}

/** Escape one value for writing. Mirror image of `unescapeCell`. */
export function escapeCell(val) {
  return `"${String(val ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(CONTROL_CHARS, '')
    .replace(/"/g, '""')}"`
}

/** Anything still unprintable after the named escapes above is simply dropped. */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f]', 'g')

/**
 * Parse a CSV with a header row into objects.
 *
 * A row whose cell count does not match the header is a torn or forged row, and
 * is returned in `malformed` rather than silently padded with empty strings.
 * Padding is how a truncated row becomes a plausible-looking record.
 */
export function parseCsvStrict(text) {
  const rows = parseCsvRows(text)
  if (!rows.length) return { header: [], rows: [], malformed: [] }
  const header = rows[0].map((h) => unescapeCell(h).trim())
  const out = []
  const malformed = []
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i]
    if (cells.length !== header.length) {
      malformed.push({
        line: i + 1,
        cells: cells.length,
        expected: header.length,
        raw: cells.join(',').slice(0, 200),
      })
      continue
    }
    out.push(Object.fromEntries(header.map((h, j) => [h, unescapeCell(cells[j] ?? '')])))
  }
  return { header, rows: out, malformed }
}

/** Lenient form for read-only tooling: malformed rows are reported, not fatal. */
export function parseCsv(text) {
  const { rows, malformed } = parseCsvStrict(text)
  if (malformed.length) {
    console.error(`  ! ${malformed.length} malformed row(s) skipped (first at line ${malformed[0].line})`)
  }
  return rows
}
