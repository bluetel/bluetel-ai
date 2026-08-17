/**
 * The types every rule speaks, and the one helper that stops twenty rule modules
 * being twenty copies of the same skeleton.
 *
 * `defineRule` is not a later cleanup: `qlty:diff`'s 10% duplication limit is the
 * binding constraint on a change that adds fifteen modules of identical shape
 * (Constitution IV), so the seam lands before the rules do. Concretely, a rule module
 * returns **drafts** — a message and a fix — and `defineRule` supplies the rule id,
 * the default severity and the artifact's path. Those three fields repeated across
 * twenty modules are the duplication.
 */
import type { Artifact, MetaBlock } from '../artifact'
import type { ArtifactKind, PathIndex } from '../scope'

export type Severity = 'error' | 'warn' | 'note'

/** A stable `family/name` identifier. Never renamed — retire instead (FR-006). */
export type RuleId = `${string}/${string}`

/** The four dimensions the external analyser owns. */
export type AnalyserDimension = 'redundancy' | 'density' | 'structure' | 'concentration'

/** `correctness` is ours and is never scored; the other four are the analyser's. */
export type Dimension = 'correctness' | AnalyserDimension

/**
 * `artifact` → once per artifact; `set` → once over the whole universe; `bundle` →
 * once per context bundle. `set` exists because three rules are properties of the
 * collection rather than of a file, and modelling them per-artifact is what would
 * force each of them to re-read the tree.
 */
export type RuleScope = 'artifact' | 'set' | 'bundle'

/**
 * Parsed views a check cannot run without. When one is missing the rule is recorded as
 * **not evaluated** for that artifact rather than as passing — the distinction the
 * whole report rests on.
 */
export type RuleNeed = 'content' | 'view' | 'meta'

export interface RelatedLocation {
  path: string
  line?: number
}

export interface Finding {
  rule: RuleId
  /** Effective severity, after the config override and the baseline (FR-008). */
  severity: Severity
  path: string
  /** 1-indexed. 0 for a bundle-scoped finding, which is about a set, not a line. */
  line: number
  column?: number
  /** Set for a bundle-scoped finding: which context bundle it was measured in. */
  bundle?: string
  /** Additional locations, for set-scoped rules — drift pairs, duplication clusters. */
  related?: RelatedLocation[]
  /** What is wrong. Names the offending value. */
  message: string
  /** What to do about it. Required, non-empty (FR-007, SC-006). */
  remediation: string
  /** Set when a baseline entry downgraded this finding, so the report can say so. */
  baselined?: boolean
}

/** What a rule module returns. Everything `defineRule` can supply is omitted. */
export interface FindingDraft {
  /** Defaults to the artifact under evaluation. Set it for a set-scoped rule. */
  path?: string
  /** 1-indexed. Defaults to 0, which reads as "about the file, not a line". */
  line?: number
  column?: number
  bundle?: string
  related?: RelatedLocation[]
  message: string
  remediation: string
}

/**
 * A file's content at the base of the comparison. `install/version-bump` asks a
 * question about two revisions rather than about one file, and this is the only way it
 * gets to. Null under `--all`, where the rule is reported not-evaluated.
 */
export interface DiffContext {
  baseRef: string
  at: (path: string) => string | null
}

/** Everything a rule may read that is not the artifact itself. */
export interface RuleContext {
  /** Every artifact in the declared set — what set-scoped rules run over. */
  universe: readonly Artifact[]
  index: PathIndex
  /** `.agents/skills.config`, parsed. Null when the repo has none. */
  skillsConfig: MetaBlock | null
  /** Paths the comparison deleted. */
  deleted: readonly string[]
  diff: DiffContext | null
}

export interface RuleInput extends RuleContext {
  /** Null for a set-scoped rule, which is about the collection rather than a file. */
  artifact: Artifact | null
}

interface RuleDeclaration {
  id: RuleId
  /** Ships as this; overridable per rule in `config.ts`. */
  defaultSeverity: Severity
  /** One line: what it enforces. Surfaced by `--list-rules`. */
  statement: string
  /** Why it matters. Surfaced in `--explain` and in `docs/rules.md`. */
  rationale: string
  appliesTo: ArtifactKind[]
  dimension: Dimension
  scope: RuleScope
  needs?: RuleNeed[]
  /**
   * True for the four rules that describe the *run* rather than an artifact's content —
   * an unreadable file, an unreasoned suppression. They have no configurable severity and
   * cannot be baselined: a report that cannot say "I could not read this file" is worse
   * than a red one.
   */
  bookkeeping?: true
}

