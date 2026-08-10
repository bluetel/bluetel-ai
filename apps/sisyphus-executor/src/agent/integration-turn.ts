/**
 * The two turns the integrate step needs (T196, FR-057, FR-058, FR-061, FR-117, FR-118).
 *
 * `sisyphus-integration` is read twice by one run and for two different reasons, and the two turns
 * are kept apart because the questions are:
 *
 * - **The plan** — what order the repositories integrate in, and what actions the skill prescribes.
 *   Asked once, and for a multi-repository run asked *early*, because the promotion order goes into
 *   every pull request's cross-reference the moment the set is opened (FR-116, FR-117), which is
 *   one whole review before anything is merged.
 * - **One step** — perform the action the plan named against one repository, and report a reference
 *   a human can follow.
 *
 * ## Nothing in either turn says what integration means
 *
 * No merge strategy, no environment, no tag format, no notion of "done". `integration-step.ts` is
 * emphatic that all of it is the client's business, and this file is where it would leak in if it
 * were going to. What is composed here is a request for a *shape* — an ordered list of entry ids, a
 * list of named actions, a reference string — and the shape is the platform's record-keeping rather
 * than an opinion about deployment.
 *
 * ## The order is asked for as entry ids, and refused as anything else
 *
 * `requirePromotionOrder` places entries by id and halts when the skill is silent, partial, or
 * names a repository the workspace does not have. Asking in the vocabulary it validates in is what
 * makes that halt say "the skill did not declare an order" rather than "the order could not be
 * parsed", and the first is the sentence an operator can act on.
 */

import type { ResolvedSkill } from '../skills'
import type { DeclaredIntegrationStep } from '../workflows'

import { answerMarkers } from './proposal-block'

/** Names the plan block for a human reading the log. */
export const INTEGRATION_PLAN_TAG = 'sisyphus-integration-plan'

/** Names one performed step's block. Distinct from the plan's, because both are in one run. */
export const INTEGRATION_STEP_TAG = 'sisyphus-integration-step'

/** Delimits the quoted skill, so its text is never confused with the executor's own. */
const skillFence = (name: string): { readonly open: string; readonly close: string } => ({
  open: `<<<skill:${name}`,
  close: `skill:${name}>>>`,
})

const quoteSkill = (skill: ResolvedSkill): readonly string[] => {
  const fence = skillFence(skill.skillName)

  return [
    `The ${skill.skillName} skill below was read from ${skill.resolvedPath} in the primary ` +
      `repository (sha256 ${skill.contentDigest}). It is the instruction for this step. Follow it ` +
      'as written; the platform adds nothing to it.',
    '',
    fence.open,
    skill.body,
    fence.close,
  ]
}

/**
 * The plan's reporting contract.
 *
 * Both keys are optional in the shape and neither is optional in effect: a workspace of several
 * entries whose plan carries no `order` halts in `requirePromotionOrder` (FR-117), and a plan with
 * no `steps` is a run that performs nothing and says so. The wording states both, because an agent
 * that thinks an omission will be filled in has been given a reason to omit.
 */
export const renderPlanReportInstruction = (nonce: string): string => {
  const { open, close } = answerMarkers(INTEGRATION_PLAN_TAG, nonce)

  return [
    'Report the plan by emitting exactly one block in this form, as ordinary assistant output:',
    '',
    open,
    '{ ... a single JSON object ... }',
    close,
    '',
    'The JSON object carries these keys:',
    '',
    '- `order`: an object with `entryIds` — every workspace entry id from the list above, in the ' +
      'order the skill says they must be integrated, first to last. Where the workspace has more ' +
      'than one entry this is required: nothing chooses an order if the skill does not, and the ' +
      'run stops rather than promoting a consumer before what it depends on.',
    '- `steps`: a list of the actions the skill prescribes, each with `entryId`, `name` (the ' +
      'skill’s own word for the action) and `instruction` (what it says to do, in the skill’s ' +
      'words). An empty list is a legitimate answer and means the skill prescribes nothing to do ' +
      'here; it is recorded as exactly that.',
    '',
    'Take no action yet. This turn reads the skill and reports what it says; each step is ' +
      'requested separately, in the order you give.',
  ].join('\n')
}

