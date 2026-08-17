/**
 * The checked-in adoption baseline (FR-035) and the bookkeeping that makes it drain
 * (FR-010).
 *
 * An entry names a rule and a path, and downgrades that pair's findings to `note` with
 * `baselined: true`. Entries are keyed on `rule` + `path` **only**: a line number would
 * churn on every unrelated edit above the defect, and a content hash would make the file
 * unreadable to the reviewer who has to approve each addition. The cost of that choice is
 * that an entry exempts every occurrence of one rule in one file, which is the trade the
 * spec makes deliberately.
 *
 * An entry that matches nothing is reported as `suppression/stale` at `warn`, reusing
 * FR-010's mechanism, so the file drains as the surface is fixed and cannot quietly
 * become permanent.
 *
 * Two things are deliberately not silent. A `baseline.json` that cannot be read as the
 * documented shape is a **typed failure**, never an empty entry list: a baseline that
 * fails to load downgrades nothing, and a run that downgrades nothing while the file says
 * it should looks exactly like a clean pass. And a **missing** file is not a failure at
 * all — a repository with nothing to baseline is the state this file is trying to reach.
 *
 * `rule` is a plain string rather than a `RuleId`, for the same reason it is in
 * `artifact/suppress.ts`: it is hand-written text, and whether it names a rule that
 * exists is a question for the registry rather than an assumption of the parser.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { bookkeepingFinding, BOOKKEEPING_RULES, ruleById } from './rules'
import type { Finding } from './rules'

export interface BaselineEntry {
  /** As written in the file. Not yet known to name a real rule. */
  rule: string
  /** Repo-relative, POSIX separators — the same form a `Finding` carries. */
  path: string
  /**
   * Why this violation is tolerated for now. Required and non-empty: an entry nobody had
   * to justify is how a baseline stops being a staging step and becomes the status quo.
   * Free text, reviewed when the entry is added and never machine-interpreted.
   */
  reason: string
}

export interface Baseline {
  /** Where the entries were read from, so a message can name the file to edit. */
  path: string
  entries: BaselineEntry[]
}

export interface BaselineFailure {
  kind: 'unreadable' | 'malformed-json' | 'invalid-shape'
  /** The file the failure is about. */
  path: string
  message: string
}

/** The `{ ok, value } | { ok: false, failure }` convention `scope/git.ts` established. */
export type BaselineResult<T> = { ok: true; value: T } | { ok: false; failure: BaselineFailure }

/** The file name every baseline lives under, whichever directory holds it. */
export const BASELINE_FILE_NAME = 'baseline.json'

/**
 * This package's own baseline, resolved from this module rather than from the repository
 * under evaluation. The distinction matters: the gate is exercised against temporary
 * repositories, and a path derived from the repo root would make those runs read a
 * baseline that does not exist — or, worse, one that does.
 */
export const DEFAULT_BASELINE_PATH = resolve(import.meta.dirname, '..', BASELINE_FILE_NAME)

/** The baseline file inside `directory`, for a caller that knows where to look. */
export const baselinePathIn = (directory: string): string => join(directory, BASELINE_FILE_NAME)

