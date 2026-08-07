import type { WorkflowState } from '@bluetel-ai/sisyphus-api/client'
import type { ButtonVariant } from '@sisyphus-admin/components/ui'

/**
 * **What the panel is allowed to say a run is doing (T095, FR-049, SC-003).**
 *
 * One rule governs this file, and it is the requirement the task exists for:
 *
 * > The panel reports "paused" only once the executor has **acknowledged** — otherwise the UI
 * > claims a pause the instance has not performed.
 *
 * The mechanism is a separation of two facts that a careless implementation collapses into one:
 *
 * - **a command row exists** — the person pressed the button and the request is queued;
 * - **`workflows.state` is `paused`** — the executor collected the command, reached a turn boundary,
 *   captured a snapshot, registered it, and reported back.
 *
 * Only the second is a pause. The first is a *request*, and between the two the agent is still
 * running, still spending and still writing to the working tree. The gap is bounded — SC-003 gives
 * it ten seconds — but ten seconds of a screen saying something untrue is exactly what FR-049's
 * ordering rule was written to prevent, and it is long enough for somebody to act on it.
 *
 * So {@link supervisionStatus} takes both facts and returns `pause-requested` while the command is
 * uncollected. **There is no input to this function that produces `paused` from a pending command.**
 * That is the whole design: the panel cannot claim the pause because it is not given a way to.
 *
 * Pure and separate from the JSX, so the rule is asserted directly rather than inferred from
 * rendered markup.
 */

/** What the panel may say about a run's supervision state. */
export type SupervisionStatus =
  | 'live'
  | 'pause-requested'
  | 'resume-requested'
  | 'stop-requested'
  | 'paused'
  | 'parked'
  | 'finished'

/** The three commands, named as the mutations that queue them are. */
export type SupervisionCommandName = 'pause' | 'resume' | 'stop'

/** A command the executor has not acknowledged yet. */
export interface PendingSupervisionCommand {
  readonly command: SupervisionCommandName
  /** `Date.now()` when it was queued, for the waiting readout. */
  readonly requestedAt: number
}

const TERMINAL_STATES: readonly WorkflowState[] = [
  'succeeded',
  'failed',
  'capped',
  'cancelled',
  'needs_attention',
]

const REQUESTED: Readonly<Record<SupervisionCommandName, SupervisionStatus>> = {
  pause: 'pause-requested',
  resume: 'resume-requested',
  stop: 'stop-requested',
}

/**
 * Derive what the panel may say.
 *
 * The order of the checks is load-bearing. A terminal state wins over everything, because a queued
 * command against a finished run was recorded and not applied (FR-081). A **pending command** then
 * wins over the recorded state, because that is the window in which the request has been made and
 * not performed — and it is the only branch that can produce a `-requested` status.
 *
 * @param options.workflowState - The state the server has recorded.
 * @param options.pendingCommand - A queued command the executor has not acknowledged, if any.
 */
export const supervisionStatus = (options: {
  readonly workflowState: WorkflowState
  readonly pendingCommand?: PendingSupervisionCommand
}): SupervisionStatus => {
  if (TERMINAL_STATES.includes(options.workflowState)) {
    return 'finished'
  }

  if (options.pendingCommand !== undefined) {
    return REQUESTED[options.pendingCommand.command]
  }

  if (options.workflowState === 'parked_resumable') {
    return 'parked'
  }

  return options.workflowState === 'paused' ? 'paused' : 'live'
}

/** How one status reads. */
export interface SupervisionReadout {
  /** Uppercase mono, for the chip. */
  readonly chip: string
  /** One sentence, for the operator. Says what is true, never what has merely been asked for. */
  readonly explanation: string
}

const READOUTS: Readonly<Record<SupervisionStatus, SupervisionReadout>> = {
  live: {
    chip: 'RUNNING',
    explanation:
      'The agent is working. Pause holds it at the next turn boundary without ending it.',
  },
  'pause-requested': {
    chip: 'PAUSE REQUESTED',
    explanation:
      'The pause is queued and the instance has not performed it yet. The agent is still working until it reaches a turn boundary and its snapshot is stored.',
  },
  'resume-requested': {
    chip: 'RESUME REQUESTED',
    explanation: 'The resume is queued and has not been performed yet.',
  },
  'stop-requested': {
    chip: 'STOP REQUESTED',
    explanation:
      'The stop is queued. The run ends once it has reached a turn boundary and everything it produced has been captured.',
  },
  paused: {
    chip: 'PAUSED',
    explanation:
      'The instance has confirmed the pause. The agent is holding at a turn boundary and its work is snapshotted.',
  },
  parked: {
    chip: 'PARKED',
    explanation:
      'The snapshot is stored and the compute has been released. This run can be resumed onto a fresh instance.',
  },
  finished: {
    chip: 'FINISHED',
    explanation: 'This run has finished. Supervision requests are recorded but not applied.',
  },
}

/** Look one up. Total over the statuses, so there is no fallback to get wrong. */
export const supervisionReadout = (status: SupervisionStatus): SupervisionReadout =>
  READOUTS[status]

/** True exactly when the executor has confirmed a pause. Nothing else may be rendered as paused. */
export const isConfirmedPause = (status: SupervisionStatus): boolean => status === 'paused'

/** True while a request is queued and unperformed — the window the panel must not misreport. */
export const isAwaitingExecutor = (status: SupervisionStatus): boolean =>
  status === 'pause-requested' || status === 'resume-requested' || status === 'stop-requested'

/** One control the panel offers. */
export interface SupervisionAction {
  readonly kind: SupervisionCommandName
  /** Sentence case — this is a thing a person is doing. */
  readonly label: string
  readonly variant: ButtonVariant
  /** Present participle for the in-flight readout: `Pausing 0:04`. */
  readonly verb: string
}

const ACTIONS: Readonly<Record<SupervisionCommandName, SupervisionAction>> = {
  pause: { kind: 'pause', label: 'Pause', variant: 'secondary', verb: 'Pausing' },
  resume: { kind: 'resume', label: 'Resume', variant: 'secondary', verb: 'Resuming' },
  stop: { kind: 'stop', label: 'Stop', variant: 'danger', verb: 'Stopping' },
}

export const supervisionAction = (kind: SupervisionCommandName): SupervisionAction => ACTIONS[kind]

/**
 * The commands worth offering for a status.
 *
 * **Nothing here decides whether a command is allowed.** The server re-reads the workflow row under
 * a lock and answers an already-finished request with an explanation (FR-081), so a panel that
 * hid the button would be re-deriving that rule from a list that is already stale — the run can
 * finish between the render and the click. The panel offers the action and renders the answer.
 *
 * What it does do is avoid offering the *nonsensical*: a resume on a run nobody has paused, a pause
 * on one that is already parked.
 */
export const availableSupervisionActions = (
  status: SupervisionStatus,
): readonly SupervisionAction[] => {
  if (status === 'finished') {
    return []
  }

  if (status === 'parked') {
    return [ACTIONS.resume]
  }

  if (status === 'paused') {
    return [ACTIONS.resume, ACTIONS.stop]
  }

  // Live, or waiting on the executor. A stop is still offered while a pause is queued: it
  // supersedes the uncollected pause rather than queueing behind it, which is the one thing an
  // operator most needs to be able to do while waiting.
  return [ACTIONS.pause, ACTIONS.stop]
}

/** Whether corrections may be written. A finished run records them and does not deliver them. */
export const acceptsCorrections = (status: SupervisionStatus): boolean =>
  status !== 'finished' && status !== 'parked'
