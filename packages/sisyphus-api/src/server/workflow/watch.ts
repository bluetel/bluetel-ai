import { and, eq, inArray } from 'drizzle-orm'

import type { SisyphusDatabase } from '../../db'
import { notificationPreferences, workflowWatchers } from '../../db'
import type { NotificationEvent, SetNotificationPreferenceInput } from '../../schemas'
import {
  NOTIFICATION_EVENTS,
  setNotificationPreferenceInput,
  watchWorkflowInput,
} from '../../schemas'
import { authedProcedure, scopedProcedure } from '../procedures'
import type { ResolvedScope } from '../scope'
import { requireWorkflowInScope } from '../scope'

/**
 * Watching a run, and choosing what to be told about it (FR-138, FR-188, FR-190).
 *
 * Three rules govern this file, and each one is a rule about a *default* or an *absence* — which is
 * why they are stated here rather than left to the resolvers.
 *
 * ## 1. `watch` is scoped like a read, so it is not an existence oracle
 *
 * {@link watchWorkflow} is built on `scopedProcedure` and its first act is
 * `requireWorkflowInScope`, exactly as `byId` and `timeline` do. A workflow the caller may not see
 * is reported as **absent**, with the same `NOT_FOUND` and the same message a nonexistent id gets
 * (FR-190). That matters more here than on a read: a mutation that answered `FORBIDDEN` for an
 * out-of-scope run and `NOT_FOUND` for an absent one would be a two-response oracle over the whole
 * id space, usable to enumerate runs without ever seeing one. The insert is therefore never
 * reached, rather than being reached and rolled back — a unique-violation or a foreign-key error
 * surfacing to the caller would disclose the same fact the `NOT_FOUND` withholds.
 *
 * `unwatch` is scoped identically, for the same reason. Discovering a run by trying to stop
 * following it is the same oracle read backwards.
 *
 * ## 2. Revoking a grant removes the watch, and nothing here puts it back
 *
 * `../admin/grant-store.ts` already performs the FR-188 cascade: revoking a grant deletes the
 * watcher rows that grant alone was keeping alive, sparing the ones on workflows the user owns or
 * initiated, which reach them through the ownership clauses of the scope selector instead
 * (FR-189). This module's part of that contract is entirely negative — **no function here
 * re-creates a removed watch**. It cannot, because rule 1 makes every write go through the scope
 * first: once the grant is gone the workflow is out of scope, and a re-watch is refused with the
 * same `NOT_FOUND` any other stranger gets. There is no revive path, no upsert-on-read, and no
 * "restore my watches" convenience.
 *
 * ## 3. Absence of a preference row means **enabled**
 *
 * A user who has never opened their preferences is notified (FR-138, `db/schema/notify.ts`). So
 * {@link readNotificationPreferences} returns the whole event vocabulary with `enabled: true`
 * wherever no row exists, rather than returning the rows that happen to be there — an inner join
 * would silently mute every user with no rows at all, which is the failure mode that looks like
 * working software. {@link setNotificationPreference} writes a row for either value, because a row
 * records a *decision*, and "I have chosen to keep this on" is a decision worth surviving a change
 * of default.
 */

/** What watching needs from a handle — satisfied by the pool or by an open transaction. */
export type WatchWriter = Pick<SisyphusDatabase, 'delete' | 'insert' | 'select'>

/** Arguments shared by both watch mutations. */
export interface WatchRequest {
  readonly db: SisyphusDatabase
  readonly scope: ResolvedScope
  readonly userId: string
  readonly workflowId: string
}

/** The outcome of a watch or unwatch. */
export interface WatchResult {
  readonly workflowId: string
  readonly watching: boolean
  /**
   * False when the request asked for the state already held. Not a refusal — watching a run twice
   * is one watch, and reporting it as an error would make a double-clicked button a failure.
   */
  readonly changed: boolean
}

