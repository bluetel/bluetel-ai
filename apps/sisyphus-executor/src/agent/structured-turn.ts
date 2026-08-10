/**
 * **Asking the running agent a question and reading a structured answer back (T194, T196).**
 *
 * `createAgentDeveloperPort` was the first of these and, until T196, the only one: write one turn
 * into the conversation the run is already having, watch the frames the agent produces, and read
 * the delimited block it eventually emits. T196 needs four more of exactly that shape — the review
 * verdict, the review's targets, the integration plan and each integration step — against different
 * skills and different answers.
 *
 * So the mechanics live here once. The alternative was five copies of the settle timer, and the
 * copies would not have stayed identical: the rule about what ends the wait is subtle enough that a
 * second implementation would have got it slightly wrong, and "slightly wrong" here means a run
 * that abandons a healthy pass or one that hangs until the deadline.
 *
 * ## The one rule, unchanged
 *
 * **Every field of every answer comes from something the agent wrote.** This module returns either
 * an intact JSON object the agent emitted or a named failure. It never composes an answer, never
 * fills a gap and never treats silence as agreement, because the composition root refused to supply
 * stub ports for precisely that reason: a run that reports success having done nothing is strictly
 * worse than a run that says what it is missing (FR-057, FR-058).
 *
 * ## Knowing when the answer is not coming
 *
 * Deciding that an agent has finished is the hard part, and spike S1 left it deliberately open:
 * whether the CLI hands a mid-request stdin turn to the in-flight request or queues it behind the
 * current one was never observed. So a `result` frame cannot be attributed to a particular turn,
 * and a caller that treated the first one it saw as "my turn is over" would report a perfectly
 * healthy answer as unanswered whenever the opening prompt's own response happened to land first.
 *
 * The rule used here is correct under either scheduling. A boundary is only *evidence* of an
 * ending; what ends the wait is a boundary **followed by silence**. Any assistant or user frame
 * after a `result` disarms it again, because an agent still producing output is an agent still
 * working, whichever request the output belongs to. The same reasoning that made `quiesce` wait for
 * the next boundary rather than send an interrupt: prefer the rule that holds under both answers to
 * the question S1 could not settle.
 *
 * Three other endings need no inference at all — the output stream closing, a `result` frame that
 * says `is_error`, and the overall deadline expiring — and each is reported as itself.
 *
 * ## Why it reports rather than throws
 *
 * Each caller raises its own error type with its own wording: `AgentProposalError` says
 * "development pass 3", the reviewer says which pull requests it was reviewing, the integration
 * step says which step on which entry. A shared exception would have flattened all of that into one
 * sentence about a "block", which is the platform's vocabulary rather than the run's, and an
 * operator reading a terminal report needs the run's.
 */

import type { AgentAdapter, AgentResultFrame } from './adapter'
import type { FrameTap } from './frame-tap'
import { extractBlock } from './proposal-block'

/**
 * How long a turn boundary has to be followed by silence before the answer is called missing.
 *
 * Generous on purpose. It is only ever spent on a question that is already going to fail, and it is
 * the margin that keeps a queued turn — the scheduling S1 could not rule out — from being read as
 * a turn nobody answered.
 */
export const DEFAULT_SETTLE_MS = 15_000

/** Long enough for the echo `--replay-user-messages` produces; see `cli-stream.ts`. */
export const DEFAULT_TURN_TIMEOUT_MS = 10_000

/**
 * Why a question produced no answer. Named rather than free text, because each one sends whoever
 * reads the terminal report somewhere different.
 */
export type AgentAnswerFailure =
  /** The turn could not be written to the agent at all. */
  | 'not-delivered'
  /** The agent's output ended — it exited, or was stopped — before it answered. */
  | 'stream-ended'
  /** The agent itself reported the turn as failed: a cap of its own, or an execution error. */
  | 'agent-error'
  /** A turn boundary, then silence, and no block. */
  | 'no-answer'
  /** Neither a boundary nor a block within the deadline. */
  | 'timed-out'
  /** A block was opened and the output ended before it was closed. */
  | 'truncated'
  /** A block was closed and its body is not a JSON object. */
  | 'malformed'

/** What asking produced: the agent's own object, or the way it did not arrive. */
export type AgentBlockAnswer =
  | { readonly kind: 'answered'; readonly value: Record<string, unknown> }
  | {
      readonly kind: 'failed'
      readonly failure: AgentAnswerFailure
      readonly detail: string
    }

