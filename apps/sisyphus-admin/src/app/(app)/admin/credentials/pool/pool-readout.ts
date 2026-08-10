import { formatTimestamp, NEVER } from '@sisyphus-admin/components/admin'
import type { RouterOutputs } from '@sisyphus-admin/trpc'

/**
 * Turning the pool view into what the page renders (T113, FR-053, FR-054, FR-074, SC-011).
 *
 * Pure, and separate from the components, because the one thing on this screen that can be **wrong**
 * rather than merely ugly is the sentence at the top of it. SC-011 asks that an administrator can
 * tell an under-sized group from an under-sized pool in under thirty seconds; the server computes
 * that verdict, and this turns it into the words a person reads. Getting those words backwards would
 * send somebody to buy the wrong capacity, and that is a failing test here rather than a purchase
 * order nobody can explain.
 *
 * **Nothing is re-derived.** The verdict, the pressure, the queue depths, the holder breakdown and
 * `selectable` all arrive computed. It would be easy to recompute "is this group starved" from the
 * two numbers beside it, and the recomputation would agree until somebody changed one definition —
 * at which point the page and the alerter would disagree about which groups are short, which is the
 * one disagreement this screen cannot afford.
 */

/** The pool as `admin.credentialPool.view` returns it. Never a hand-written mirror of that shape. */
export type PoolView = RouterOutputs['admin']['credentialPool']['view']

/** One group's slice of it. */
export type PoolGroup = PoolView['groups'][number]

/** One seat. */
export type PoolSeat = PoolGroup['seats'][number]

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** What an absent duration reads as. A word, not an empty cell, so the row stays legible. */
export const NO_DURATION = '—'

/**
 * A duration in the units a person compares them in.
 *
 * Not `formatElapsed`, which renders `m:ss` for a button that has been working for four seconds.
 * The durations here are hold times and queue waits — hours and days — and `1284:07` is not a
 * number anybody reads. Coarse on purpose: a seat held for two days and one held for two days and
 * three hours call for the same action.
 *
 * @param milliseconds - The duration, or `null` where there is nothing to measure.
 */
export const formatDuration = (milliseconds: number | null): string => {
  if (milliseconds === null || !Number.isFinite(milliseconds) || milliseconds < 0) {
    return NO_DURATION
  }

  if (milliseconds < MINUTE_MS) {
    return 'under a minute'
  }
  if (milliseconds < HOUR_MS) {
    return `${String(Math.floor(milliseconds / MINUTE_MS))}m`
  }
  if (milliseconds < DAY_MS) {
    return `${String(Math.floor(milliseconds / HOUR_MS))}h`
  }
  return `${String(Math.floor(milliseconds / DAY_MS))}d`
}

/** The banner at the top of the page: the SC-011 answer, in words. */
export interface PoolSummaryReadout {
  readonly verdict: PoolView['verdict']
  /** One line. The whole of SC-011 for an administrator in a hurry. */
  readonly headline: string
  /** The sentence under it: what to do, and why that rather than the other thing. */
  readonly detail: string
  readonly seatCount: string
  readonly selectableCount: string
  readonly queueDepth: string
  readonly longestWait: string
  readonly observedAt: string
}

/**
 * **The SC-011 sentence.**
 *
 * Three verdicts, three different purchases, and the wording says which:
 *
 * - `healthy` — nothing is waiting, so there is no sizing question to answer. It deliberately does
 *   not say "the pool is fine": a pool with every seat held and nothing queued is fully utilised and
 *   correctly sized, and telling an administrator it has spare capacity would be a lie.
 * - `pool_undersized` — runs are waiting and no group anywhere has a free seat. More seats anywhere
 *   would help.
 * - `group_undersized` — runs are waiting **while other groups sit idle**. The platform has capacity
 *   these runs are not permitted to draw on, because their profiles are attached elsewhere (FR-063),
 *   so buying platform-wide would not clear the queue. The named groups are the answer, and they are
 *   in the sentence rather than a scroll away.
 */
export const toPoolSummary = (view: PoolView): PoolSummaryReadout => {
  const starved = view.starvedGroupNames.join(', ')

  const wording =
    view.verdict === 'healthy'
      ? {
          headline: 'No run is waiting for an agent credential.',
          detail:
            'Every group is serving the demand on it. A group with no free seat and nothing queued is fully utilised rather than short — this page flags a group when something starts waiting on it, and not before.',
        }
      : view.verdict === 'pool_undersized'
        ? {
            headline: `The pool is under-sized: ${String(view.queue.depth)} waiting, and no group has a free seat.`,
            detail:
              'Every group is exhausted at once, so additional seats anywhere would shorten this queue. Check the holders below first: a seat held by a parked run consumes capacity indefinitely while showing no activity, and is the likeliest reason a pool looks idle and behaves as though it is full.',
          }
        : {
            headline: `${starved} ${view.starvedGroupNames.length === 1 ? 'is' : 'are'} under-sized — the pool as a whole is not.`,
            detail: `Runs are waiting on ${starved} while other groups still have free seats. Those seats cannot serve these runs: work launched under an execution profile is only ever performed by a credential in one of that profile's attached groups. Buying platform-wide capacity would not clear this queue; adding seats to ${starved}, or attaching another group to the profiles that are waiting, would.`,
          }

  return {
    verdict: view.verdict,
    headline: wording.headline,
    detail: wording.detail,
    seatCount: String(view.seatCount),
    selectableCount: String(view.selectableCount),
    queueDepth: String(view.queue.depth),
    longestWait: formatDuration(view.queue.longestWaitMs),
    observedAt: formatTimestamp(view.observedAt),
  }
}

