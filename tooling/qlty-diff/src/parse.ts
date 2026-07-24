/** The minimal slice of the SARIF result shape this gate reads. */
export interface SarifResult {
  ruleId?: string
  message?: { text?: string }
  locations?: {
    physicalLocation?: { artifactLocation?: { uri?: string } }
  }[]
  properties?: { structural_hash?: string }
}

interface SarifDocument {
  runs?: { results?: SarifResult[] }[]
}

/**
 * Extract the SARIF results array from a raw qlty run. qlty prefixes SARIF with
 * human-readable log lines, so we slice from the first `{`. Throws when no JSON
 * is present at all (an unrecoverable qlty failure).
 */
export const extractResults = (raw: string, label: string): SarifResult[] => {
  const start = raw.indexOf('{')
  if (start === -1) {
    throw new Error(`qlty ${label} produced no SARIF output`)
  }
  const parsed = JSON.parse(raw.slice(start)) as SarifDocument
  return parsed.runs?.[0]?.results ?? []
}

// Built at runtime so the control char isn't a regex literal (no-control-regex).
const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

/** Strip ANSI color codes so plain text can be parsed. */
export const stripAnsi = (value: string): string => value.replace(ansi, '')

/** The number of duplicated lines a single "similar/identical code" result covers. */
export const linesOf = (result: SarifResult): number =>
  Number(/Found (\d+) lines/.exec(result.message?.text ?? '')?.[1] ?? 0)

/** Count distinct duplication clusters, keyed by structural hash where available. */
export const countClusters = (duplication: SarifResult[]): number =>
  new Set(duplication.map((r) => r.properties?.structural_hash ?? JSON.stringify(r.locations))).size

/** File path a result points at, for printing offending locations. */
export const locationOf = (result: SarifResult): string =>
  result.locations?.[0]?.physicalLocation?.artifactLocation?.uri ?? '?'

/**
 * Total lines of the changed files, read from the TOTAL row of `qlty metrics`.
 * This is the denominator for the duplication percentage.
 */
export const parseTotalLines = (metrics: string): number => {
  const totalRow = stripAnsi(metrics)
    .split('\n')
    .find((line) => /^\s*TOTAL\b/.test(line))
  if (!totalRow) return 0
  const linesColumn = totalRow.split('|')[7]
  return linesColumn ? Number(linesColumn.trim()) || 0 : 0
}
