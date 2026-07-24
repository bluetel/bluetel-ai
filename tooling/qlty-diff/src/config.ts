import process from 'node:process'

/**
 * Thresholds that decide what counts as "too high". Each default can be
 * overridden per-run via the environment variable named in [brackets], e.g.
 *   QLTY_CHECK_LEVEL=medium QLTY_MAX_DUP_PERCENT=15 pnpm qlty:diff
 */
interface QltyDiffConfig {
  /** Minimum severity that counts as an issue: note | fmt | low | medium | high. */
  checkLevel: string
  /** Max lint/security issues (at/above checkLevel) allowed. 0 = none. */
  maxIssues: number
  /** Max share of the changed files' lines that may be duplicated, as a percent. */
  maxDuplicatedPercent: number
  /** Max complexity smells allowed in the diff. Infinity = gate disabled. */
  maxComplexitySmells: number
  /** Base ref to diff against when none is passed as the first CLI argument. */
  defaultBaseRef: string
}

const envNum = (name: string, fallback: number): number => {
  const n = Number(process.env[name])
  return Number.isFinite(n) ? n : fallback
}

/** Build the threshold config from defaults + QLTY_* environment overrides. */
export const buildConfig = (): QltyDiffConfig => ({
  // [QLTY_CHECK_LEVEL]
  checkLevel: process.env.QLTY_CHECK_LEVEL ?? 'medium',
  // [QLTY_MAX_ISSUES]
  maxIssues: envNum('QLTY_MAX_ISSUES', 0),
  // [QLTY_MAX_DUP_PERCENT]
  maxDuplicatedPercent: envNum('QLTY_MAX_DUP_PERCENT', 10),
  // [QLTY_MAX_COMPLEXITY]
  maxComplexitySmells: envNum('QLTY_MAX_COMPLEXITY', Infinity),
  // [QLTY_BASE_REF]
  defaultBaseRef: process.env.QLTY_BASE_REF ?? 'origin/main',
})

interface QltyScope {
  /** Flags appended to every qlty call to scope it. */
  args: string[]
  /** Human-readable description of the scope, for the summary header. */
  label: string
}

/**
 * Resolve how to scope every qlty call: the whole codebase (`--all`), or just
 * the diff vs a base ref. `--upstream` scopes to the files the branch *changed*.
 */
export const resolveScope = (argv: string[], config: QltyDiffConfig): QltyScope => {
  if (argv.includes('--all')) {
    return { args: ['--all'], label: 'all files' }
  }
  const baseRef = argv.find((arg) => !arg.startsWith('-')) ?? config.defaultBaseRef
  return { args: [`--upstream=${baseRef}`], label: `vs ${baseRef}` }
}
