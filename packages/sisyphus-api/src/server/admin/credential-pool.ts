import { credentialPoolInput } from '../../schemas'
import { adminProcedure, createTRPCRouter } from '../procedures'

import type {
  CredentialConsumptionRow,
  CredentialPoolRow,
  CredentialQueueRow,
  CredentialQueueTotals,
} from './credential-store'
import {
  readCredentialConsumption,
  readCredentialPool,
  readCredentialQueueByGroup,
  readCredentialQueueTotals,
  readPoolCredentialGroups,
} from './credential-store'

/**
 * `admin.credentialPool` — **the one view that answers "should we buy another seat", per group**
 * (FR-053, FR-054, FR-055, FR-074, SC-011).
 *
 * Its siblings administer the pool: `admin.credentialGroups` the capacity pools, `admin.credentials`
 * the seats inside them. This one reports on it, and it is a separate mount because it is a
 * different question — those two answer "what is configured", this answers "is the configuration
 * enough", and the second is a read over the first plus the runs currently drawing on it.
 *
 * ## The bar this view has to clear, and how the shape of the answer clears it
 *
 * SC-011: an administrator must be able to tell an **under-sized group** from an **under-sized
 * pool** in one view and under thirty seconds. Those are different purchases — one is a seat in a
 * particular pool, the other is more capacity everywhere — and the failure this requirement exists
 * to prevent is an administrator adding seats to the wrong group because the screen showed one
 * aggregate number.
 *
 * So the distinction is a **computed field and not an inference**:
 *
 * - Every group carries its own {@link CredentialGroupPool.queue} — depth and longest current wait —
 *   beside its own free-seat count. Comparing the two is the whole judgement, and they are adjacent.
 * - Every group carries a {@link GroupPressure}: `starved` when something is waiting on it,
 *   `full` when nothing is waiting but nothing is free either, `available` otherwise.
 * - The view carries a {@link PoolVerdict} that reads the whole board at once.
 *   {@link POOL_UNDERSIZED} means runs are waiting and **no group anywhere has a free seat**;
 *   {@link GROUP_UNDERSIZED} means runs are waiting while some other group sits idle, and
 *   {@link CredentialPoolView.starvedGroupNames} names the ones to buy for.
 *
 * An administrator who reads nothing but `verdict` and `starvedGroupNames` has the answer. Everything
 * below those two exists so they can check it.
 *
 * ## Why the group is the spine, and not the credential
 *
 * The rows are laid out group by group even though every figure could have been rendered as a flat
 * list of seats. A group with **zero** credentials and three runs waiting on it is the most
 * under-sized a group can be, and it produces no credential row at all — a view assembled outward
 * from seats would silently omit exactly the case that most needs buying for. So the group list is
 * read separately and seats are filed into it (see `readPoolCredentialGroups`).
 *
 * ## Holders are broken down because a full pool and an idle one look identical from outside
 *
 * FR-074. See {@link holderKindOf} — the reasoning belongs with the function that makes the
 * distinction rather than up here.
 *
 * ## Nothing here notifies anybody (FR-079)
 *
 * This router raises no notification, and neither does anything it calls. A run waiting for a
 * credential, a seat cooling off, a run parked while holding one: FR-079 makes all three
 * owner-silent, reported on the workflow view and on this screen and pushed nowhere. That is not an
 * omission to be corrected later — waking an engineer about ordinary pool contention they cannot act
 * on is how a notification channel stops being read. Administrator alerting under FR-056 is a
 * separate path with a separate audience and a separate vocabulary, and it lives in
 * `packages/sisyphus-notify/src/credential-alerts.ts`. The two are wired to different people on
 * purpose.
 *
 * ## Admin-only, including the reads
 *
 * FR-053 says administrator-only in as many words, and data-model.md → Access scoping says why the
 * *reads* are too: credential configuration is stricter than 002's profile-scoped model, because a
 * credential is platform infrastructure and its state tells an engineer nothing they can act on. The
 * one engineer-visible fact — that their own run is waiting, and for how long — reaches them through
 * the workflow view and the existing workflow scoping, never through this query.
 */