export interface LocalRule extends RuleDeclaration {
  source: 'prompt-lint'
  check: (input: RuleInput) => Finding[]
}

/**
 * Declared here for `--list-rules`, `--explain` and the catalogue cross-check;
 * evaluated by the external analyser. It has no `check` body and every other property
 * of a rule, which is what keeps FR-047 true across the split.
 */
export interface DelegatedRule extends RuleDeclaration {
  source: 'contextops'
}

export type Rule = LocalRule | DelegatedRule

/** Does this rule have anything to say about an artifact of this kind? */
export const appliesToKind = (rule: Rule, kind: ArtifactKind): boolean =>
  rule.appliesTo.includes(kind)

/** Which of a rule's needs this artifact cannot satisfy. Empty means it can run. */
export const unmetNeeds = (rule: Rule, artifact: Artifact): RuleNeed[] =>
  (rule.needs ?? []).filter((need) => {
    if (need === 'content') return artifact.content === null
    if (need === 'view') return artifact.view === null
    return artifact.meta === null
  })

/** Turn a draft into a finding, supplying everything the rule should not have to repeat. */
const finalise = (declaration: RuleDeclaration, input: RuleInput, draft: FindingDraft): Finding => {
  const path = draft.path ?? input.artifact?.path
  if (path === undefined) {
    throw new Error(
      `${declaration.id} produced a finding with no path and no artifact in scope — a set-scoped rule must name the file it is about.`,
    )
  }
  if (draft.remediation.trim().length === 0) {
    // SC-006 as a runtime invariant as well as a registry test: a rule that cannot say
    // how to fix its finding is a rule that trains people to ignore it.
    throw new Error(`${declaration.id} produced a finding with an empty remediation.`)
  }
  return {
    rule: declaration.id,
    severity: declaration.defaultSeverity,
    path,
    line: draft.line ?? 0,
    ...(draft.column === undefined ? {} : { column: draft.column }),
    ...(draft.bundle === undefined ? {} : { bundle: draft.bundle }),
    related: draft.related ?? [],
    message: draft.message,
    remediation: draft.remediation,
  }
}

/**
 * Declare a rule this repository evaluates. `check` returns drafts; the id, the
 * severity and the path are supplied here exactly once.
 */
export const defineRule = (
  declaration: RuleDeclaration,
  check: (input: RuleInput) => FindingDraft[],
): LocalRule => ({
  ...declaration,
  source: 'prompt-lint',
  check: (input) => check(input).map((draft) => finalise(declaration, input, draft)),
})

/** Declare a rule the external analyser evaluates. No body, every other property. */
export const defineDelegatedRule = (declaration: RuleDeclaration): DelegatedRule => ({
  ...declaration,
  source: 'contextops',
})

/**
 * Build a bookkeeping finding. These four rules are emitted by the evaluator rather than
 * by a check body, because they describe the run rather than an artifact's content — but
 * they go through the same finalisation so the non-empty-remediation invariant holds for
 * them too.
 */
const EMPTY_CONTEXT: RuleContext = {
  universe: [],
  index: { has: () => false, isDirectory: () => false, under: () => [] },
  skillsConfig: null,
  deleted: [],
  diff: null,
}

export const bookkeepingFinding = (rule: Rule, draft: FindingDraft & { path: string }): Finding => {
  if (rule.bookkeeping !== true) {
    throw new Error(`${rule.id} is not a bookkeeping rule and must produce findings from its check`)
  }
  return finalise(rule, { ...EMPTY_CONTEXT, artifact: null }, draft)
}

/**
 * Narrow a rule input to the artifact-scoped case. Every per-artifact rule opens with
 * this, so none of them repeats a null check the evaluator has already made by
 * consulting `appliesTo` and `needs`.
 */
export const requireArtifact = (input: RuleInput): Artifact => {
  if (input.artifact === null) {
    throw new Error('an artifact-scoped rule was evaluated with no artifact')
  }
  return input.artifact
}
