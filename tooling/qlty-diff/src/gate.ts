import { buildConfig, resolveScope } from './config'
import { countClusters, extractResults, linesOf, locationOf, parseTotalLines } from './parse'
import type { SarifResult } from './parse'
import { runQlty } from './qlty'

const SECURITY_PLUGIN = /^(bandit|trufflehog|osv-scanner|zizmor|semgrep|checkov|gitleaks|trivy):/
const DUPLICATION_RULE = /^qlty:(identical|similar)-code$/
const COMPLEXITY_RULE = /complexity/

/** Cap on how many individual findings we list before summarizing the rest. */
const MAX_LISTED = 15

/** Sinks for the gate's output, so it can be driven and tested without globals. */
export interface GateIo {
  out: (message: string) => void
  err: (message: string) => void
}

/** Print each finding as `location: ruleId — message`, capped at MAX_LISTED. */
const listFindings = (print: (message: string) => void, results: SarifResult[]): void => {
  for (const r of results.slice(0, MAX_LISTED)) {
    print(`    ${locationOf(r)}: ${r.ruleId ?? '?'} — ${r.message?.text ?? ''}`)
  }
  if (results.length > MAX_LISTED) print(`    …and ${results.length - MAX_LISTED} more`)
}

/**
 * Gate a branch's diff (or the whole codebase with `--all`) on what qlty finds:
 *   1. lint & security issues  -> `qlty check`
 *   2. duplicated code         -> `qlty smells`
 *   3. over-complex code       -> `qlty smells`
 *
 * `qlty smells` always exits 0 (it's a report, not a gate); this wraps all three
 * into one pass/fail, printing a summary. Returns the process exit code:
 *   0 = within thresholds, 1 = a threshold was breached.
 */
export const runQltyDiffGate = (argv: string[], io: GateIo): number => {
  const config = buildConfig()
  const scope = resolveScope(argv, config)

  // 1. Lint & security issues, from qlty check at the configured level.
  const checkResults = extractResults(
    runQlty([
      'check',
      ...scope.args,
      '--no-fix',
      '--no-formatters',
      `--level=${config.checkLevel}`,
      '--sarif',
    ]),
    'check',
  )
  const securityCount = checkResults.filter((r) => SECURITY_PLUGIN.test(r.ruleId ?? '')).length

  // 2 & 3. Duplication and complexity, from qlty smells.
  const smellResults = extractResults(runQlty(['smells', ...scope.args, '--sarif']), 'smells')
  const duplication = smellResults.filter((r) => DUPLICATION_RULE.test(r.ruleId ?? ''))
  const dupLines = duplication.reduce((sum, r) => sum + linesOf(r), 0)
  const clusters = countClusters(duplication)
  const complexitySmells = smellResults.filter((r) => COMPLEXITY_RULE.test(r.ruleId ?? ''))

  // Denominator for the duplication %: total lines of the changed files.
  const totalLines = parseTotalLines(runQlty(['metrics', ...scope.args, '--quiet']))
  const dupPercent = totalLines > 0 ? (dupLines / totalLines) * 100 : 0

  const complexityLabel =
    config.maxComplexitySmells === Infinity ? 'off' : config.maxComplexitySmells

  io.out(`qlty diff gate (${scope.label}):`)
  io.out(
    `  issues:      ${checkResults.length} (${securityCount} security) at ${config.checkLevel}+ (max ${config.maxIssues})`,
  )
  io.out(
    `  duplication: ${dupPercent.toFixed(1)}% (${dupLines}/${totalLines} lines, ${clusters} clusters) (max ${config.maxDuplicatedPercent}%)`,
  )
  io.out(`  complexity:  ${complexitySmells.length} findings (max ${complexityLabel})`)
  // List complexity findings regardless of the gate — the gate is off by default,
  // so this is usually the only place they surface.
  listFindings(io.out, complexitySmells)

  let failed = false
  if (checkResults.length > config.maxIssues) {
    io.err(
      `✖ too many issues: ${checkResults.length} > ${config.maxIssues} (${config.checkLevel}+)`,
    )
    listFindings(io.err, checkResults)
    failed = true
    io.out(
      'Issues may not be caused by new code consider if they need fixing before increasing scope.',
    )
  }
  if (dupPercent > config.maxDuplicatedPercent) {
    io.err(`✖ duplication too high: ${dupPercent.toFixed(1)}% > ${config.maxDuplicatedPercent}%`)
    failed = true
  }
  if (complexitySmells.length > config.maxComplexitySmells) {
    io.err(
      `✖ complexity too high: ${complexitySmells.length} findings > ${config.maxComplexitySmells}`,
    )
    failed = true
  }

  if (failed) return 1
  io.out('✔ within thresholds')
  return 0
}
