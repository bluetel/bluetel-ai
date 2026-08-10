import type { WorkflowState } from '@bluetel-ai/sisyphus-api/client'
import { PAUSE_IDLE_CEILING_MS } from '@bluetel-ai/sisyphus-api/contracts'
import { formatElapsed } from '@sisyphus-admin/components/admin'

import type { TimelineItem } from './workflow-detail-readouts'

/**
 * **Saying how long a paused run has before it parks** (T105, 003/FR-047).
 *
 * FR-047 is one sentence — *"the time remaining before a paused workflow parks MUST be visible to
 * its owner"* — and it is there because of what parking does. Past the idle limit the platform
 * releases the run's instance **and its disk** (FR-044): the working tree the agent had, the
 * uncommitted edits in it, and the instance the pause was holding all go, and what survives is the
 * durable snapshot taken when the pause was acknowledged. That is a good trade — a forgotten pause
 * should cost storage rather than an instance — but it is a trade the person who paused the run is
 * entitled to see coming, because the remedy is trivial and only available beforehand: resume it.
 *
 * A resume before the limit starts the same instance and continues on the same working tree
 * (FR-041). A resume after it rebuilds from the snapshot onto a fresh instance. Nothing is lost
 * either way — which is why the copy says so plainly, rather than counting down at somebody in a
 * tone that implies their work is about to be deleted.
 *
 * ## Why it is derived from the timeline, like the credential wait beside it
 *
 * `credential-wait.ts` makes this argument in full and this module follows it: the control plane
 * writes a `paused` row into `workflow_events` when the executor's pause is acknowledged, and that
 * row's timestamp is when the pause began. There is no `workflows.paused_at` column — the control
 * plane's own idle check reads the same timeline row for the same reason — so deriving the
 * countdown from the timeline is not a workaround. It is reading the one record of the fact, and it
 * costs no extra request because the detail panel already loads the timeline.
 *
 * **Latest wins.** A run may be paused, resumed and paused again, and it is the current pause the
 * countdown is about. A reader that took the first `paused` row would show a run paused a minute
 * ago as forty minutes overdue.
 *
 * **A pause the timeline never recorded produces no readout at all.** That is the same rule the
 * control plane applies to the same absence: with no evidence of when the pause began there is no
 * countdown to show, and inventing one — from the run's `updatedAt`, say — would put a deadline on
 * screen that nothing in the platform is working to.
 *
 * ## The ceiling is the platform's number, not this application's copy of it
 *
 * {@link PAUSE_IDLE_CEILING_MS} used to be thirty minutes *here*, and thirty minutes again in
 * `apps/sisyphus-executor/src/session/idle-ceiling.ts` and
 * `apps/sisyphus-control-plane/src/jobs/reconcile.ts`. It is now one value, in
 * `@bluetel-ai/sisyphus-api/contracts`, which all three read — the shared home the comment that
 * used to be here said the move belonged in. The panel cannot import a constant out of either
 * application, but it can import one out of the package both of them already depend on, and that is
 * what closes the drift: a countdown to a deadline nothing was working to is exactly the failure
 * three literals would eventually produce, and it would show up as a screen that lied rather than
 * as a broken build.
 *
 * It stays a **parameter** of {@link toParkingCountdownReadout}, with the shared constant as the
 * default. That is not the old apology in new words: if the ceiling ever becomes deployment
 * configuration, the value will arrive on the run and the caller will pass it, and nothing in this
 * module has to change to accept it.
 *
 * ## What it deliberately does not do
 *
 * It raises nothing, and it is not a warning. 003/FR-079 keeps waiting, cooling off and parking off
 * the notification path entirely — they are reported in the workflow view and nowhere else — and
 * `sisyphus-notify` maps the states involved to no event, which is what makes that true rather than
 * intended. Paging somebody because their own pause is ageing would fire once per pause, for a
 * thing they chose to do, about an outcome that loses nothing.
 */

const MILLISECONDS_PER_MINUTE = 60_000

/**
 * How long a pause may last before the platform parks it (FR-044).
 *
 * Re-exported from `@bluetel-ai/sisyphus-api/contracts` rather than written out, so that the number
 * this screen counts down to is the number the executor's timer and the control plane's backstop
 * sweep act on. See the module note. The re-export keeps `./index.ts` and every existing importer
 * pointing here, which is where a reader of this countdown expects to find it.
 */
