/**
 * `IntegrationPlanner` and `IntegrationPort`, implemented against a live agent (T196, FR-057,
 * FR-058, FR-061, FR-117, FR-118, US4).
 *
 * The last leg of an autonomous run, and until this existed the leg had no implementation at all:
 * `runAutonomousWorkflow` takes both ports as required arguments and the composition root supplied
 * neither, so every autonomous run halted before it was launched.
 *
 * ## Why the agent performs the step rather than this executor
 *
 * `integration-step.ts` is explicit that what "integrated" means — merge, promote, tag, deploy,
 * wait for a human, do nothing — is the client's business and is stated in `sisyphus-integration`
 * as prose. There is no API this executor could call that covers that set, and a port that
 * translated the prose into one (a merge, always) would be Sisyphus's opinion about deployment
 * applied to every client's estate. So the instruction is handed to the agent verbatim, exactly as
 * the development pass's is, and the agent has the workspace and the credentials the client's own
 * setup bundle installed.
 *
 * ## What the agent is *not* allowed to decide
 *
 * The step's identity. {@link createAgentIntegrationPort} echoes `entryId` and `name` from the
 * request it was given and takes only `reference` from the block. That is not defensive
 * pedantry: `runIntegrationStep` records the result against the entry it asked about and claims the
 * external action on a key built from it, so an agent that answered with a different entry id would
 * file a merge of one repository as evidence that another had been merged. The one field the agent
 * is the authority on — where a human can go to see that this happened — is the one it supplies.
 *
 * ## A step with no block is a failed step, and that is the recorded outcome
 *
 * `runIntegrationStep` wraps each call in a `try` and turns a rejection into
 * `{ status: 'failed' }`, stops, and marks every later step `not_attempted` — which is FR-118's
 * partial state. So an {@link AgentIntegrationError} thrown here is not a crash; it is the
 * mechanism by which "the agent could not merge it" reaches the terminal report as a partial
 * integration rather than as success.
 */

import { randomUUID } from 'node:crypto'

import type { ResolvedSkill } from '../skills'
import type {
  DeclaredIntegrationPlan,
  IntegrationPlanner,
  IntegrationPort,
  IntegrationStepRef,
} from '../workflows'

import type { AgentAdapter } from './adapter'
import type { FrameTap } from './frame-tap'
import { readIntegrationPlan } from './integration-plan'
import {
  INTEGRATION_PLAN_TAG,
  INTEGRATION_STEP_TAG,
  integrationPlanTurnBody,
  integrationStepTurnBody,
} from './integration-turn'
import type { AgentAnswerFailure } from './structured-turn'
import { askAgentForBlock } from './structured-turn'

/** A backstop for reading the skill. This turn takes no action, so it is the shorter of the two. */
export const DEFAULT_PLAN_DEADLINE_MS = 10 * 60_000

/**
 * A backstop for performing one step.
 *
 * Generous, because a step can legitimately be "wait for the pipeline": a merge that triggers a
 * deployment is one action to the skill and several minutes to everybody else.
 */
export const DEFAULT_STEP_DEADLINE_MS = 30 * 60_000

/** Why an integration turn produced nothing usable. */
export type AgentIntegrationFailure =
  | AgentAnswerFailure
  /** A block that parsed and carries none of the fields asked for. */
  | 'empty'
  /** A block that parsed and states something that cannot be used. */
  | 'unusable'

export class AgentIntegrationError extends Error {
  readonly kind: AgentIntegrationFailure

  constructor(options: {
    readonly kind: AgentIntegrationFailure
    /** What was being asked for, so a failure says whether anything was attempted. */
    readonly what: string
    readonly detail: string
  }) {
    super(
      `${options.what} produced no usable answer: ${options.detail}. Nothing is assumed about ` +
        'what happened outside the platform — an integration recorded here without the agent ' +
        'having reported it would be evidence for something nobody can check (FR-057, FR-118).',
    )
    this.name = 'AgentIntegrationError'
    this.kind = options.kind
  }
}

export interface AgentIntegrationPortsOptions {
  /** The live conversation. Only `sendTurn`: these ports never start or stop the agent. */
  readonly agent: Pick<AgentAdapter, 'sendTurn'>
  /** Frames as the run's own consumer pulls them; see `frame-tap.ts`. */
  readonly frames: Pick<FrameTap, 'subscribe'>
  readonly planDeadlineMs?: number
  readonly stepDeadlineMs?: number
  readonly settleMs?: number
  readonly turnTimeoutMs?: number
  /** Injected in tests, so a transcript can be written by hand. Random otherwise. */
  readonly nonce?: () => string
}

