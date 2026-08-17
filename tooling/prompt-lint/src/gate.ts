/**
 * The orchestration, one direction only:
 *
 *   validate config → resolve scope → load artifacts → run rules → suppress → baseline
 *   → order → verdict
 *
 * Two properties are the whole point of this file. First, **nothing is ever silently
 * skipped**: a rule that could not run against an artifact produces a `notEvaluated`
 * entry, and a rule that threw produces exit `5` naming itself and the artifact. Second,
 * the exit code says *which kind of thing went wrong* — "the prompts are wrong" (`1`)
 * versus "the tool could not run" (`3`/`4`/`5`/`6`) — because a red CI step whose cause
 * has to be inferred is a red step people learn to re-run.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Artifact, Suppression } from './artifact'
import { parseSkillMeta } from './artifact'
import { applyBaseline, emptyBaseline, loadBaseline } from './baseline'
import type { Baseline, BaselineResult } from './baseline'
import { buildConfig, effectiveSeverity, validateConfig } from './config'
import type { Config, Override } from './config'
import { countBySeverity, orderFindings } from './report/order'
import {
  appliesToKind,
  bookkeepingFinding,
  BOOKKEEPING_RULES,
  localRules,
  RULE_IDS,
  ruleById,
  unmetNeeds,
} from './rules'
import type { Finding, LocalRule, RuleContext, RuleId, Severity } from './rules'
import { fileAtRef, mergeBaseOf, resolveScope } from './scope'
import type { Exclusion, Scope, ScopeMode, ScopeSubset } from './scope'

/** Sinks for the gate's output, so it can be driven and tested without globals. */
export interface GateIo {
  out: (message: string) => void
  err: (message: string) => void
}

/**
 * The documented exit contract (`contracts/cli.md`). Callers may branch on these.
 */
