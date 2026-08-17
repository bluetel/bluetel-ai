/**
 * The one deterministic ordering, used everywhere (FR-029, SC-005): severity
 * descending, then `path`, then `line`, then `rule`.
 *
 * Total and stable, so byte-identical output over an identical tree is a structural
 * property rather than something the report has to remember to do. The suite asserts a
 * shuffled input produces an identical output, because the failure mode is silent: an
 * ordering that is *nearly* total produces diffs that look like real changes.
 */
import type { Finding, Severity } from '../rules/define'

/** Descending gate impact. The order findings are printed and serialised in. */
const SEVERITY_RANK: Record<Severity, number> = { error: 0, warn: 1, note: 2 }

/** Compare two findings by the total ordering. */
export const compareFindings = (a: Finding, b: Finding): number =>
  SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
  a.path.localeCompare(b.path) ||
  a.line - b.line ||
  a.rule.localeCompare(b.rule) ||
  // Two findings from one rule on one line differ only in what they say, so the message
  // is the last tiebreak. Without it the ordering is not total and the output churns.
  a.message.localeCompare(b.message)

/** Sort findings into the canonical order. Does not mutate its input. */
export const orderFindings = (findings: readonly Finding[]): Finding[] =>
  [...findings].sort(compareFindings)

/** Count findings by severity. Always all three keys, `0` rather than absent. */
export const countBySeverity = (findings: readonly Finding[]): Record<Severity, number> => {
  const counts: Record<Severity, number> = { error: 0, warn: 0, note: 0 }
  for (const finding of findings) counts[finding.severity] += 1
  return counts
}