/** One group, shaped for its card. */
export interface PoolGroupReadout {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly pressure: PoolGroup['pressure']
  /** What this group's numbers mean, in one line. */
  readonly verdict: string
  readonly seatCount: string
  readonly selectableCount: string
  readonly queueDepth: string
  readonly longestWait: string
  /** `running 2 · paused 1 · parked 3 · keep-alive 1`, and never a bare "in use" (FR-074). */
  readonly holders: string
  readonly seats: readonly PoolSeatReadout[]
}

/**
 * The holder line, spelled out.
 *
 * The kinds are always all listed, zeroes included, and that is the requirement rather than a style:
 * FR-074 exists because a pool full of **parked** holders is indistinguishable from an idle one in
 * any summary that counts only "in use". A line that omitted the zero kinds would read differently
 * depending on what happened to be holding seats, and an administrator scanning for `parked` would
 * have to notice its absence rather than read a nought.
 *
 * `keep-alive` is named rather than folded into the total for the opposite reason: it is a transient
 * liveness exercise (FR-035), and an administrator who read one as a stuck seat would go looking for
 * a run to force-release that does not exist.
 */
export const describeHolders = (holders: PoolGroup['holders']): string =>
  [
    `running ${String(holders.running)}`,
    `paused ${String(holders.paused)}`,
    `parked ${String(holders.parked)}`,
    `keep-alive ${String(holders.keepAlive)}`,
    ...(holders.other > 0 ? [`other ${String(holders.other)}`] : []),
  ].join(' · ')

/** One line saying what this group's pressure means. */
const describePressure = (group: PoolGroup): string => {
  if (group.pressure === 'starved') {
    return `${String(group.queue.depth)} waiting, longest ${formatDuration(group.queue.longestWaitMs)} — this group needs more seats`
  }
  if (group.pressure === 'full') {
    return 'every seat is in use and nothing is waiting — fully utilised, not short'
  }
  return `${String(group.selectableCount)} of ${String(group.seatCount)} seats free`
}

/** One seat, shaped for its row. */
export interface PoolSeatReadout {
  readonly id: string
  readonly name: string
  readonly state: PoolSeat['state']
  readonly health: PoolSeat['health']
  readonly selectable: boolean
  /** `parked · workflow 0199… · 2d`, or `free`. */
  readonly holder: string
  /**
   * The holding run's state, for the chip. Undefined for a free seat or a keep-alive.
   *
   * `NonNullable` on the field as well as on the holder, because a keep-alive holds the seat and has
   * no workflow at all — the null there is not an absent holder, it is a holder that is not a run.
   */
  readonly holderWorkflowState?: NonNullable<NonNullable<PoolSeat['holder']>['workflowState']>
  readonly holderWorkflowId?: string
  readonly lastUsed: string
  readonly lastExercised: string
  readonly coolingOffUntil?: string
  /** Rendered verbatim and in full (FR-009). The provider's own words, very often the only evidence. */
  readonly lastFailureReason?: string
  readonly consumption: string
  readonly archived: boolean
}

/** How the holder reads on a seat's row. */
const describeHolder = (seat: PoolSeat): string => {
  if (seat.holder === null) {
    return seat.selectable ? 'free' : 'held by nobody'
  }

  if (seat.holder.kind === 'keep_alive') {
    // Named as the routine exercise it is, and pointedly not as a holder somebody should chase.
    return `keep-alive exercise · ${formatDuration(seat.holder.heldForMs)}`
  }

  return `${seat.holder.kind} · ${seat.holder.workflowId ?? 'unknown run'} · ${formatDuration(seat.holder.heldForMs)}`
}

/** Shape one seat for its row. */
export const toPoolSeatReadout = (seat: PoolSeat): PoolSeatReadout => ({
  id: seat.id,
  name: seat.name,
  state: seat.state,
  health: seat.health,
  selectable: seat.selectable,
  holder: describeHolder(seat),
  ...(seat.holder?.workflowState == null ? {} : { holderWorkflowState: seat.holder.workflowState }),
  ...(seat.holder?.workflowId == null ? {} : { holderWorkflowId: seat.holder.workflowId }),
  lastUsed: seat.lastUsedAt === null ? NEVER : formatTimestamp(seat.lastUsedAt),
  lastExercised: seat.lastExercisedAt === null ? NEVER : formatTimestamp(seat.lastExercisedAt),
  ...(seat.coolingOffUntil === null
    ? {}
    : { coolingOffUntil: formatTimestamp(seat.coolingOffUntil) }),
  ...(seat.lastFailureReason === null ? {} : { lastFailureReason: seat.lastFailureReason }),
  // Inference and compute reported as separate figures, never blended: FR-039 requires it, and a
  // single number would misrepresent both.
  consumption: `${String(seat.consumption.workflowCount)} runs · ${String(seat.consumption.turnsUsed)} turns · ${seat.consumption.spendUsed} inference · ${seat.consumption.computeCostBasis} compute`,
  archived: seat.archivedAt !== null,
})

/** Shape one group for its card. */
export const toPoolGroupReadout = (group: PoolGroup): PoolGroupReadout => ({
  id: group.credentialGroupId,
  name: group.credentialGroupName,
  enabled: group.enabled,
  pressure: group.pressure,
  verdict: describePressure(group),
  seatCount: String(group.seatCount),
  selectableCount: String(group.selectableCount),
  queueDepth: String(group.queue.depth),
  longestWait: formatDuration(group.queue.longestWaitMs),
  holders: describeHolders(group.holders),
  seats: group.seats.map(toPoolSeatReadout),
})
