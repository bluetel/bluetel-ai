/**
 * The `DeveloperPort`, implemented against a live agent (T194, T196, FR-057, FR-058, US1).
 *
 * `runDevelopStep` resolves `sisyphus-dev` and then asks a function for a proposal. This is that
 * function: it writes one turn into the conversation the run is already having, watches the frames
 * the agent produces, and turns the block it eventually emits into a `DevelopmentProposal`. It is
 * the last thing standing between a composed workflow and a delegated run that finishes.
 *
 * ## The one rule
 *
 * **Every field of the answer comes from something the agent wrote.** There is no path through
 * this module that produces a proposal from silence, from a truncated block, from an error result,
 * or from a stream that ended. Each of those is an {@link AgentProposalError} naming what was
 * observed. The composition root refused to supply a stub developer for precisely this reason —
 * "a stub that returns a plausible proposal would produce a run that reported success having done
 * nothing" — and a real implementation that quietly defaulted a field would be that stub with more
 * steps.
 *
 * ## The waiting is not here any more, and that is T196
 *
 * Deciding that an agent has finished is the subtle part, and four more ports now need exactly the
 * same decision — the reviewer, the review's targets, the integration planner and the integration
 * step. It therefore lives in `./structured-turn.ts`, which this module asks and then interprets.
 * Nothing about the rule changed; see that file for why a boundary alone never ends the wait.
 *
 * What stays here is the *vocabulary*: {@link AgentProposalFailure} keeps `no-proposal` rather than
 * the generic `no-answer`, and every message still says "development pass 3". An operator reading a
 * terminal report needs the run's words for what failed, not the platform's word for a block.
 */

import { randomUUID } from 'node:crypto'

import type { DeveloperPort, DevelopmentProposal, DevelopmentRequest } from '../workflows'

import type { AgentAdapter } from './adapter'
import { developTurnBody } from './develop-turn'
import { readDevelopmentProposal } from './development-proposal'
import type { FrameTap } from './frame-tap'
import { PROPOSAL_TAG } from './proposal-block'
import type { AgentAnswerFailure } from './structured-turn'
import { askAgentForBlock, DEFAULT_SETTLE_MS, DEFAULT_TURN_TIMEOUT_MS } from './structured-turn'

export { DEFAULT_SETTLE_MS, DEFAULT_TURN_TIMEOUT_MS }

/**
 * A backstop, not a schedule. A development pass writes code, so the honest bound on it is the
 * run's caps and the instance's lifetime; this exists so a conversation that has gone permanently
 * quiet fails with a sentence instead of holding an instance until something else kills it.
 */
export const DEFAULT_PROPOSAL_DEADLINE_MS = 45 * 60_000

/** How a pass with no proposal is described to whoever reads the terminal report. */
const ANSWER_NOUN = 'proposal block'

/**
 * Why a pass produced no proposal. Named rather than free text, because each one sends whoever
 * reads the terminal report somewhere different.
 */
export type AgentProposalFailure =
  /** The turn could not be written to the agent at all. */
  | 'not-delivered'
  /** The agent's output ended — it exited, or was stopped — before it answered. */
  | 'stream-ended'
  /** The agent itself reported the turn as failed: a cap of its own, or an execution error. */
  | 'agent-error'
  /** A turn boundary, then silence, and no block. */
  | 'no-proposal'
  /** Neither a boundary nor a block within the deadline. */
  | 'timed-out'
  /** A block was opened and the output ended before it was closed. */
  | 'truncated'
  /** A block was closed and its body is not a JSON object. */
  | 'malformed'
  /** A block that parsed and carries none of a proposal's fields. */
  | 'empty'
  /** A block that parsed and left out something a proposal cannot be assembled without. */
  | 'incomplete'

/**
 * The generic failure in this port's own vocabulary.
 *
 * Only one name differs, and the difference is worth keeping: "no proposal" is what a person
 * looking at a development pass is trying to find out, and "no answer" is what the transport
 * noticed.
 */
const proposalFailureFor = (failure: AgentAnswerFailure): AgentProposalFailure =>
  failure === 'no-answer' ? 'no-proposal' : failure

export class AgentProposalError extends Error {
  readonly kind: AgentProposalFailure
  /** The development pass this was, so a failure on iteration three says so. */
  readonly ordinal: number

  constructor(options: {
    readonly kind: AgentProposalFailure
    readonly ordinal: number
    readonly detail: string
  }) {
    super(
      `development pass ${String(options.ordinal)} produced no proposal: ${options.detail}. ` +
        'Nothing is assumed about what the agent did — a proposal composed here would report ' +
        'work nobody can see (FR-057, FR-058).',
    )
    this.name = 'AgentProposalError'
    this.kind = options.kind
    this.ordinal = options.ordinal
  }
}

export interface AgentDeveloperPortOptions {
  /** The live conversation. Only `sendTurn`: this port never starts or stops the agent. */
  readonly agent: Pick<AgentAdapter, 'sendTurn'>
  /** Frames as the run's own consumer pulls them; see `frame-tap.ts`. */
  readonly frames: Pick<FrameTap, 'subscribe'>
  readonly deadlineMs?: number
  readonly settleMs?: number
  readonly turnTimeoutMs?: number
  /** Injected in tests, so a transcript can be written by hand. Random otherwise. */
  readonly nonce?: () => string
}

/**
 * Build the developer port for a running agent.
 *
 * @param options - The live conversation and the tap on its frames.
 * @returns A `DeveloperPort` for `runDevelopStep`, `runDelegatedWorkflow` and the autonomous loop.
 */
export const createAgentDeveloperPort = (options: AgentDeveloperPortOptions): DeveloperPort => {
  const newNonce = options.nonce ?? ((): string => randomUUID())

  return async (request: DevelopmentRequest): Promise<DevelopmentProposal> => {
    const nonce = newNonce()

    const answer = await askAgentForBlock({
      agent: options.agent,
      frames: options.frames,
      tag: PROPOSAL_TAG,
      nonce,
      body: developTurnBody({ request, nonce }),
      answerNoun: ANSWER_NOUN,
      deadlineMs: options.deadlineMs ?? DEFAULT_PROPOSAL_DEADLINE_MS,
      ...(options.settleMs === undefined ? {} : { settleMs: options.settleMs }),
      ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
    })

    if (answer.kind === 'failed') {
      throw new AgentProposalError({
        kind: proposalFailureFor(answer.failure),
        ordinal: request.ordinal,
        detail: answer.detail,
      })
    }

    const reading = readDevelopmentProposal(answer.value)

    if (reading.kind === 'empty') {
      throw new AgentProposalError({
        kind: 'empty',
        ordinal: request.ordinal,
        detail:
          'the agent emitted a well-formed proposal block carrying none of the fields a ' +
          'proposal is made of',
      })
    }

    if (reading.kind === 'incomplete') {
      throw new AgentProposalError({
        kind: 'incomplete',
        ordinal: request.ordinal,
        detail: `the proposal block left out what it cannot be assembled without — ${reading.problems.join('; ')}`,
      })
    }

    return reading.proposal
  }
}