/** How a seat currently in `held` is being used (FR-074, plus the keep-alive case). */
export type CredentialHolderKind = 'running' | 'paused' | 'parked' | 'keep_alive' | 'other'

/**
 * **What is holding this seat — the FR-074 distinction, and why each case is separate.**
 *
 * A held seat is capacity that is gone, and every kind of holder consumes it identically. What
 * differs is what an administrator should do about it, and three of these cases are routinely
 * mistaken for each other:
 *
 * - **`parked`** — a `parked_resumable` run. It shows no activity, holds no instance and costs
 *   nothing to run, and it keeps its agent identity **indefinitely** (FR-019: the lease belongs to
 *   the workflow and survives the destruction of every environment it ever had). This is the
 *   likeliest cause of unexplained pool exhaustion, and it is the reason FR-074 exists: from any
 *   summary that counts only "in use", a pool full of parked holders is indistinguishable from an
 *   idle one. Somebody looking at that summary concludes the pool is fine and the queue is a
 *   mystery.
 * - **`keep_alive`** — the scheduled FR-035 exercise, which claims an idle seat through the same
 *   conditional `UPDATE` a workflow reservation does and is therefore `held` in exactly the same
 *   way. It is **transient**, measured in the seconds an exercise takes, and it must not be read as
 *   a parked holder: an administrator who mistakes a routine liveness check for a stuck seat goes
 *   looking for a run to force-release that does not exist. It is distinguishable at all only
 *   because `agent_credentials.held_by` records which of the two claimed the row — a keep-alive has
 *   no workflow, so it can hold no lease and would otherwise be an unexplained `held` with nothing
 *   attached.
 * - **`paused`** — a deliberately suspended run. It still holds the seat, and it comes back.
 * - **`running`** — the ordinary case, and the only one that needs no explanation.
 *
 * `other` is every remaining state a lease-holding workflow can be in: `provisioning` on the way up,
 * or a terminal state whose release has not landed yet. It exists so the breakdown **totals** to the
 * number of live leases rather than quietly dropping the rows nobody thought about — a breakdown
 * that does not add up is one nobody can trust the interesting rows of.
 *
 * @param row - One seat as read, with whatever live lease and workflow hang off it.
 * @returns The holder kind, or `undefined` when nothing holds this seat.
 */
export const holderKindOf = (row: CredentialPoolRow): CredentialHolderKind | undefined => {
  // `held_by` first, because it is the only evidence a keep-alive leaves: it takes no lease, so
  // reading the lease join first would classify it as `other` and lose the distinction entirely.
  if (row.heldBy === 'keep_alive') {
    return 'keep_alive'
  }

  if (row.holderWorkflowId === null) {
    // No live lease and no keep-alive claim. A seat in `held` with neither is a defect somewhere
    // else — a claim that was written and never resolved — and reporting it as free would hide it.
    return row.state === 'held' ? 'other' : undefined
  }

  switch (row.holderWorkflowState) {
    case 'running':
      return 'running'
    case 'paused':
      return 'paused'
    case 'parked_resumable':
      return 'parked'
    default:
      return 'other'
  }
}

/**
 * Whether a seat is well, and if not, in which of the four ways (FR-009, FR-053, FR-075).
 *
 * Health is not the same question as `state`, and it is not the same question as `selectable`
 * either. `state` says where the credential is in its lifecycle; `selectable` says whether the
 * allocator can hand it out right now, which a perfectly healthy seat fails while it is held. Health
 * is the third question — *does somebody need to do something about this seat* — and only
 * `unhealthy` answers yes.
 *
 * The distinction FR-075 insists on is the one between `unhealthy` and `cooling_off`: broken versus
 * rate-limited. A cooling-off seat clears by itself (FR-076) and raises nothing; an unhealthy one
 * waits on a human. Collapsing the two into "not working" would either page somebody about a
 * provider limit or leave a broken login sitting in the pool looking temporary.
 *
 * **Derived in TypeScript, unlike `selectable`, and the asymmetry is deliberate.** `selectable` is a
 * safety property — the panel and the allocator must not disagree about what may be handed out — so
 * it is computed in the database from the one predicate. Health is a *reporting* judgement with no
 * allocator counterpart, and computing it here keeps it testable against every combination without a
 * database.
 */