const invalid = (path: string, message: string): BaselineResult<never> => ({
  ok: false,
  failure: { kind: 'invalid-shape', path, message },
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A non-empty string field, or null when the field is absent, blank or the wrong type. */
const readField = (source: Record<string, unknown>, field: string): string | null => {
  const value = source[field]
  if (typeof value !== 'string' || value.trim().length === 0) return null
  return value
}

/**
 * Validate one entry. Every field is required, because each of the three failure modes —
 * no rule, no path, no reason — produces an entry that either exempts nothing or exempts
 * something nobody can account for.
 */
const readEntry = (
  path: string,
  value: unknown,
  position: number,
): BaselineResult<BaselineEntry> => {
  const at = `${BASELINE_FILE_NAME} entries[${String(position)}]`
  if (!isRecord(value)) return invalid(path, `${at} is not an object.`)

  const rule = readField(value, 'rule')
  const entryPath = readField(value, 'path')
  const reason = readField(value, 'reason')

  if (rule === null) return invalid(path, `${at} has no \`rule\`, so it exempts nothing.`)
  if (entryPath === null) return invalid(path, `${at} has no \`path\`, so it exempts nothing.`)
  if (reason === null) {
    return invalid(
      path,
      `${at} baselines \`${rule}\` in ${entryPath} with no \`reason\`. An entry nobody had to justify is how a baseline becomes permanent.`,
    )
  }

  return { ok: true, value: { rule, path: entryPath, reason } }
}

/**
 * Parse the documented shape: an object with an `entries` array. Any other key is
 * ignored, which is what carries the header comment — JSON has none, so the file explains
 * itself in a `$comment` string that no parser has to know about.
 */
export const parseBaseline = (path: string, source: string): BaselineResult<Baseline> => {
  let document: unknown
  try {
    document = JSON.parse(source)
  } catch (error) {
    return {
      ok: false,
      failure: {
        kind: 'malformed-json',
        path,
        message: `${path} is not valid JSON (${error instanceof Error ? error.message : 'unknown error'}). It is reported rather than treated as an empty baseline, which would look like a clean pass.`,
      },
    }
  }

  if (!isRecord(document)) {
    return invalid(path, `${path} must be an object with an \`entries\` array.`)
  }
  const raw = document.entries
  if (!Array.isArray(raw)) {
    return invalid(
      path,
      `${path} has no \`entries\` array. An empty baseline is \`"entries": []\`.`,
    )
  }

  const entries: BaselineEntry[] = []
  for (const [position, value] of raw.entries()) {
    const parsed = readEntry(path, value, position)
    if (!parsed.ok) return parsed
    entries.push(parsed.value)
  }

  return { ok: true, value: { path, entries } }
}

/**
 * Read a baseline from disk. A missing file yields an empty baseline — the end state this
 * file is working towards — while any other read failure is reported.
 */
export const loadBaseline = (path: string = DEFAULT_BASELINE_PATH): BaselineResult<Baseline> => {
  let source: string
  try {
    source = readFileSync(path, 'utf8')
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { ok: true, value: { path, entries: [] } }
    }
    return {
      ok: false,
      failure: {
        kind: 'unreadable',
        path,
        message: `${path} exists but could not be read: ${error instanceof Error ? error.message : 'unknown error'}.`,
      },
    }
  }
  return parseBaseline(path, source)
}

/** The empty baseline, for a run started with `--no-baseline`. */
export const emptyBaseline = (path: string = DEFAULT_BASELINE_PATH): Baseline => ({
  path,
  entries: [],
})

export interface AppliedBaseline {
  /** Every finding, with the matched ones downgraded. None are removed. */
  findings: Finding[]
  /** How many findings a baseline entry downgraded, for the report header. */
  applied: number
  /** One `suppression/stale` finding per entry that downgraded nothing. */
  stale: Finding[]
}

/** Why an entry could never downgrade anything, or null when it is a usable entry. */
const unusableBecause = (entry: BaselineEntry): { message: string; remediation: string } | null => {
  const rule = ruleById(entry.rule)
  if (rule === undefined) {
    return {
      message: `Baselines \`${entry.rule}\` in ${entry.path}, which is not a registered rule.`,
      remediation:
        'Correct the rule id, or delete the entry. Rule ids are permanent, so a rename is a retirement.',
    }
  }
  if (rule.bookkeeping === true) {
    // Reported stale rather than refused at load: the entry exempts nothing, which is
    // exactly the stale condition, and it reaches the reader as a `warn` in the same
    // report as everything else. Failing the load instead would mean exit 3 with no
    // artifact evaluated — a report that says nothing about the prompts, over an entry
    // that was already inert. A bookkeeping rule describes the run rather than an
    // artifact's content, and a report that cannot say "I could not read this file" is
    // worse than a red one, so no entry may turn one down.
    return {
      message: `Baselines \`${entry.rule}\` in ${entry.path}, which reports on the run rather than on content and cannot be baselined.`,
      remediation:
        'Delete the entry. Fix the condition it describes instead — an unreadable artifact or an unreasoned suppression is not something to record and keep.',
    }
  }
  return null
}

const staleFinding = (
  entry: BaselineEntry,
  detail: { message: string; remediation: string },
): Finding =>
  bookkeepingFinding(BOOKKEEPING_RULES.staleSuppression, {
    path: entry.path,
    // An entry is about a file rather than a line, by design — that is the whole point of
    // keying on `rule` + `path`.
    line: 0,
    message: detail.message,
    remediation: detail.remediation,
  })

const keyOf = (rule: string, path: string): string => `${rule} ${path}`

/**
 * Downgrade the findings the baseline knows about, and report the entries that matched
 * nothing.
 *
 * This must run **after** the per-rule severity override, not before: the override maps a
 * rule to its configured severity unconditionally, so applying it second would put back
 * the severity this function just took away.
 */
export const applyBaseline = (
  findings: readonly Finding[],
  baseline: Baseline,
): AppliedBaseline => {
  const usable = new Map<string, { entry: BaselineEntry; matched: boolean }>()
  const stale: Finding[] = []

  for (const entry of baseline.entries) {
    const unusable = unusableBecause(entry)
    if (unusable !== null) {
      stale.push(staleFinding(entry, unusable))
      continue
    }
    usable.set(keyOf(entry.rule, entry.path), { entry, matched: false })
  }

  let applied = 0
  const downgraded = findings.map((finding) => {
    const tracked = usable.get(keyOf(finding.rule, finding.path))
    if (tracked === undefined) return finding
    tracked.matched = true
    applied += 1
    return { ...finding, severity: 'note' as const, baselined: true }
  })

  for (const tracked of usable.values()) {
    if (tracked.matched) continue
    stale.push(
      staleFinding(tracked.entry, {
        message: `Baselines \`${tracked.entry.rule}\` in ${tracked.entry.path}, which reported nothing.`,
        remediation: 'Delete the entry — the defect it recorded is fixed.',
      }),
    )
  }

  return { findings: downgraded, applied, stale }
}
