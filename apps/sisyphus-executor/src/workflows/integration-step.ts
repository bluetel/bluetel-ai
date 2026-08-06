/**
 * The `sisyphus-integration` step (T126, FR-057, FR-058, FR-061, FR-076, FR-117, FR-118).
 *
 * The last leg of an autonomous run: the review passed, and what happens to the pull requests now
 * — merge, promote, tag, deploy, wait for a human, do nothing at all — is entirely the client's
 * business. There is no merge strategy in this file, no target environment and no idea of what
 * "integrated" means beyond "the steps the skill listed were performed".
 *
 * ## Order comes from the skill, never from here (FR-117)
 *
 * Where a run spans repositories, which one merges first is a fact about the client's deployment,
 * and getting it wrong breaks production between two deploys rather than failing loudly.
 * `requirePromotionOrder` is the whole of the decision: it places every entry in the order the
 * skill declared and halts when the skill is silent, partial, or names a repository the workspace
 * does not contain. A single-entry workspace is the one case it will order without a declaration,
 * because one permutation of one item chooses nothing.
 *
 * ## Stops at the first failure, and says where it stopped
 *
 * Integration steps are ordered because they depend on each other. Carrying on past a failure would
 * promote the second repository into a world where the first one never landed — the exact half-
 * applied state the order exists to prevent. So the run stops, and every entry gets a recorded
 * result: performed, refused, or `not_attempted` for the ones after the failure. FR-118 requires
 * the terminal outcome to state a partial result rather than report plain success, and
 * `not_attempted` is what makes "we never got there" distinguishable from "it went wrong there".
 *
 * ## Each step at most once
 *
 * A merge that runs twice is visible to the customer and sometimes not undoable. Every step goes
 * through `performExternalAction` keyed on the run, the entry and the step's own name — the step
 * name is in the key because a skill legitimately prescribes several actions per repository, and a
 * key of the repository alone would swallow all but the first.
 */

import { performExternalAction, requirePromotionOrder } from '../delivery'
import type { ExternalActionLedger, DeclaredPromotionOrder } from '../delivery'
import type { ResolvedSkill, SkillReferenceReporter, SkillSource } from '../skills'
import { haltForSkill, resolveSkill } from '../skills'

import type { SkillDirective } from './skill-directive'
import { directiveFrom } from './skill-directive'

/** The skill every integration action is read from. */
export const INTEGRATION_SKILL = 'sisyphus-integration'

/** The step named in a halt, per FR-058. */
export const INTEGRATION_STEP = 'integrate'

/** The action name in the idempotency key. */
export const INTEGRATION_ACTION = 'integration-step'

/** One action the skill prescribed for one repository. */
export interface DeclaredIntegrationStep {
  readonly entryId: string
  /** What the skill calls this action. Free text; Sisyphus names no integration actions. */
  readonly name: string
  /** What it says to do, in the skill's words. Carried into the directive. */
  readonly instruction: string
}

/** What the agent read out of `sisyphus-integration`. */
export interface DeclaredIntegrationPlan {
  readonly order?: Partial<DeclaredPromotionOrder>
  readonly steps?: readonly DeclaredIntegrationStep[]
}

export type IntegrationPlanner = (skill: ResolvedSkill) => Promise<DeclaredIntegrationPlan>

/** Whatever performing one step produced, as the port reports it. */
export interface IntegrationStepRef {
  readonly entryId: string
  readonly name: string
  /** A reference a human can follow — a merge commit, a run URL, a tag. */
  readonly reference: string
}

export type IntegrationPort = (input: {
  readonly entryId: string
  readonly name: string
  readonly instruction: string
  readonly idempotencyKey: string
}) => Promise<IntegrationStepRef>

/** What happened to one prescribed step. */
export type IntegrationStepResult =
  | {
      readonly status: 'performed'
      readonly step: DeclaredIntegrationStep
      readonly ref: IntegrationStepRef
      readonly directive: SkillDirective
    }
  | { readonly status: 'failed'; readonly step: DeclaredIntegrationStep; readonly reason: string }
  | {
      readonly status: 'not_attempted'
      readonly step: DeclaredIntegrationStep
      readonly reason: string
    }

export interface IntegrationOutcome {
  readonly skill: ResolvedSkill
  /** Entry ids in the order the skill declared them (FR-117). */
  readonly order: readonly string[]
  readonly results: readonly IntegrationStepResult[]
  /** True when every prescribed step was performed. */
  readonly complete: boolean
  /** True when some steps landed and some did not — FR-118's partial state. */
  readonly isPartial: boolean
  /** One sentence stating where the run got to. Always present, even on a clean run. */
  readonly statement: string
}

export interface IntegrationStepInput {
  readonly workflowId: string
  readonly source: SkillSource
  readonly report: SkillReferenceReporter
  readonly planner: IntegrationPlanner
  readonly integrator: IntegrationPort
  /** Every entry of the workspace, so the declared order can be checked against it. */
  readonly entries: readonly { readonly entryId: string }[]
  readonly ledger: ExternalActionLedger<IntegrationStepRef>
  /**
   * A plan already resolved earlier in the run.
   *
   * The promotion order is needed **before** the integrate step: a multi-repository run puts the
   * order into every pull request's cross-reference the moment the set is opened (FR-116, FR-117),
   * which is several minutes and one whole review earlier. Passing that resolution back in keeps
   * the run acting on one reading of one file — resolving twice would let a skill edited mid-run
   * order the pull requests one way and the merges another.
   */
  readonly resolved?: ResolvedIntegrationPlan
}