export type CredentialHealth =
  | 'healthy'
  | 'unhealthy'
  | 'cooling_off'
  | 'never_logged_in'
  | 'withdrawn'

/** See {@link CredentialHealth}. Order matters: the first applicable condition is the one reported. */
export const healthOf = (row: CredentialPoolRow): CredentialHealth => {
  if (row.state === 'unhealthy') {
    return 'unhealthy'
  }
  if (row.state === 'cooling_off') {
    return 'cooling_off'
  }
  // Withdrawal is checked before the missing login, because a withdrawn seat is not somewhere a
  // login would be the next step: re-enable it first, and then the login question is meaningful.
  if (row.archivedAt !== null || !row.enabled || !row.credentialGroupEnabled) {
    return 'withdrawn'
  }
  if (!row.hasSecret) {
    return 'never_logged_in'
  }
  return 'healthy'
}

/** Whether one group has room, is full, or has runs queued on it (SC-011). */
export type GroupPressure = 'available' | 'full' | 'starved'

/**
 * One group's pressure.
 *
 * `starved` is decided by the **queue** and not by the free-seat count, which is the whole point: a
 * group with no free seats and nothing waiting is correctly sized and fully utilised, which is what
 * a pool is *for*. It becomes under-sized at the moment something waits on it, and not a moment
 * earlier. A screen that flagged every full group would train an administrator to buy capacity for
 * pools that were working perfectly.
 */
export const pressureOf = (input: {
  readonly selectableCount: number
  readonly queueDepth: number
}): GroupPressure => {
  if (input.queueDepth > 0) {
    return 'starved'
  }
  return input.selectableCount === 0 ? 'full' : 'available'
}

/** Runs are waiting and no group anywhere has a free seat: the platform needs more capacity. */
export const POOL_UNDERSIZED = 'pool_undersized'
/** Runs are waiting while another group sits idle: the shortage is in named groups, not the pool. */
export const GROUP_UNDERSIZED = 'group_undersized'
/** Nothing is waiting. */
export const POOL_HEALTHY = 'healthy'

/** SC-011's answer, in one field. See {@link verdictOf}. */
export type PoolVerdict = typeof POOL_UNDERSIZED | typeof GROUP_UNDERSIZED | typeof POOL_HEALTHY

/**
 * **SC-011's distinction, computed once rather than left to be inferred.**
 *
 * The requirement is that an administrator can tell an under-sized *group* from an under-sized
 * *pool* in under thirty seconds. The information to do that is in the per-group figures, but
 * working it out means reading every group's queue against every group's free seats and holding the
 * comparison in your head — which is the thirty seconds, and which somebody in a hurry gets wrong.
 *
 * So the comparison is the field:
 *
 * - Nothing waiting → {@link POOL_HEALTHY}. There is no sizing question to answer.
 * - Something waiting and **no** group has a selectable seat → {@link POOL_UNDERSIZED}. Every pool
 *   is exhausted at once; more seats anywhere would help.
 * - Something waiting while some group still has a free seat → {@link GROUP_UNDERSIZED}. The
 *   platform has capacity that these particular runs are not allowed to draw on, because their
 *   profiles are not attached to the group holding it (FR-063). Buying platform-wide capacity would
 *   not clear this queue; buying into the named groups would.
 *
 * The third case is the one an aggregate number hides, and it is the common one — it is what
 * happens the first time a profile is attached to a single small group.
 */
export const verdictOf = (input: {
  readonly queueDepth: number
  readonly selectableCount: number
}): PoolVerdict => {
  if (input.queueDepth === 0) {
    return POOL_HEALTHY
  }
  return input.selectableCount === 0 ? POOL_UNDERSIZED : GROUP_UNDERSIZED
}

