/**
 * Every threshold, in one file (FR-034, SC-009). Each default can be overridden per run
 * via the environment variable named in [brackets], following the `QLTY_*` convention
 * in `tooling/qlty-diff/src/config.ts`.
 *
 * **The overrides exist for local investigation and must not be used to pass CI.** Any
 * override in effect is named in the report header, so a passing log cannot conceal a
 * relaxed threshold.
 *
 * There is deliberately **no** environment override for a per-rule severity or for the
 * exclusion list. Those change *what* is checked rather than *how strictly*, and
 * FR-034/SC-009 require such a change to appear in a diff.
 */
import process from 'node:process'

import type { RuleId, Severity } from './rules/define'

export interface ExcludeEntry {
  glob: string
  /** Non-empty. FR-005 requires an exclusion be explainable, not merely applied. */
  reason: string
}

export interface Config {
  /** Fails the gate above this. [PROMPT_LINT_MAX_ERRORS] */
  maxErrors: number
  /** High enough to admit the staged rules, low enough to notice a flood. [PROMPT_LINT_MAX_WARNINGS] */
  maxWarnings: number
  /** Compared against the analyser's score. Inert at 0 until measured. [PROMPT_LINT_MIN_SCORE] */
  minScore: number
  /** Per-rule severity override — the staged-adoption lever. */
  severities: Partial<Record<RuleId, Severity>>
  /** Path globs never evaluated, each with a recorded reason (FR-005). */
  exclude: ExcludeEntry[]
  /** [PROMPT_LINT_BASE_REF] */
  defaultBaseRef: string
}

/** An override in effect, so the report can describe the run that produced it. */
export interface Override {
  name: string
  value: string
}

export interface ConfigError {
  /** Which setting is wrong, for a message that names the thing to edit. */
  setting: string
  message: string
}

const envNum = (name: string, fallback: number, overrides: Override[]): number => {
  const raw = process.env[name]
  if (raw === undefined || raw.trim().length === 0) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  overrides.push({ name, value: raw })
  return parsed
}

const envStr = (name: string, fallback: string, overrides: Override[]): string => {
  const raw = process.env[name]
  if (raw === undefined || raw.trim().length === 0) return fallback
  overrides.push({ name, value: raw })
  return raw
}

/**
 * Rules that ship non-blocking because they have measured pre-existing violations on
 * this tree. Promotion is a reviewable edit to this object, in its own change — which
 * is the whole point of keeping the severity here rather than behind a flag.
 */
const SHIPPED_SEVERITIES: Partial<Record<RuleId, Severity>> = {}

const SHIPPED_EXCLUDE: ExcludeEntry[] = []

export interface BuiltConfig {
  config: Config
  overrides: Override[]
}

/** Build the effective config from the defaults plus any `PROMPT_LINT_*` overrides. */
export const buildConfig = (): BuiltConfig => {
  const overrides: Override[] = []
  const config: Config = {
    // [PROMPT_LINT_MAX_ERRORS]
    maxErrors: envNum('PROMPT_LINT_MAX_ERRORS', 0, overrides),
    // [PROMPT_LINT_MAX_WARNINGS]
    maxWarnings: envNum('PROMPT_LINT_MAX_WARNINGS', 50, overrides),
    // [PROMPT_LINT_MIN_SCORE]
    minScore: envNum('PROMPT_LINT_MIN_SCORE', 0, overrides),
    severities: { ...SHIPPED_SEVERITIES },
    exclude: SHIPPED_EXCLUDE.map((entry) => ({ ...entry })),
    // [PROMPT_LINT_BASE_REF]
    defaultBaseRef: envStr('PROMPT_LINT_BASE_REF', 'origin/main', overrides),
  }
  return { config, overrides }
}

export interface ValidateOptions {
  /** Every id in the registry, so an override naming nothing is caught (also catches renames). */
  knownRuleIds: readonly string[]
}

/**
 * Reject a contradictory config **before any artifact is read** (FR-036, exit 3). A
 * gate that can never pass, or an override that silently does nothing, is worse than a
 * red run: it looks like a working check.
 */
export const validateConfig = (config: Config, options: ValidateOptions): ConfigError[] => {
  const errors: ConfigError[] = []

  if (!Number.isInteger(config.maxErrors) || config.maxErrors < 0) {
    errors.push({ setting: 'maxErrors', message: 'maxErrors must be a non-negative integer.' })
  }
  if (!Number.isInteger(config.maxWarnings) || config.maxWarnings < 0) {
    errors.push({ setting: 'maxWarnings', message: 'maxWarnings must be a non-negative integer.' })
  }
  if (config.minScore < 0 || config.minScore > 100) {
    errors.push({
      setting: 'minScore',
      message: `minScore must be within 0–100; ${config.minScore} is unreachable in one direction or the other, which is a gate that can never pass or never fail.`,
    })
  }

  const known = new Set(options.knownRuleIds)
  for (const ruleId of Object.keys(config.severities)) {
    if (!known.has(ruleId)) {
      errors.push({
        setting: `severities['${ruleId}']`,
        message: `severities names '${ruleId}', which is not a registered rule. A severity override that matches nothing is silently ineffective — this is also what catches a rule rename.`,
      })
    }
  }

  config.exclude.forEach((entry, position) => {
    if (entry.reason.trim().length === 0) {
      errors.push({
        setting: `exclude[${position}]`,
        message: `the exclusion '${entry.glob}' has no reason. FR-005 requires every exclusion be explainable.`,
      })
    }
    if (entry.glob.trim().length === 0) {
      errors.push({ setting: `exclude[${position}]`, message: 'an exclusion has an empty glob.' })
    }
  })

  if (config.defaultBaseRef.trim().length === 0) {
    errors.push({ setting: 'defaultBaseRef', message: 'defaultBaseRef must name a ref.' })
  }

  return errors
}

/** The severity a rule actually reports at, after the config override. */
export const effectiveSeverity = (
  config: Config,
  ruleId: RuleId,
  defaultSeverity: Severity,
): Severity => config.severities[ruleId] ?? defaultSeverity