export interface StructuredTurnOptions {
  /** The live conversation. Only `sendTurn`: nothing here starts or stops the agent. */
  readonly agent: Pick<AgentAdapter, 'sendTurn'>
  /** Frames as the run's own consumer pulls them; see `frame-tap.ts`. */
  readonly frames: Pick<FrameTap, 'subscribe'>
  /** Which question this is; see `proposal-block.ts` on why the tag is not one constant. */
  readonly tag: string
  /** Ties the reply to this request. Fresh per ask, so an earlier answer cannot satisfy this one. */
  readonly nonce: string
  /** The turn body, composed by the caller. Nothing is added to it here. */
  readonly body: string
  /**
   * What the block is called in a failure — "proposal block", "review block".
   *
   * A phrase rather than the tag, because the tag is a machine-readable marker and the failure is
   * read by a person deciding whether the agent misbehaved or the instance died.
   */
  readonly answerNoun: string
  readonly deadlineMs: number
  readonly settleMs?: number
  readonly turnTimeoutMs?: number
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
   * The turn is on the wire. Only now can a boundary be evidence about *this* question — a `result`
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
 * are the echo of the turn just written, and that turn contains the markers.
 */
const watchForBlock = (options: {
  readonly frames: Pick<FrameTap, 'subscribe'>
  readonly tag: string
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
        // ending here on the first bad block would throw away the question over a stray backtick.
        if (extractBlock(transcript, options.tag, options.nonce).kind === 'found') {
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
  options: { readonly tag: string; readonly nonce: string; readonly answerNoun: string },
): { readonly failure: AgentAnswerFailure; readonly detail: string } => {
  const extraction = extractBlock(outcome.transcript, options.tag, options.nonce)

  if (extraction.kind === 'truncated') {
    return {
      failure: 'truncated',
      detail:
        `the agent began a ${options.answerNoun} and never closed it, so what it was reporting is ` +
        'not readable',
    }
  }

  switch (outcome.kind) {
    case 'closed':
      return {
        failure: 'stream-ended',
        detail: `the agent’s output ended before it emitted a readable ${options.answerNoun}`,
      }
    case 'errored':
      return {
        failure: 'agent-error',
        detail:
          `the agent ended the turn with an error (${outcome.result.subtype}) and no ` +
          options.answerNoun,
      }
    case 'settled':
      return extraction.kind === 'malformed'
        ? { failure: 'malformed', detail: extraction.detail }
        : {
            failure: 'no-answer',
            detail: `the agent reached a turn boundary and went quiet without a ${options.answerNoun}`,
          }
    default:
      return extraction.kind === 'malformed'
        ? { failure: 'malformed', detail: extraction.detail }
        : {
            failure: 'timed-out',
            detail: `no turn boundary and no ${options.answerNoun} arrived within the time allowed`,
          }
  }
}

/**
 * Write one turn and read the block it asks for.
 *
 * @param options - The conversation, the tap on its frames, the question and how long to wait.
 * @returns The agent's own JSON object, or the named way it did not arrive. Never throws for a
 *   failure that is the agent's: a thrown error here would be an ordinary defect in this module.
 */
export const askAgentForBlock = async (
  options: StructuredTurnOptions,
): Promise<AgentBlockAnswer> => {
  // Subscribed before the write, so an answer that arrives faster than this promise chain resumes
  // is still seen. The same ordering `sendTurn` uses for its own acknowledgement.
  const watch = watchForBlock({
    frames: options.frames,
    tag: options.tag,
    nonce: options.nonce,
    settleMs: options.settleMs ?? DEFAULT_SETTLE_MS,
    deadlineMs: options.deadlineMs,
  })

  try {
    // The evidence is recorded and not acted on. A write that succeeded without an echo is an
    // unknown, not a failure (FR-049), and calling it either would be a claim: "unacknowledged"
    // would abandon a turn that is very likely running, "delivered" would be a lie.
    await options.agent.sendTurn(options.body, {
      timeoutMs: options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    })
  } catch (cause) {
    watch.cancel()

    return {
      kind: 'failed',
      failure: 'not-delivered',
      detail: `the turn could not be written to the agent (${
        cause instanceof Error ? cause.message : String(cause)
      })`,
    }
  }

  watch.delivered()

  const outcome = await watch.outcome
  const extraction = extractBlock(outcome.transcript, options.tag, options.nonce)

  if (outcome.kind !== 'answered' || extraction.kind !== 'found') {
    return { kind: 'failed', ...classify(outcome, options) }
  }

  return { kind: 'answered', value: extraction.value }
}
