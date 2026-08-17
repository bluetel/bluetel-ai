/**
 * Every rule, in one array, plus the four bookkeeping declarations.
 *
 * The registry is what makes the rule set self-describing (FR-006): `--list-rules` and
 * `--explain` read it, `validateConfig` checks a severity override against it, and
 * `registry.test.ts` asserts the invariants that would otherwise be review conventions —
 * ids unique and `family/name`-shaped, statements and rationales non-empty, and every
 * rule able to produce a remediation (SC-006 enforced by a test rather than by reading).
 */
import { ALL_KINDS } from '../scope'

import { configMismatch } from './conventions'
import { declaredDependencyMissing } from './declared'
import { defineRule, type LocalRule, type Rule, type RuleId } from './define'
import { installRules } from './install'
import { metadataRules } from './metadata'
import { placeholderResidue } from './placeholders'
import { danglingPath } from './references'
import { sectionMissing } from './sections'
import { useWhenTrigger } from './trigger'

/**
 * The four rules that describe the run rather than an artifact's content. Their findings
 * are emitted by `gate.ts` — there is no content to check, only a fact about the run to
 * report — so their check bodies are empty by construction. They are declared here so
 * `--list-rules` and `--explain` cover them, and flagged `bookkeeping` so no severity
 * override or baseline entry can turn them off.
 */
const unclassifiedArtifact = defineRule(
  {
    id: 'artifact/unclassified',
    defaultSeverity: 'warn',
    statement: 'A file matched a declared artifact location but fits no kind (FR-004).',
    rationale:
      'The artifact set has grown a blind spot: no rule claims this file, so the gate would otherwise report a clean pass over something it never looked at.',
    appliesTo: ['unclassified'],
    dimension: 'correctness',
    scope: 'artifact',
    bookkeeping: true,
  },
  () => [],
)

const unreadableArtifact = defineRule(
  {
    id: 'artifact/unreadable',
    defaultSeverity: 'error',
    statement:
      'Every artifact in scope is readable UTF-8 text, is not a symlink, and is not empty.',
    rationale:
      'Rules that needed this file’s content are reported not-evaluated rather than passing. A dropped artifact is indistinguishable from a clean one.',
    appliesTo: ALL_KINDS,
    dimension: 'correctness',
    scope: 'artifact',
    bookkeeping: true,
  },
  () => [],
)

const unreasonedSuppression = defineRule(
  {
    id: 'suppression/unreasoned',
    defaultSeverity: 'error',
    statement: 'Every suppression comment carries a reason (FR-009).',
    rationale: 'An exemption nobody has to justify is not one.',
    appliesTo: ALL_KINDS,
    dimension: 'correctness',
    scope: 'artifact',
    bookkeeping: true,
  },
  () => [],
)

const staleSuppression = defineRule(
  {
    id: 'suppression/stale',
    defaultSeverity: 'warn',
    statement:
      'Every suppression, and every baseline.json entry, still matches something (FR-010).',
    rationale:
      'A suppression that has stopped matching is an exemption for a defect that is already fixed, and a baseline that never drains becomes permanent.',
    appliesTo: ALL_KINDS,
    dimension: 'correctness',
    scope: 'artifact',
    bookkeeping: true,
  },
  () => [],
)

export const BOOKKEEPING_RULES = {
  unclassifiedArtifact,
  unreadableArtifact,
  unreasonedSuppression,
  staleSuppression,
} as const

/** Every registered rule. The single source `--list-rules` and the cross-check read. */
export const RULES: Rule[] = [
  ...metadataRules,
  declaredDependencyMissing,
  danglingPath,
  sectionMissing,
  useWhenTrigger,
  placeholderResidue,
  configMismatch,
  ...installRules,
  ...Object.values(BOOKKEEPING_RULES),
]

export const RULE_IDS: RuleId[] = RULES.map((rule) => rule.id)

/** Look a rule up by id — `--explain` and suppression resolution both need this. */
export const ruleById = (id: string): Rule | undefined =>
  RULES.find((rule) => (rule.id as string) === id)

/** Rules whose severity a reviewer may promote or demote in `config.ts`. */
export const configurableRules = (): Rule[] => RULES.filter((rule) => rule.bookkeeping !== true)

/** Rules this repository evaluates itself, as opposed to the delegated ones. */
export const localRules = (): LocalRule[] =>
  RULES.filter((rule): rule is LocalRule => rule.source === 'prompt-lint')

/** Rules evaluated per artifact, per set, or per bundle. */
export const rulesByScope = (scope: Rule['scope']): Rule[] =>
  RULES.filter((rule) => rule.scope === scope)
