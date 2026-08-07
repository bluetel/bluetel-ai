/**
 * The `DeveloperPort`, implemented against a live agent (T194, FR-057, FR-058, US1).
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
 * ## Knowing when the answer is not coming
 *
 * Deciding that an agent has finished is the hard part, and spike S1 left it deliberately open:
 * whether the CLI hands a mid-request stdin turn to the in-flight request or queues it behind the
 * current one was never observed. So a `result` frame cannot be attributed to a particular turn,
 * and a port that treated the first one it saw as "my turn is over" would report a perfectly
 * healthy pass as unanswered whenever the opening prompt's own response happened to land first.
 *
 * The rule used here is correct under either scheduling. A boundary is only *evidence* of an
 * ending; what ends the wait is a boundary **followed by silence**. Any assistant or user frame
 * after a `result` disarms it again, because an agent still producing output is an agent still
 * working, whichever request the output belongs to. The same reasoning that made `quiesce` wait
 * for the next boundary rather than send an interrupt: prefer the rule that holds under both
 * answers to the question S1 could not settle.
 *
 * Three other endings need no inference at all — the output stream closing, a `result` frame that
 * says `is_error`, and the overall deadline expiring — and each is reported as itself.
 */

import { randomUUID } from 'node:crypto'

import type { DeveloperPort, DevelopmentProposal, DevelopmentRequest } from '../workflows'

import type { AgentAdapter, AgentResultFrame } from './adapter'
import { developTurnBody } from './develop-turn'
import { readDevelopmentProposal } from './development-proposal'
import type { FrameTap } from './frame-tap'
import { extractProposal } from './proposal-block'

/**
 * A backstop, not a schedule. A development pass writes code, so the honest bound on it is the
 * run's caps and the instance's lifetime; this exists so a conversation that has gone permanently
 * quiet fails with a sentence instead of holding an instance until something else kills it.
 */
export const DEFAULT_PROPOSAL_DEADLINE_MS = 45 * 60_000

/**
 * How long a turn boundary has to be followed by silence before the pass is called unanswered.
 *
 * Generous on purpose. It is only ever spent on a pass that is already going to fail, and it is
 * the margin that keeps a queued turn — the scheduling S1 could not rule out — from being read as
 * a turn nobody answered.
 */
export const DEFAULT_SETTLE_MS = 15_000

/** Long enough for the echo `--replay-user-messages` produces; see `cli-stream.ts`. */
export const DEFAULT_TURN_TIMEOUT_MS = 10_000

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

/** How the watch ended. The transcript travels with it so the failure can be specific. */
type WatchOutcome =
  | { readonly kind: 'answered'; readonly transcript: string }
  | { readonly kind: 'closed'; readonly transcript: string }
  | { readonly kind: 'errored'; readonly transcript: string; readonly result: AgentResultFrame }
  | { readonly kind: 'settled'; readonly transcript: string }
  | { readonly kind: 'expired'; readonly transcript: string }

interface Watch {
  readonly outcome: Promise<WatchOutcome>
  /**
   * The turn is on the wire. Only now can a boundary be evidence about *this* pass — a `result`
   * arriving before the write belongs to something the run was already doing.
   */
  readonly delivered: () => void
  readonly cancel: () => void
}

const unrefTimer = (timer: NodeJS.Timeout): NodeJS.Timeout => {
  timer.unref()

  return timer
}

/**
 * Watch the frame stream until the answer arrives or one of the endings does.
 *
 * Assistant text is accumulated across frames because a block is written in pieces and its markers
 * land wherever the chunk boundaries fall. User frames are deliberately *not* accumulated: they
 * are the echo of the turn this port just wrote, and that turn contains the markers.
 */
