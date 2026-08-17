/**
 * The public surface. `cli.ts` is deliberately **not** exported — it is an executable, not
 * an API, which is why `knip.json` gives it an explicit entry instead.
 */
export { buildConfig, effectiveSeverity, validateConfig } from './config'
export type { Config, ConfigError, ExcludeEntry, Override } from './config'
export { EXIT, runPromptLintGate } from './gate'
export type { ExitCode, GateIo, GateOptions, GateOutcome, NotEvaluated, Report } from './gate'
export { renderHuman, renderRuleExplanation, renderRuleList } from './report'
export { configurableRules, ruleById, RULE_IDS, RULES } from './rules'
export type { Finding, Rule, RuleId, Severity } from './rules'
export type { ArtifactKind, ScopeMode, ScopeSubset } from './scope'