export interface IntegrationPlanTurnOptions {
  /** `sisyphus-integration`, as `resolveIntegrationPlan` read it. */
  readonly skill: ResolvedSkill
  readonly nonce: string
}

/**
 * Compose the turn that reads the integration plan.
 *
 * @param options - The resolved skill and this request's nonce.
 * @returns The text written to the live conversation as one user turn.
 */
export const integrationPlanTurnBody = (options: IntegrationPlanTurnOptions): string =>
  [
    'Integration plan.',
    '',
    ...quoteSkill(options.skill),
    '',
    renderPlanReportInstruction(options.nonce),
  ].join('\n')

/** One step's reporting contract. One key, because one fact is being asked for. */
export const renderStepReportInstruction = (nonce: string): string => {
  const { open, close } = answerMarkers(INTEGRATION_STEP_TAG, nonce)

  return [
    'When the step is done, report it by emitting exactly one block in this form, as ordinary ' +
      'assistant output:',
    '',
    open,
    '{ ... a single JSON object ... }',
    close,
    '',
    'The JSON object carries one key:',
    '',
    '- `reference`: something a person can follow to see that this happened — a merge commit sha, ' +
      'a pipeline run URL, a tag. It is recorded against the run as the evidence for this step.',
    '',
    'If the step did not happen, do not emit the block. Say what stopped you instead: the run ' +
      'records this step as failed, stops before the ones after it, and reports the partial state ' +
      'rather than plain success. A reference for something that did not happen is worse than the ' +
      'failure, because nothing downstream can tell the difference.',
  ].join('\n')
}

export interface IntegrationStepTurnOptions {
  /**
   * The skill this step follows, when the run has read it.
   *
   * **Named, not re-quoted.** The plan turn quoted it in full into this same conversation minutes
   * earlier, and a run performs several steps against one plan — repeating the whole body per step
   * would push the thing that matters, the one instruction below, further from the request each
   * time. What is repeated is the name and the digest, so the transcript records which reading of
   * the skill each step followed even after the skill changes (FR-059).
   */
  readonly skill?: ResolvedSkill
  readonly step: DeclaredIntegrationStep
  /**
   * The run's key for this action, offered to the agent.
   *
   * Not the deduplication mechanism — that is `performExternalAction`'s durable claim, taken before
   * this turn is ever written (FR-076, FR-077). It is here so a step whose host *does* honour an
   * idempotency key, or whose action is naturally keyed (a tag name, a branch), can use the run's
   * own identifier rather than inventing one.
   */
  readonly idempotencyKey: string
  readonly nonce: string
}

/**
 * Compose the turn that performs one integration step.
 *
 * @param options - The skill, the step the plan named, the run's key for it, and the nonce.
 * @returns The text written to the live conversation as one user turn.
 */
export const integrationStepTurnBody = (options: IntegrationStepTurnOptions): string =>
  [
    `Integration step "${options.step.name}" on workspace entry ${options.step.entryId}.`,
    '',
    options.skill === undefined
      ? 'This step follows the integration plan reported earlier in this conversation.'
      : `This step follows ${options.skill.skillName} as read from ` +
        `${options.skill.resolvedPath} (sha256 ${options.skill.contentDigest}) and quoted in full ` +
        'earlier in this conversation.',
    '',
    'This is the action the plan named, in the skill’s own words:',
    '',
    options.step.instruction,
    '',
    `Perform exactly that action and nothing beyond it. This run's key for it is ` +
      `${options.idempotencyKey}; use it wherever the action can carry one, so a repeat cannot ` +
      'produce a second.',
    '',
    renderStepReportInstruction(options.nonce),
  ].join('\n')