export { PAUSE_IDLE_CEILING_MS }

/** What the detail view puts on screen for a pause that is ageing towards a park. */
export interface ParkingCountdownReadout {
  /** The short line, for a heading. Sentence case. */
  readonly headline: string
  /** How long is left before it parks — `m:ss`, the console's one clock. `0:00` once it is due. */
  readonly remaining: string
  /** How long it has been paused, so the countdown is readable against something. */
  readonly pausedFor: string
  /** The paragraph saying what parking will do and what resuming now would avoid. */
  readonly explanation: string
  /**
   * True once the limit has passed and the park is owed rather than pending.
   *
   * Its own field rather than a `remaining` of `0:00`, because the two say different things and the
   * copy branches on it: before the limit there is something the owner can do about it, and after
   * it there is only what the platform is about to do.
   */
  readonly overdue: boolean
}

/**
 * When the current pause began, from the timeline.
 *
 * The timeline arrives oldest-first, so this walks it backwards and stops at the first `paused`
 * row — the current pause, in a run that may have been paused more than once.
 *
 * @param timeline - The entries as `workflow.timeline` returned them.
 */
const pausedSince = (timeline: readonly TimelineItem[]): Date | undefined => {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    // `noUncheckedIndexedAccess` is off in this app, so the element is typed as present; the loop
    // bounds are what make that true here rather than an assumption.
    const entry = timeline[index]

    if (entry.event === 'paused') {
      return entry.createdAt
    }
  }

  return undefined
}

/** The limit, in whole minutes, for prose. */
const inMinutes = (milliseconds: number): string =>
  String(Math.round(milliseconds / MILLISECONDS_PER_MINUTE))

/**
 * Turn a run's timeline into what the panel says about the park ahead of it (FR-047).
 *
 * @param options.state - The run's state now. Only a `paused` run has a park ahead of it: a running
 *   one is not counting down, and a `parked_resumable` one has already arrived, which its state
 *   chip and its outcome reason both say.
 * @param options.timeline - The entries as `workflow.timeline` returned them, oldest first.
 * @param options.now - The page's clock, or `undefined` before the browser has one. While it is
 *   absent the countdown reads as the full ceiling, which errs toward *not* announcing an imminent
 *   park on a server render — the opposite error would flash "parking now" at somebody who has
 *   thirty minutes.
 * @param options.ceilingMs - The limit in force. Defaults to {@link PAUSE_IDLE_CEILING_MS}.
 * @returns The readout, or `undefined` when this run is not paused or its pause was never recorded.
 */
export const toParkingCountdownReadout = (options: {
  readonly state: WorkflowState
  readonly timeline: readonly TimelineItem[]
  readonly now: number | undefined
  readonly ceilingMs?: number
}): ParkingCountdownReadout | undefined => {
  if (options.state !== 'paused') {
    return undefined
  }

  const since = pausedSince(options.timeline)

  if (since === undefined) {
    return undefined
  }

  const ceilingMs = options.ceilingMs ?? PAUSE_IDLE_CEILING_MS
  const pausedForMs = options.now === undefined ? 0 : options.now - since.getTime()
  const remainingMs = ceilingMs - pausedForMs
  const overdue = remainingMs <= 0
  const limit = `${inMinutes(ceilingMs)} minutes`

  return {
    headline: overdue ? 'Parking now' : 'Parks if nobody resumes it',
    remaining: formatElapsed(remainingMs),
    pausedFor: formatElapsed(pausedForMs),
    overdue,
    explanation: overdue
      ? `This pause has run past the ${limit} the platform allows, so the run is being parked: ` +
        'its instance and its disk are released, and it stands on the snapshot taken when the ' +
        'pause was acknowledged. Nothing is lost — resuming rebuilds it onto a fresh instance, ' +
        'under the same agent credential it has held all along — but it will no longer be the ' +
        'working tree it paused with.'
      : `A pause holds this run's instance and disk for ${limit}, and then parks it: the instance ` +
        'and disk are released and the run stands on the snapshot taken when the pause was ' +
        'acknowledged. Resuming before then continues on the same instance and the same working ' +
        'tree; resuming after it rebuilds from the snapshot, under the same agent credential ' +
        'either way. Parking loses no work — it costs the working tree, and the time to rebuild.',
  }
}