export const EXIT = {
  /** Within thresholds — including the explicit nothing-in-scope case (FR-040). */
  ok: 0,
  /** A threshold was breached. */
  thresholds: 1,
  /** Usage error — unknown flag, mutually exclusive flags, unknown scope or explain target. */
  usage: 2,
  /** Configuration invalid; no artifact was evaluated (FR-036). */
  config: 3,
  /** Scope could not be established — base ref unresolvable, not a repository (FR-032). */
  scope: 4,
  /** Internal failure — a rule threw. Never reported as a clean pass. */
  internal: 5,
  /** The external analyser is unavailable, the wrong version, or failed on a payload. */
  analyser: 6,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

export interface NotEvaluated {
  rule: RuleId
  reason: string
}

export interface Report {
  verdict: 'pass' | 'fail'
  scope: {
    mode: ScopeMode
    baseRef?: string
    artifactCount: number
    universeCount: number
    excluded: Exclusion[]
  }
  notEvaluated: NotEvaluated[]
  findings: Finding[]
  counts: Record<Severity, number>
  thresholds: Config
  /** Overrides in effect, so the report is self-describing (FR-034). */
  overrides: Override[]
  suppressions: { used: number; stale: Finding[] }
  baseline: { applied: number; stale: number }
}

export interface GateOptions {
  repoRoot: string
  mode: ScopeMode
  baseRef?: string
  subset?: ScopeSubset
  /** Ignore `baseline.json` — shows the true state of the surface. */
  applyBaseline: boolean
  /**
   * Which baseline to read. Defaults to this package's own. It is not derived from
   * `repoRoot`, because the suite drives the gate against temporary repositories and a
   * baseline resolved from those would be a different file — or an unexpectedly real one.
   */
  baselinePath?: string
  /** Skip the delegated half entirely (FR-053). */
  rulesOnly: boolean
}

export interface GateOutcome {
  exitCode: ExitCode
  /** Absent when the run failed before any artifact could be evaluated. */
  report: Report | null
  /** Why the run failed, for the caller to print. Empty on a completed run. */
  failures: string[]
}

/** `.agents/skills.config`, parsed. It is `key=value`, the same format as `skill.meta`. */
const readSkillsConfig = (repoRoot: string): RuleContext['skillsConfig'] => {
  try {
    return parseSkillMeta(readFileSync(join(repoRoot, '.agents/skills.config'), 'utf8'))
  } catch {
    return null
  }
}

/** Everything a rule may read that is not the artifact itself. */
const buildContext = (options: GateOptions, scope: Scope): RuleContext => {
  const mergeBase =
    scope.mode === 'diff' && scope.baseRef !== undefined
      ? mergeBaseOf(options.repoRoot, scope.baseRef)
      : null

  return {
    universe: scope.universe,
    index: scope.index,
    skillsConfig: readSkillsConfig(options.repoRoot),
    deleted: scope.deleted,
    diff:
      mergeBase === null
        ? null
        : { baseRef: mergeBase, at: (path) => fileAtRef(options.repoRoot, mergeBase, path) },
  }
}

class RuleFailure extends Error {
  constructor(
    readonly ruleId: RuleId,
    readonly subject: string,
    readonly cause: unknown,
  ) {
    super(
      `${ruleId} threw while evaluating ${subject}: ${cause instanceof Error ? cause.message : 'unknown error'}`,
    )
  }
}

/** Run one rule, converting a throw into a named failure rather than a missing finding. */
const evaluate = (rule: LocalRule, input: Parameters<LocalRule['check']>[0]): Finding[] => {
  try {
    return rule.check(input)
  } catch (error) {
    if (error instanceof RuleFailure) throw error
    throw new RuleFailure(rule.id, input.artifact?.path ?? 'the artifact set', error)
  }
}

interface Evaluated {
  findings: Finding[]
  notEvaluated: NotEvaluated[]
}

/**
 * Run the per-artifact rules over `targets` and the set-scoped rules over `universe`.
 *
 * That asymmetry is stated once here and asserted in the suite, because getting it wrong
 * makes US1 §4 — a deleted file reported against the artifacts that still reference it —
 * silently pass.
 */
const runRules = (scope: Scope, context: RuleContext, widenToUniverse: Set<RuleId>): Evaluated => {
  const findings: Finding[] = []
  const skipped = new Map<RuleId, string>()

  for (const rule of localRules()) {
    if (rule.bookkeeping === true) continue

    if (rule.scope === 'set') {
      findings.push(...evaluate(rule, { ...context, artifact: null }))
      continue
    }
    if (rule.scope === 'bundle') continue

    const subjects = widenToUniverse.has(rule.id) ? scope.universe : scope.targets
    for (const artifact of subjects) {
      if (!appliesToKind(rule, artifact.kind)) continue

      const unmet = unmetNeeds(rule, artifact)
      if (unmet.length > 0) {
        // Recorded, never counted as passing: a rule that could not read the file it was
        // asked about has not checked anything.
        skipped.set(
          rule.id,
          `could not be evaluated against ${artifact.path} (${artifact.readError ?? unmet.join(', ')})`,
        )
        continue
      }
      findings.push(...evaluate(rule, { ...context, artifact }))
    }
  }

  return {
    findings,
    notEvaluated: [...skipped.entries()]
      .map(([rule, reason]) => ({ rule, reason }))
      .sort((a, b) => a.rule.localeCompare(b.rule)),
  }
}

/** The four rules that describe the run rather than an artifact's content. */
const bookkeeping = (artifacts: readonly Artifact[]): Finding[] => {
  const findings: Finding[] = []

  for (const artifact of artifacts) {
    if (artifact.kind === 'unclassified') {
      findings.push(
        bookkeepingFinding(BOOKKEEPING_RULES.unclassifiedArtifact, {
          path: artifact.path,
          line: 0,
          message: 'Matched a declared artifact location but fits no kind, so no rule claimed it.',
          remediation:
            'Give it a kind in `src/scope/classify.ts`, or exclude the location with a reason in `src/config.ts`.',
        }),
      )
    }
    if (artifact.readError !== null) {
      findings.push(
        bookkeepingFinding(BOOKKEEPING_RULES.unreadableArtifact, {
          path: artifact.path,
          line: 0,
          message: `Could not be read as an artifact: ${artifact.readError}.`,
          remediation:
            artifact.readError === 'empty'
              ? 'Write the body, or delete the file. An empty artifact installs and runs, and does nothing.'
              : 'Make the file readable UTF-8 text that is not a symlink.',
        }),
      )
    }
    for (const suppression of artifact.suppressions) {
      if (suppression.reason.trim().length > 0) continue
      findings.push(
        bookkeepingFinding(BOOKKEEPING_RULES.unreasonedSuppression, {
          path: artifact.path,
          line: suppression.markerLine,
          message: `Suppresses \`${suppression.rule}\` with no reason, so it exempts nothing.`,
          remediation:
            'Add the reason after an em dash: `<!-- prompt-lint-disable-next-line <rule> — why this is correct here -->`.',
        }),
      )
    }
  }

  return findings
}

/**
 * Apply reasoned suppressions, then report the ones that matched nothing.
 *
 * An **unreasoned** suppression deliberately exempts nothing (Scenario 7): it is itself a
 * finding, and letting it suppress as well would make the unreasoned form strictly more
 * powerful than the documented one.
 */
const applySuppressions = (
  findings: readonly Finding[],
  artifacts: readonly Artifact[],
): { kept: Finding[]; used: number; stale: Finding[] } => {
  const byPath = new Map<string, Suppression[]>()
  for (const artifact of artifacts) {
    if (artifact.suppressions.length > 0) byPath.set(artifact.path, artifact.suppressions)
  }

  const kept = findings.filter((finding) => {
    const match = byPath
      .get(finding.path)
      ?.find(
        (suppression) =>
          suppression.reason.trim().length > 0 &&
          suppression.rule === finding.rule &&
          suppression.targetLine === finding.line,
      )
    if (!match) return true
    match.used = true
    return false
  })

  const stale: Finding[] = []
  for (const [path, suppressions] of byPath) {
    for (const suppression of suppressions) {
      if (suppression.used || suppression.reason.trim().length === 0) continue
      const known = ruleById(suppression.rule) !== undefined
      stale.push(
        bookkeepingFinding(BOOKKEEPING_RULES.staleSuppression, {
          path,
          line: suppression.markerLine,
          message: known
            ? `Suppresses \`${suppression.rule}\`, which reported nothing on line ${String(suppression.targetLine)}.`
            : `Suppresses \`${suppression.rule}\`, which is not a registered rule.`,
          remediation: known
            ? 'Delete the suppression — the defect it exempted is fixed.'
            : 'Correct the rule id, or delete the suppression. Rule ids are permanent, so a rename is a retirement.',
        }),
      )
    }
  }

  let used = 0
  for (const suppressions of byPath.values()) {
    used += suppressions.filter((suppression) => suppression.used).length
  }

  return { kept, used, stale }
}

/** Apply the per-rule severity override. Bookkeeping rules are not configurable. */
const applySeverities = (config: Config, findings: readonly Finding[]): Finding[] =>
  findings.map((finding) => {
    const rule = ruleById(finding.rule)
    if (rule === undefined || rule.bookkeeping === true) return finding
    return { ...finding, severity: effectiveSeverity(config, finding.rule, rule.defaultSeverity) }
  })

/** Which artifact-scoped rules must widen to `universe` for this run. */
const widenedRules = (scope: Scope): Set<RuleId> => {
  // A deleted artifact leaves nothing in `targets` for the artifacts that still reference
  // it, so the reference rule has to look at the whole set or the finding vanishes.
  if (scope.deleted.length === 0) return new Set()
  return new Set<RuleId>(['refs/dangling-path'])
}

/** Run the gate. Returns the exit code, the report, and any reason the run could not finish. */
export const runPromptLintGate = (options: GateOptions): GateOutcome => {
  const { config, overrides } = buildConfig()

  const configErrors = validateConfig(config, { knownRuleIds: RULE_IDS })
  if (configErrors.length > 0) {
    return {
      exitCode: EXIT.config,
      report: null,
      failures: configErrors.map((error) => `${error.setting}: ${error.message}`),
    }
  }

  // Read before any artifact is, and for the same reason `validateConfig` runs first: a
  // `baseline.json` that cannot be parsed downgrades nothing, and a run that downgrades
  // nothing while the file says it should is indistinguishable from a clean pass. Exit `3`
  // is the honest code — the configuration is wrong, not the prompts — and it is reported
  // with no artifact evaluated (FR-036) rather than half a report.
  const loaded: BaselineResult<Baseline> = options.applyBaseline
    ? loadBaseline(options.baselinePath)
    : { ok: true, value: emptyBaseline(options.baselinePath) }
  if (!loaded.ok) {
    return { exitCode: EXIT.config, report: null, failures: [loaded.failure.message] }
  }
  const baseline = loaded.value

  const resolved = resolveScope({
    repoRoot: options.repoRoot,
    mode: options.mode,
    baseRef: options.baseRef ?? config.defaultBaseRef,
    subset: options.subset,
    exclude: config.exclude,
  })
  if (!resolved.ok) {
    return { exitCode: EXIT.scope, report: null, failures: [resolved.failure.message] }
  }
  const scope = resolved.value

  let raw: Finding[]
  let notEvaluated: NotEvaluated[]
  try {
    const evaluated = runRules(scope, buildContext(options, scope), widenedRules(scope))
    raw = [...evaluated.findings, ...bookkeeping(scope.targets)]
    notEvaluated = evaluated.notEvaluated
  } catch (error) {
    if (error instanceof RuleFailure) {
      return { exitCode: EXIT.internal, report: null, failures: [error.message] }
    }
    throw error
  }

  const suppressed = applySuppressions(raw, scope.targets)
  // The baseline runs **after** the severity override, never before: the override maps a
  // rule to its configured severity unconditionally, so the other order would put back the
  // `error` the baseline had just taken away.
  const based = applyBaseline(
    applySeverities(config, [...suppressed.kept, ...suppressed.stale]),
    baseline,
  )
  const findings = orderFindings([...based.findings, ...based.stale])
  const counts = countBySeverity(findings)

  const breached = counts.error > config.maxErrors || counts.warn > config.maxWarnings

  const report: Report = {
    verdict: breached ? 'fail' : 'pass',
    scope: {
      mode: scope.mode,
      ...(scope.baseRef === undefined ? {} : { baseRef: scope.baseRef }),
      artifactCount: scope.targets.length,
      universeCount: scope.universe.length,
      excluded: scope.exclusions,
    },
    notEvaluated,
    findings,
    counts,
    thresholds: config,
    overrides,
    suppressions: { used: suppressed.used, stale: suppressed.stale },
    baseline: { applied: based.applied, stale: based.stale.length },
  }

  return {
    exitCode: breached ? EXIT.thresholds : EXIT.ok,
    report,
    failures: [],
  }
}