const timings = (
  options: AgentIntegrationPortsOptions,
): { readonly settleMs?: number; readonly turnTimeoutMs?: number } => ({
  ...(options.settleMs === undefined ? {} : { settleMs: options.settleMs }),
  ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
})

/** The two ports, built together. See {@link createAgentIntegrationPorts} on why together. */
export interface AgentIntegrationPorts {
  readonly planner: IntegrationPlanner
  readonly integrator: IntegrationPort
}

/**
 * Build both integration ports over one conversation.
 *
 * **One factory rather than two, because the second port needs something only the first learns.**
 * `AutonomousWorkflowInput` takes `planner` and `integrator` as separate values, built before the
 * run starts — but `sisyphus-integration` is not resolved until the workflow asks for it, and a
 * step's turn is more useful when it can name the reading of the skill it is following (FR-059).
 * The planner is the only thing that ever sees that reading, so it records it here and the
 * integrator names it. Two independent factories could not do that without the caller threading a
 * value it does not have yet.
 *
 * The order is guaranteed by the workflow rather than assumed here: `runIntegrationStep` resolves
 * the plan — through this planner — before it performs any step, and `runAutonomousWorkflow`
 * resolves it earlier still for a multi-repository run (FR-116, FR-117). The integrator therefore
 * still works if it somehow runs first; it simply says less, which is the right failure for a
 * missing piece of provenance.
 *
 * @param options - The live conversation and the tap on its frames.
 * @returns The `IntegrationPlanner` and `IntegrationPort` the autonomous loop needs.
 */
export const createAgentIntegrationPorts = (
  options: AgentIntegrationPortsOptions,
): AgentIntegrationPorts => {
  const newNonce = options.nonce ?? ((): string => randomUUID())
  /** The reading the plan came from, recorded for the steps that follow it. */
  let planSkill: ResolvedSkill | undefined

  const planner: IntegrationPlanner = async (
    skill: ResolvedSkill,
  ): Promise<DeclaredIntegrationPlan> => {
    const nonce = newNonce()

    planSkill = skill

    const answer = await askAgentForBlock({
      agent: options.agent,
      frames: options.frames,
      tag: INTEGRATION_PLAN_TAG,
      nonce,
      body: integrationPlanTurnBody({ skill, nonce }),
      answerNoun: 'integration plan block',
      deadlineMs: options.planDeadlineMs ?? DEFAULT_PLAN_DEADLINE_MS,
      ...timings(options),
    })

    const what = `reading ${skill.skillName}`

    if (answer.kind === 'failed') {
      throw new AgentIntegrationError({ kind: answer.failure, what, detail: answer.detail })
    }

    const reading = readIntegrationPlan(answer.value)

    if (reading.kind === 'empty') {
      throw new AgentIntegrationError({
        kind: 'empty',
        what,
        detail:
          'the agent emitted a well-formed block stating neither an integration order nor a list ' +
          'of steps, so it answered neither of the two questions the skill was read for',
      })
    }

    if (reading.kind === 'unusable') {
      throw new AgentIntegrationError({
        kind: 'unusable',
        what,
        detail: `the plan block states something that cannot be used — ${reading.problems.join('; ')}`,
      })
    }

    return reading.plan
  }

  const integrator: IntegrationPort = async (request): Promise<IntegrationStepRef> => {
    const nonce = newNonce()
    const what = `integration step "${request.name}" on entry ${request.entryId}`

    const answer = await askAgentForBlock({
      agent: options.agent,
      frames: options.frames,
      tag: INTEGRATION_STEP_TAG,
      nonce,
      body: integrationStepTurnBody({
        ...(planSkill === undefined ? {} : { skill: planSkill }),
        step: { entryId: request.entryId, name: request.name, instruction: request.instruction },
        idempotencyKey: request.idempotencyKey,
        nonce,
      }),
      answerNoun: 'integration step block',
      deadlineMs: options.stepDeadlineMs ?? DEFAULT_STEP_DEADLINE_MS,
      ...timings(options),
    })

    if (answer.kind === 'failed') {
      throw new AgentIntegrationError({ kind: answer.failure, what, detail: answer.detail })
    }

    const reference = answer.value['reference']

    if (typeof reference !== 'string' || reference.trim() === '') {
      throw new AgentIntegrationError({
        kind: 'unusable',
        what,
        detail:
          'the block names no reference, so there is nothing a person could follow to check that ' +
          'this step happened',
      })
    }

    // `entryId` and `name` are the request's, never the block's. See the module note: the agent is
    // the authority on where the evidence is and on nothing else about this step's identity.
    return { entryId: request.entryId, name: request.name, reference: reference.trim() }
  }

  return { planner, integrator }
}