/**
 * The first row, honestly typed.
 *
 * `noUncheckedIndexedAccess` is off in this project, so `rows[0]` is typed as present even when the
 * result set is empty — and a `=== undefined` guard against it is narrowed away as unreachable.
 * Going through a function whose *declared* return type admits `undefined` restores the check.
 */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/**
 * Follow a run the caller does not own (FR-138).
 *
 * The scope check comes first and is not optional: see rule 1 in the module comment. `onConflictDoNothing`
 * on the `(workflow_id, user_id)` unique index makes a repeated watch idempotent rather than an
 * error.
 *
 * @param request - See {@link WatchRequest}.
 */
export const watchWorkflow = async (request: WatchRequest): Promise<WatchResult> => {
  const { db, scope, userId, workflowId } = request

  // Throws `NOT_FOUND` for an out-of-scope run, indistinguishably from a nonexistent one (FR-190).
  // Nothing below is reached in that case, so no constraint violation can leak what this withheld.
  await requireWorkflowInScope({ db, scope, workflowId })

  const inserted = await db
    .insert(workflowWatchers)
    .values({ workflowId, userId })
    .onConflictDoNothing({ target: [workflowWatchers.workflowId, workflowWatchers.userId] })
    .returning({ id: workflowWatchers.id })

  return { workflowId, watching: true, changed: inserted.length > 0 }
}

/**
 * Stop following a run (FR-138).
 *
 * Scoped identically to {@link watchWorkflow}: a caller who cannot see the run cannot learn that it
 * exists by trying to unfollow it.
 *
 * @param request - See {@link WatchRequest}.
 */
export const unwatchWorkflow = async (request: WatchRequest): Promise<WatchResult> => {
  const { db, scope, userId, workflowId } = request

  await requireWorkflowInScope({ db, scope, workflowId })

  const removed = await db
    .delete(workflowWatchers)
    .where(and(eq(workflowWatchers.workflowId, workflowId), eq(workflowWatchers.userId, userId)))
    .returning({ id: workflowWatchers.id })

  return { workflowId, watching: false, changed: removed.length > 0 }
}

/** Whether one user currently watches one workflow. Unscoped: callers have already scoped. */
export const isWatching = async (
  reader: Pick<SisyphusDatabase, 'select'>,
  input: { readonly workflowId: string; readonly userId: string },
): Promise<boolean> => {
  const row = firstRow(
    await reader
      .select({ id: workflowWatchers.id })
      .from(workflowWatchers)
      .where(
        and(
          eq(workflowWatchers.workflowId, input.workflowId),
          eq(workflowWatchers.userId, input.userId),
        ),
      )
      .limit(1),
  )

  return row !== undefined
}

/** One event and whether the user wants it, with `true` standing for "no row" (FR-138). */
export interface EffectiveNotificationPreference {
  readonly event: NotificationEvent
  readonly enabled: boolean
  /** False when this is the default rather than a recorded choice. Lets the panel say so. */
  readonly explicit: boolean
}

/**
 * Fold stored rows over the full event vocabulary.
 *
 * Pure, and separated from the query on purpose: "absence means enabled" is the single rule most
 * easily inverted by an edit, and it is asserted here without a database.
 *
 * @param stored - The rows that exist. Events absent from this list take the default.
 */
export const applyPreferenceDefaults = (
  stored: readonly { readonly event: NotificationEvent; readonly enabled: boolean }[],
): readonly EffectiveNotificationPreference[] => {
  const recorded = new Map(stored.map((row) => [row.event, row.enabled]))

  return NOTIFICATION_EVENTS.map((event) => {
    const choice = recorded.get(event)
    // `?? true`, never `=== true`: the default is enabled, so an unrecorded event is on.
    return { event, enabled: choice ?? true, explicit: choice !== undefined }
  })
}

/**
 * Every event, with the caller's effective setting (FR-138).
 *
 * Returns the whole vocabulary rather than the stored rows, so a user who has never touched their
 * preferences gets eight `true`s rather than an empty list a caller might read as silence.
 *
 * @param reader - A handle or transaction.
 * @param userId - Whose preferences.
 */
export const readNotificationPreferences = async (
  reader: Pick<SisyphusDatabase, 'select'>,
  userId: string,
): Promise<readonly EffectiveNotificationPreference[]> => {
  const stored = await reader
    .select({ event: notificationPreferences.event, enabled: notificationPreferences.enabled })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId))

  return applyPreferenceDefaults(stored)
}