const watchForProposal = (options: {
  readonly frames: Pick<FrameTap, 'subscribe'>
  readonly nonce: string
  readonly settleMs: number
  readonly deadlineMs: number
}): Watch => {
  let transcript = ''
  let settleTimer: NodeJS.Timeout | undefined
  let delivered = false
  let unsubscribe: (() => void) | undefined
  let finish: (outcome: WatchOutcome) => void = () => undefined

  const outcome = new Promise<WatchOutcome>((resolveOutcome) => {
    const deadline = unrefTimer(
      setTimeout(() => {
        finish({ kind: 'expired', transcript })
      }, options.deadlineMs),
    )

    finish = (settledOutcome: WatchOutcome): void => {
      clearTimeout(deadline)
      clearTimeout(settleTimer)
      unsubscribe?.()
      resolveOutcome(settledOutcome)
    }

    const disarmSettle = (): void => {
      clearTimeout(settleTimer)
      settleTimer = undefined
    }

    unsubscribe = options.frames.subscribe({
      onFrame: (frame) => {
        if (frame.type === 'result') {
          if (frame.isError) {
            finish({ kind: 'errored', transcript, result: frame })

            return
          }

          if (delivered) {
            disarmSettle()
            settleTimer = unrefTimer(
              setTimeout(() => {
                finish({ kind: 'settled', transcript })
              }, options.settleMs),
            )
          }

          return
        }

        if (frame.type === 'user') {
          // Output, so the agent is not silent — but never part of the transcript.
          disarmSettle()

          return
        }

        if (frame.type !== 'assistant') {
          return
        }

        disarmSettle()
        transcript += frame.text

        // Only a readable answer ends the watch. Neither a half-written block nor an unreadable
        // one does: an agent that mangled a block and then wrote a good one has answered, and
        // ending here on the first bad block would throw away the pass over a stray backtick.
        if (extractProposal(transcript, options.nonce).kind === 'found') {
          finish({ kind: 'answered', transcript })
        }
      },
      onClose: () => {
        finish({ kind: 'closed', transcript })
      },
    })
  })

  return {
    outcome,
    delivered: () => {
      delivered = true
    },
    cancel: () => {
      finish({ kind: 'expired', transcript })
    },
  }
}

/**
 * Which failure a watch that did not produce an answer is.
 *
 * The ending comes first and the transcript refines it, in that order, because the ending is the
 * fact an operator has to act on: an agent that died halfway is a different problem from an agent
 * that finished and wrote something unreadable, even when both leave the same wreckage behind.
 * The one exception is a block cut off in mid-write, which says *where* the ending landed and is
 * therefore more use than the ending alone.
 */
const classify = (
  outcome: WatchOutcome,
  nonce: string,
): { readonly kind: AgentProposalFailure; readonly detail: string } => {
  const extraction = extractProposal(outcome.transcript, nonce)
  const cutOff = extraction.kind === 'truncated'

  if (cutOff) {
    return {
      kind: 'truncated',
      detail:
        'the agent began a proposal block and never closed it, so what it was reporting is ' +
        'not readable',
    }
  }

  switch (outcome.kind) {
    case 'closed':
      return {
        kind: 'stream-ended',
        detail: 'the agent’s output ended before it emitted a readable proposal block',
      }
    case 'errored':
      return {
        kind: 'agent-error',
        detail: `the agent ended the turn with an error (${outcome.result.subtype}) and no proposal block`,
      }
    case 'settled':
      return extraction.kind === 'malformed'
        ? { kind: 'malformed', detail: extraction.detail }
        : {
            kind: 'no-proposal',
            detail: 'the agent reached a turn boundary and went quiet without a proposal block',
          }
    default:
      return extraction.kind === 'malformed'
        ? { kind: 'malformed', detail: extraction.detail }
        : {
            kind: 'timed-out',
            detail: 'no turn boundary and no proposal block arrived within the time allowed',
          }
  }
}

const deliver = async (
  options: AgentDeveloperPortOptions,
  request: DevelopmentRequest,
  body: string,
): Promise<void> => {
  try {
    // The evidence is recorded and not acted on. A write that succeeded without an echo is an
    // unknown, not a failure (FR-049), and calling it either would be a claim: "unacknowledged"
    // would abandon a pass that is very likely running, "delivered" would be a lie.
    await options.agent.sendTurn(body, {
      timeoutMs: options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    })
  } catch (cause) {
    throw new AgentProposalError({
      kind: 'not-delivered',
      ordinal: request.ordinal,
      detail: `the turn could not be written to the agent (${
        cause instanceof Error ? cause.message : String(cause)
      })`,
    })
  }
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
    const body = developTurnBody({ request, nonce })

    // Subscribed before the write, so an answer that arrives faster than this promise chain
    // resumes is still seen. The same ordering `sendTurn` uses for its own acknowledgement.
    const watch = watchForProposal({
      frames: options.frames,
      nonce,
      settleMs: options.settleMs ?? DEFAULT_SETTLE_MS,
      deadlineMs: options.deadlineMs ?? DEFAULT_PROPOSAL_DEADLINE_MS,
    })

    try {
      await deliver(options, request, body)
    } catch (error) {
      watch.cancel()

      throw error
    }

    watch.delivered()

    const outcome = await watch.outcome

    const extraction = extractProposal(outcome.transcript, nonce)

    if (outcome.kind !== 'answered' || extraction.kind !== 'found') {
      throw new AgentProposalError({ ...classify(outcome, nonce), ordinal: request.ordinal })
    }

    const reading = readDevelopmentProposal(extraction.value)

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