/** What is holding one seat, and for how long (FR-053, FR-074). */
export interface CredentialPoolHolder {
  readonly kind: CredentialHolderKind
  /** The run holding it, or null for a keep-alive exercise — which has no workflow, by design. */
  readonly workflowId: string | null
  readonly workflowState: CredentialPoolRow['holderWorkflowState']
  readonly acquiredAt: Date | null
  /**
   * How long the current claim has been held, in milliseconds, or null where there is no lease to
   * measure from.
   *
   * Reported as a duration rather than left as two timestamps because it is the number the FR-056
   * lease-hold alert is raised against, and a screen that made an administrator subtract dates would
   * disagree with that alert by however long the page had been open.
   */
  readonly heldForMs: number | null
}

/** What one seat has consumed, across every run that used it (FR-055). */
export interface CredentialConsumption {
  readonly workflowCount: number
  readonly turnsUsed: number
  readonly spendUsed: string
  readonly computeCostBasis: string
}

/** One seat, as the pool view renders it (FR-053). */
export interface CredentialPoolSeat {
  readonly id: string
  readonly name: string
  readonly state: CredentialPoolRow['state']
  readonly health: CredentialHealth
  readonly enabled: boolean
  /** The database's own verdict, never re-derived here. See `selectableCredentialCondition`. */
  readonly selectable: boolean
  readonly holder: CredentialPoolHolder | null
  readonly lastUsedAt: Date | null
  readonly lastExercisedAt: Date | null
  readonly lastLoginAt: Date | null
  readonly coolingOffUntil: Date | null
  /** Rendered verbatim to administrators (FR-009). A reason, never material. */
  readonly lastFailureReason: string | null
  readonly archivedAt: Date | null
  readonly consumption: CredentialConsumption
}

/** Holders, broken down by what is holding them (FR-074). */
export interface HolderBreakdown {
  readonly running: number
  readonly paused: number
  readonly parked: number
  readonly keepAlive: number
  readonly other: number
  /** The sum of the five. Equal to the number of live claims, which is what makes it checkable. */
  readonly total: number
}

/** The FR-054 queue, for one group or for the platform. */
export interface CredentialQueueView {
  readonly depth: number
  /** The oldest waiting run's age in milliseconds — FR-054's "longest current wait". */
  readonly longestWaitMs: number | null
  readonly waitingSince: Date | null
}

/** One group's capacity, its holders, and what is waiting on it (FR-053, FR-054, FR-074). */
export interface CredentialGroupPool {
  readonly credentialGroupId: string
  readonly credentialGroupName: string
  readonly enabled: boolean
  /** Live seats filed under this group. Archived ones are excluded: they are not capacity. */
  readonly seatCount: number
  /** Seats a run could be given right now. The number the queue depth is read against. */
  readonly selectableCount: number
  readonly holders: HolderBreakdown
  readonly queue: CredentialQueueView
  readonly pressure: GroupPressure
  readonly seats: readonly CredentialPoolSeat[]
}

/** The whole pool, grouped (FR-053). */
export interface CredentialPoolView {
  /** The clock every hold duration and wait length on this page was measured against. */
  readonly observedAt: Date
  readonly groups: readonly CredentialGroupPool[]
  readonly seatCount: number
  readonly selectableCount: number
  readonly holders: HolderBreakdown
  /**
   * The platform's waiting set, counted **once per run**.
   *
   * Deliberately not the sum of the per-group depths, which counts a run against every group it
   * could be served from — see `readCredentialQueueByGroup`. Both figures are true and they answer
   * different questions; presenting one as the other is the arithmetic error this screen is most
   * likely to make.
   */
  readonly queue: CredentialQueueView & { readonly unattributableDepth: number }
  readonly verdict: PoolVerdict
  /** The groups something is waiting on, in the order the groups are listed. */
  readonly starvedGroupNames: readonly string[]
}

