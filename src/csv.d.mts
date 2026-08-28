/**
 * Types for the shared CSV module. The implementation lives in `csv.mjs` and is
 * plain JavaScript on purpose: the offline counter-checks must run on a phone
 * with no build step, and a second TypeScript copy of the same parser is
 * exactly the drift this module exists to prevent.
 */
export declare function parseCsvRows(text: string): string[][]
export declare function unescapeCell(cell: string): string
export declare function escapeCell(val: unknown): string
export declare function parseCsvStrict(text: string): {
  header: string[]
  rows: Record<string, string>[]
  malformed: { line: number; cells: number; expected: number; raw: string }[]
}
export declare function parseCsv(text: string): Record<string, string>[]