/** `sisyphus-integration` as it was read, with what the agent got out of it. */
export interface ResolvedIntegrationPlan {
  readonly skill: ResolvedSkill
  readonly plan: DeclaredIntegrationPlan
}

/**
 * Resolve `sisyphus-integration` and read the plan out of it.
 *
 * Separate from {@link runIntegrationStep} because the promotion order is needed at delivery time
 * and the steps are not needed until much later; see {@link IntegrationStepInput.resolved}.
 *
 * @param input - Where the skills are and the agent boundary.
 * @throws When the skill is missing, unreadable or self-contradictory (FR-058).
 */
export const resolveIntegrationPlan = async (input: {
  readonly source: SkillSource
  readonly report: SkillReferenceReporter
  readonly planner: IntegrationPlanner
}): Promise<ResolvedIntegrationPlan> => {
  const skill = await resolveSkill(INTEGRATION_SKILL, {
    source: input.source,
    step: INTEGRATION_STEP,
    report: input.report,
  })

  return { skill, plan: await input.planner(skill) }
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const statementFor = (results: readonly IntegrationStepResult[]): string => {
  const performed = results.filter((result) => result.status === 'performed').length
  const failed = results.filter((result) => result.status === 'failed')
  const skipped = results.filter((result) => result.status === 'not_attempted').length

  if (results.length === 0) {
    return `${INTEGRATION_SKILL} prescribes no integration steps for this run, so none were taken.`
  }

  if (failed.length === 0 && skipped === 0) {
    return `Every one of the ${String(results.length)} step(s) ${INTEGRATION_SKILL} prescribes was performed.`
  }

  // `failed` is only ever empty here if a step was skipped without one failing, which the loop
  // below cannot produce; describing it rather than asserting keeps the sentence true either way.
  const where = failed
    .map((result) => `"${result.step.name}" on ${result.step.entryId} failed`)
    .join('; ')

  return (
    `${String(performed)} of ${String(results.length)} integration step(s) were performed; ` +
    `${where === '' ? 'the run stopped' : where}, and ${String(skipped)} were not attempted. ` +
    'This is a partial integration, not a success.'
  )
}

/**
 * Follow `sisyphus-integration`.
 *
 * @param input - The workspace, the agent boundary, and the port that performs a step.
 * @returns Every step's result, in the order the skill declared.
 * @throws When the skill cannot be used, is silent about the order across repositories, or names a
 *   repository the workspace does not contain.
 */
export const runIntegrationStep = async (
  input: IntegrationStepInput,
): Promise<IntegrationOutcome> => {
  const skillOptions = { source: input.source, step: INTEGRATION_STEP, report: input.report }
  const { skill, plan } = input.resolved ?? (await resolveIntegrationPlan(input))

  // Halts when the skill is silent across a multi-repository workspace (FR-117). A single entry is
  // ordered without a declaration because one permutation of one item chooses nothing.
  const ordered = requirePromotionOrder(plan.order, {
    entries: input.entries,
    step: INTEGRATION_STEP,
  })
  const order = ordered.map((placed) => placed.entry.entryId)

  const declared = plan.steps ?? []
  const unknown = declared.filter((step) => !order.includes(step.entryId))

  if (unknown.length > 0) {
    return haltForSkill(INTEGRATION_SKILL, {
      ...skillOptions,
      resolvedPath: skill.resolvedPath,
      reason:
        `it prescribes steps for ${unknown.map((step) => `"${step.entryId}"`).join(', ')}, which ` +
        'the promotion order does not place. The skill contradicts itself about which ' +
        'repositories this run integrates',
    })
  }

  // Sorted into the declared order rather than run in the order they were listed: FR-117 makes the
  // order the skill's to state, and the two lists disagreeing is a case worth resolving in favour
  // of the one the requirement names.
  const sequenced = [...declared].sort(
    (left, right) => order.indexOf(left.entryId) - order.indexOf(right.entryId),
  )

  const results: IntegrationStepResult[] = []
  let stopped = false

  for (const step of sequenced) {
    if (stopped) {
      results.push({
        status: 'not_attempted',
        step,
        reason: 'An earlier integration step failed, so this one was not attempted.',
      })
      continue
    }

    try {
      const outcome = await performExternalAction(input.ledger, {
        identity: {
          action: INTEGRATION_ACTION,
          workflowId: input.workflowId,
          target: [step.entryId, step.name],
        },
        perform: async (idempotencyKey) =>
          input.integrator({
            entryId: step.entryId,
            name: step.name,
            instruction: step.instruction,
            idempotencyKey,
          }),
      })

      results.push({
        status: 'performed',
        step,
        ref: outcome.result,
        directive: directiveFrom(skill, {
          step: INTEGRATION_STEP,
          instruction: step.instruction,
        }),
      })
    } catch (cause) {
      results.push({ status: 'failed', step, reason: messageOf(cause) })
      stopped = true
    }
  }

  const performed = results.filter((result) => result.status === 'performed').length

  return {
    skill,
    order,
    results,
    complete: results.length > 0 && performed === results.length,
    isPartial: performed > 0 && performed < results.length,
    statement: statementFor(results),
  }
}