/** Zero holders, as a starting value the folds below add into. */
const NO_HOLDERS: HolderBreakdown = {
  running: 0,
  paused: 0,
  parked: 0,
  keepAlive: 0,
  other: 0,
  total: 0,
}

/** Add one holder to a breakdown. */
const withHolder = (breakdown: HolderBreakdown, kind: CredentialHolderKind): HolderBreakdown => ({
  running: breakdown.running + (kind === 'running' ? 1 : 0),
  paused: breakdown.paused + (kind === 'paused' ? 1 : 0),
  parked: breakdown.parked + (kind === 'parked' ? 1 : 0),
  keepAlive: breakdown.keepAlive + (kind === 'keep_alive' ? 1 : 0),
  other: breakdown.other + (kind === 'other' ? 1 : 0),
  total: breakdown.total + 1,
})

/** Add two breakdowns, for rolling group totals up to the platform. */
const addBreakdowns = (left: HolderBreakdown, right: HolderBreakdown): HolderBreakdown => ({
  running: left.running + right.running,
  paused: left.paused + right.paused,
  parked: left.parked + right.parked,
  keepAlive: left.keepAlive + right.keepAlive,
  other: left.other + right.other,
  total: left.total + right.total,
})

/** Nothing consumed. What a seat that has never been used honestly reports (FR-055). */
const NOTHING_CONSUMED: CredentialConsumption = {
  workflowCount: 0,
  turnsUsed: 0,
  spendUsed: '0.0000',
  computeCostBasis: '0.0000',
}

/** A wait, measured against one clock so every figure on the page agrees. */
const waitFrom = (waitingSince: Date | null, now: Date): CredentialQueueView['longestWaitMs'] =>
  waitingSince === null ? null : Math.max(0, now.getTime() - waitingSince.getTime())

/** Everything {@link assemblePool} folds together. Four reads and a clock, and nothing else. */
export interface AssemblePoolInput {
  readonly groups: readonly {
    readonly id: string
    readonly name: string
    readonly enabled: boolean
  }[]
  readonly rows: readonly CredentialPoolRow[]
  readonly queueRows: readonly CredentialQueueRow[]
  readonly queueTotals: CredentialQueueTotals
  readonly consumption: readonly CredentialConsumptionRow[]
  readonly now: Date
}

/**
 * Fold the four reads into the view.
 *
 * Pure, and exported, so every combination that matters — a group with no seats and a queue, a
 * parked holder next to a keep-alive, a seat that has consumed nothing — is testable without a
 * database. The resolver below does the reading and nothing else.
 *
 * @param input - See {@link AssemblePoolInput}.
 */
