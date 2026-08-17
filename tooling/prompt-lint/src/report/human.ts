/**
 * The human report. Modelled on `qlty:diff`'s summary so the two gates read alike in a CI
 * log, with every rule below traceable to a requirement.
 *
 * - The verdict line is the **first and last** thing printed, because CI logs are read
 *   from both ends.
 * - Every finding prints what is wrong and a `→` fix; the remediation is never omitted
 *   (FR-007, SC-006).
 * - The list is capped and the omission is **counted**, never silent (FR-037).
 * - Paths are repo-relative; no timestamps, no absolute paths, no run duration (FR-039,
 *   SC-005). Those are the properties that rot silently, so the suite asserts them.
 * - An empty scope prints one explicit line (FR-040). It must not be possible to confuse
 *   "nothing to check" with a clean pass over a populated set.
 */
import type { Report } from '../gate'
import type { Finding, Severity } from '../rules'

const MARKER: Record<Severity, string> = { error: '✖', warn: '⚠', note: '·' }

export interface HumanOptions {
  /** Cap on the listed findings. The omitted count is always stated. */
  maxFindings: number
}

/** `prompt-lint (diff vs origin/main)` — what was looked at, in the header's first line. */
const scopeLabel = (report: Report): string => {
  if (report.scope.mode === 'all') return 'all artifacts'
  if (report.scope.mode === 'staged') return 'staged'
  return `diff vs ${report.scope.baseRef ?? 'the base ref'}`
}

const verdictLine = (report: Report): string =>
  report.verdict === 'fail' ? '✖ thresholds breached — see above' : '✔ within thresholds'

/** Indent a remediation's wrapped lines under the `→`. */
const renderFinding = (finding: Finding): string[] => {
  const bundle =
    finding.bundle === undefined ? '' : `                    [bundle ${finding.bundle}]`
  const location =
    finding.line > 0
      ? `${finding.path}:${String(finding.line)}`
      : // A bundle-scoped finding's location is a relationship, not a line.
        finding.path
  const baselined = finding.baselined === true ? '  [baselined: pre-existing at adoption]' : ''

  return [
    `${MARKER[finding.severity]} ${finding.rule}${bundle}`,
    `    ${location}`,
    `    ${finding.message}`,
    `    → ${finding.remediation}${baselined}`,
    '',
  ]
}

/** Render the report as the human output. Returns lines, so the suite can assert on them. */
export const renderHuman = (report: Report, options: HumanOptions): string[] => {
  const lines: string[] = []

  // FR-034: any override in effect is named up front, so a passing log cannot conceal a
  // relaxed threshold. Printed before the verdict because it changes what the verdict means.
  if (report.overrides.length > 0) {
    lines.push(
      `⚠ overrides in effect: ${report.overrides.map((o) => `${o.name}=${o.value}`).join(' ')}`,
      '  These exist for local investigation and must not be used to pass CI.',
    )
  }

  lines.push(
    `prompt-lint (${scopeLabel(report)}): ${String(report.scope.artifactCount)} artifacts, ${String(report.scope.excluded.length)} excluded`,
  )

  if (report.scope.artifactCount === 0 && report.findings.length === 0) {
    lines.push('  no AI-authored artifacts in scope', '', verdictLine(report))
    return lines
  }

  lines.push(
    `  errors:   ${String(report.counts.error)}  (max ${String(report.thresholds.maxErrors)})`,
    `  warnings: ${String(report.counts.warn)}  (max ${String(report.thresholds.maxWarnings)})`,
    `  notes:    ${String(report.counts.note)}`,
    '',
  )

  for (const finding of report.findings.slice(0, options.maxFindings)) {
    lines.push(...renderFinding(finding))
  }
  const omitted = report.findings.length - options.maxFindings
  if (omitted > 0) lines.push(`  …and ${String(omitted)} more (raise with --max-findings)`, '')

  if (report.notEvaluated.length > 0) {
    // Absence is always stated, never merely absent.
    lines.push('not evaluated:')
    for (const entry of report.notEvaluated) lines.push(`  ${entry.rule} — ${entry.reason}`)
    lines.push('')
  }

  lines.push(
    `suppressions: ${String(report.suppressions.used)} used, ${String(report.suppressions.stale.length)} stale     baseline: ${String(report.baseline.applied)} applied, ${String(report.baseline.stale)} stale`,
    verdictLine(report),
  )

  return lines
}

/** Render the rule catalogue for `--list-rules`. */
export const renderRuleList = (
  rules: readonly {
    id: string
    defaultSeverity: Severity
    statement: string
    source: string
  }[],
): string[] => [
  `prompt-lint: ${String(rules.length)} rules`,
  '',
  ...rules.flatMap((rule) => [
    `${rule.id}  [${rule.defaultSeverity}]  (${rule.source})`,
    `    ${rule.statement}`,
  ]),
]

/** Render one rule for `--explain`. */
export const renderRuleExplanation = (rule: {
  id: string
  defaultSeverity: Severity
  statement: string
  rationale: string
  appliesTo: readonly string[]
  dimension: string
  scope: string
  source: string
  bookkeeping?: true
}): string[] => [
  rule.id,
  '',
  `  ships as   ${rule.defaultSeverity}${rule.bookkeeping === true ? ' (not configurable — bookkeeping about the run)' : ''}`,
  `  source     ${rule.source}`,
  `  dimension  ${rule.dimension}`,
  `  scope      ${rule.scope}`,
  `  applies to ${rule.appliesTo.length === 0 ? '—' : rule.appliesTo.join(', ')}`,
  '',
  `  what   ${rule.statement}`,
  `  why    ${rule.rationale}`,
]