/**
 * Whether a set of users want a given event, as the delivery path needs it.
 *
 * Returns **only the rows that exist**, deliberately: the caller applies the default, so there is
 * one implementation of "absence means enabled" ({@link applyPreferenceDefaults}) rather than one
 * here and another in the control plane.
 */
export const readStoredPreferences = async (
  reader: Pick<SisyphusDatabase, 'select'>,
  input: { readonly userIds: readonly string[]; readonly event: NotificationEvent },
): Promise<readonly { readonly userId: string; readonly enabled: boolean }[]> => {
  if (input.userIds.length === 0) {
    return []
  }

  return reader
    .select({ userId: notificationPreferences.userId, enabled: notificationPreferences.enabled })
    .from(notificationPreferences)
    .where(
      and(
        inArray(notificationPreferences.userId, [...input.userIds]),
        eq(notificationPreferences.event, input.event),
      ),
    )
}

/**
 * Record a per-event choice (FR-138).
 *
 * Written for `false` **and** for `true`. A row means "this person decided", which is why
 * re-enabling an event stores a row rather than deleting one: the two are indistinguishable in
 * effect today, and would stop being so the moment a default changed.
 *
 * @param writer - A handle or transaction.
 * @param input - Whose preference, which event, and the choice.
 */
export const setNotificationPreference = async (
  writer: Pick<SisyphusDatabase, 'insert'>,
  input: SetNotificationPreferenceInput & { readonly userId: string },
): Promise<EffectiveNotificationPreference> => {
  await writer
    .insert(notificationPreferences)
    .values({ userId: input.userId, event: input.event, enabled: input.enabled })
    .onConflictDoUpdate({
      target: [notificationPreferences.userId, notificationPreferences.event],
      set: { enabled: input.enabled, updatedAt: new Date() },
    })

  return { event: input.event, enabled: input.enabled, explicit: true }
}

/**
 * `workflow.watch` — ready to mount (FR-138, FR-190).
 *
 * **`scopedProcedure`, and that is the whole security argument.** `authedProcedure` would
 * authenticate the caller and leave the resolver to decide for itself what it may touch; the
 * resolved scope is what makes `requireWorkflowInScope` available, and the module comment's rule 1
 * is what it is used for.
 */
export const watchProcedure = scopedProcedure.input(watchWorkflowInput).mutation(
  async ({ ctx, input }): Promise<WatchResult> =>
    watchWorkflow({
      db: ctx.db,
      scope: ctx.scope,
      userId: ctx.user.id,
      workflowId: input.workflowId,
    }),
)

/** `workflow.unwatch` — ready to mount. Scoped identically to {@link watchProcedure}. */
export const unwatchProcedure = scopedProcedure.input(watchWorkflowInput).mutation(
  async ({ ctx, input }): Promise<WatchResult> =>
    unwatchWorkflow({
      db: ctx.db,
      scope: ctx.scope,
      userId: ctx.user.id,
      workflowId: input.workflowId,
    }),
)

/**
 * `workflow.notificationPreferences` — ready to mount (FR-138).
 *
 * `authedProcedure` rather than `scopedProcedure`, per api-surface.md: a preference is about the
 * caller's own account and names no workflow, so there is no visible set for a scope to constrain
 * and resolving one would put a grants query on a request that never reads it.
 */
export const notificationPreferencesProcedure = authedProcedure.query(
  async ({ ctx }): Promise<readonly EffectiveNotificationPreference[]> =>
    readNotificationPreferences(ctx.db, ctx.user.id),
)

/** `workflow.setNotificationPreference` — ready to mount. Always the caller's own (FR-138). */
export const setNotificationPreferenceProcedure = authedProcedure
  .input(setNotificationPreferenceInput)
  .mutation(
    async ({ ctx, input }): Promise<EffectiveNotificationPreference> =>
      // `ctx.user.id`, never an id from the input: there is no schema field for whose preference
      // this is, and adding one would make muting somebody else's notifications a request away.
      setNotificationPreference(ctx.db, { ...input, userId: ctx.user.id }),
  )