export const assemblePool = (input: AssemblePoolInput): CredentialPoolView => {
  const queueByGroup = new Map(input.queueRows.map((row) => [row.credentialGroupId, row]))
  const consumptionById = new Map(input.consumption.map((row) => [row.agentCredentialId, row]))

  const rowsByGroup = new Map<string, CredentialPoolRow[]>()
  for (const row of input.rows) {
    const existing = rowsByGroup.get(row.credentialGroupId)
    if (existing === undefined) {
      rowsByGroup.set(row.credentialGroupId, [row])
      continue
    }
    existing.push(row)
  }

  const groups = input.groups.map((group): CredentialGroupPool => {
    const rows = rowsByGroup.get(group.id) ?? []
    let holders = NO_HOLDERS
    let selectableCount = 0
    let seatCount = 0

    const seats = rows.map((row): CredentialPoolSeat => {
      const kind = holderKindOf(row)
      if (kind !== undefined) {
        holders = withHolder(holders, kind)
      }
      if (row.selectable) {
        selectableCount += 1
      }
      if (row.archivedAt === null) {
        seatCount += 1
      }

      const consumed = consumptionById.get(row.id)

      return {
        id: row.id,
        name: row.name,
        state: row.state,
        health: healthOf(row),
        enabled: row.enabled,
        selectable: row.selectable,
        holder:
          kind === undefined
            ? null
            : {
                kind,
                workflowId: row.holderWorkflowId,
                workflowState: row.holderWorkflowState,
                acquiredAt: row.holderAcquiredAt,
                heldForMs: waitFrom(row.holderAcquiredAt, input.now),
              },
        lastUsedAt: row.lastUsedAt,
        lastExercisedAt: row.lastExercisedAt,
        lastLoginAt: row.lastLoginAt,
        coolingOffUntil: row.coolingOffUntil,
        lastFailureReason: row.lastFailureReason,
        archivedAt: row.archivedAt,
        consumption:
          consumed === undefined
            ? NOTHING_CONSUMED
            : {
                workflowCount: consumed.workflowCount,
                turnsUsed: consumed.turnsUsed,
                spendUsed: consumed.spendUsed,
                computeCostBasis: consumed.computeCostBasis,
              },
      }
    })

    const waiting = queueByGroup.get(group.id)
    const queue: CredentialQueueView = {
      depth: waiting?.depth ?? 0,
      waitingSince: waiting?.waitingSince ?? null,
      longestWaitMs: waitFrom(waiting?.waitingSince ?? null, input.now),
    }

    return {
      credentialGroupId: group.id,
      credentialGroupName: group.name,
      enabled: group.enabled,
      seatCount,
      selectableCount,
      holders,
      queue,
      pressure: pressureOf({ selectableCount, queueDepth: queue.depth }),
      seats,
    }
  })

  const selectableCount = groups.reduce((total, group) => total + group.selectableCount, 0)

  return {
    observedAt: input.now,
    groups,
    seatCount: groups.reduce((total, group) => total + group.seatCount, 0),
    selectableCount,
    holders: groups.reduce((total, group) => addBreakdowns(total, group.holders), NO_HOLDERS),
    queue: {
      depth: input.queueTotals.depth,
      waitingSince: input.queueTotals.waitingSince,
      longestWaitMs: waitFrom(input.queueTotals.waitingSince, input.now),
      unattributableDepth: input.queueTotals.unattributableDepth,
    },
    verdict: verdictOf({ queueDepth: input.queueTotals.depth, selectableCount }),
    starvedGroupNames: groups
      .filter((group) => group.pressure === 'starved')
      .map((group) => group.credentialGroupName),
  }
}

export const credentialPoolRouter = createTRPCRouter({
  /**
   * The whole pool, grouped, with its queue and its spend (FR-053, FR-054, FR-055, FR-074).
   *
   * One procedure rather than four, because SC-011's requirement is "in one view": a page that had
   * to fetch capacity, holders, the queue and spend separately would render them at four different
   * instants, and the comparison an administrator is making — this many waiting against this many
   * free — would be between two numbers taken seconds apart. They are read together and stamped with
   * one {@link CredentialPoolView.observedAt} for that reason.
   *
   * The reads are issued together rather than in sequence. They are four independent queries against
   * four different row sets, and nothing here needs them to be consistent to the transaction: this
   * is a report, and a seat freed between the first read and the third makes the page a second stale
   * rather than wrong. A serialisable transaction would buy that consistency at the cost of taking a
   * snapshot every time somebody opens a dashboard.
   */
  view: adminProcedure
    .input(credentialPoolInput)
    .query(async ({ ctx, input }): Promise<CredentialPoolView> => {
      const [groups, rows, queueRows, queueTotals] = await Promise.all([
        readPoolCredentialGroups(ctx.db),
        readCredentialPool(ctx.db, { includeArchived: input.includeArchived }),
        readCredentialQueueByGroup(ctx.db),
        readCredentialQueueTotals(ctx.db),
      ])

      // Second, because it is the one read that depends on the first: FR-055 attributes spend to the
      // seats this view is reporting, and asking for every credential that ever existed would
      // aggregate the whole `workflows` table to render a page about the ones that still do.
      const consumption = await readCredentialConsumption(
        ctx.db,
        rows.map((row) => row.id),
      )

      return assemblePool({ groups, rows, queueRows, queueTotals, consumption, now: new Date() })
    }),
})

export type CredentialPoolRouter = typeof credentialPoolRouter
