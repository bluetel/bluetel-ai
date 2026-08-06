import { and, eq, inArray } from 'drizzle-orm'

import { roleChanges, users, workflows } from '../../db'
import { ACTIVE_WORKFLOW_STATES } from '../../enums'
import type { UserRole } from '../../enums'

import type { LockedUserState, UserWriter } from './active-admins'
import {
  assertActiveAdminRemains,
  lockUsersForRoleChange,
  userNotFoundError,
} from './active-admins'
import type { AuditedAction } from './audit-log'
import { recordConfigurationChange } from './audit-log'
import type { AdministeredUser } from './user-queries'
import { administeredUserColumns } from './user-queries'

/**
 * The two writes `admin.users` performs, as transaction bodies.
 *
 * Each one does four things and either all of them happen or none do:
 *
 * 1. takes the {@link lockUsersForRoleChange} lock and re-counts active admins under it (FR-173);
 * 2. updates the `users` row;
 * 3. appends a `role_changes` row — the append-only history of FR-177;
 * 4. writes a `configuration_audit` entry naming the acting admin, through
 *    `recordConfigurationChange`, which takes the same transaction handle so the trail cannot
 *    survive a change that rolled back.
 *
 * They live here rather than in the router so the router is wiring only, and so a test can run one
 * against a real transaction without going through tRPC.
 */

/** The change, and who made it. `actorUserId` is never null here — a human admin always acted. */
export interface UserChangeRequest {
  readonly writer: UserWriter
  readonly actorUserId: string
  readonly userId: string
  readonly reason?: string | undefined
}

/**
 * What a change returns.
 *
 * `changed` is false for a request that asks for the state the row is already in. Such a request
 * is not refused — it is simply not an event, and writing a `role_changes` row for it would put
 * "granted admin" in the history of someone who was already an admin (FR-177).
 */
export interface UserChangeResult {
  readonly user: AdministeredUser
  readonly changed: boolean
  /**
   * Runs flagged (or unflagged) by this change. Always 0 for a role change; see
   * {@link setUserActive} for what deactivation does to them (FR-176).
   */
  readonly workflowsFlaggedForReassignment: number
}

/**
 * The first row, honestly typed.
 *
 * `noUncheckedIndexedAccess` is off in this project, so `rows[0]` is typed as present even when the
 * result set is empty — and a `=== undefined` guard against it is narrowed away as unreachable.
 * Going through a function whose *declared* return type admits `undefined` restores the check.
 */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/** Read the subject under lock, or refuse. Shared by both changes so neither can skip the lock. */
const lockSubject = async (
  writer: UserWriter,
  userId: string,
): Promise<{ readonly subject: LockedUserState; readonly activeAdminCount: number }> => {
  const { subject, activeAdminCount } = await lockUsersForRoleChange(writer, userId)
  if (subject === undefined) {
    throw userNotFoundError()
  }
  return { subject, activeAdminCount }
}

/** Fetch the row as the admin surface reports it, after the update. */
const readAdministeredUser = async (
  writer: UserWriter,
  userId: string,
): Promise<AdministeredUser> => {
  const rows = await writer
    .select(administeredUserColumns)
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  const row = firstRow(rows)
  if (row === undefined) {
    throw userNotFoundError()
  }
  return row
}

/**
 * Change a user's role (FR-172).
 *
 * The invariant is checked against the count taken under the lock, so a concurrent demotion of a
 * different admin cannot have been observed as still-an-admin: see `./active-admins.ts`.
 */
export const setUserRole = async (
  request: UserChangeRequest & { readonly role: UserRole },
): Promise<UserChangeResult> => {
  const { writer, actorUserId, userId, role, reason } = request
  const { subject, activeAdminCount } = await lockSubject(writer, userId)

  if (subject.role === role) {
    return {
      user: await readAdministeredUser(writer, userId),
      changed: false,
      workflowsFlaggedForReassignment: 0,
    }
  }

  assertActiveAdminRemains({
    activeAdminCount,
    before: subject,
    after: { role, isActive: subject.isActive },
  })

  const updated = await writer
    .update(users)
    .set({ role })
    .where(eq(users.id, userId))
    .returning(administeredUserColumns)

  const user = firstRow(updated)
  if (user === undefined) {
    throw userNotFoundError()
  }

  await writer.insert(roleChanges).values({
    actorUserId,
    subjectUserId: userId,
    change: role === 'admin' ? 'grant_admin' : 'revoke_admin',
    reason: reason ?? null,
  })

  await recordConfigurationChange(writer, {
    actorUserId,
    entityType: 'user',
    entityId: userId,
    action: 'role_changed',
    detail: { from: subject.role, to: role, reason: reason ?? null },
  })

  return { user, changed: true, workflowsFlaggedForReassignment: 0 }
}

/**
 * Flag every non-terminal run the user owns as needing a new owner (FR-176).
 *
 * **Terminal runs are deliberately left alone.** Reassignment is about who is accountable for work
 * still in flight; flagging finished runs would fill the queue with history that nobody can act
 * on, and FR-176's other half — that past work stays attributed to them — says explicitly that it
 * should keep their name on it.
 *
 * Nothing here pauses, stops or otherwise touches the run itself. A workflow whose owner is
 * deactivated keeps running to its outcome: deactivation withdraws a person's access, and killing
 * their in-flight work would destroy exactly the history FR-176 requires be preserved.
 */
const flagOwnedWorkflows = async (writer: UserWriter, userId: string): Promise<number> => {
  const flagged = await writer
    .update(workflows)
    .set({ needsReassignment: true })
    .where(
      and(
        eq(workflows.ownerUserId, userId),
        eq(workflows.needsReassignment, false),
        inArray(workflows.state, [...ACTIVE_WORKFLOW_STATES]),
      ),
    )
    .returning({ id: workflows.id })

  return flagged.length
}

/**
 * Clear the flag on reactivation.
 *
 * The flag records one fact — "this run's owner was deactivated" — and reactivating them makes it
 * untrue. Runs an admin already reassigned are untouched, because they no longer have this owner.
 */
const clearReassignmentFlag = async (writer: UserWriter, userId: string): Promise<number> => {
  const cleared = await writer
    .update(workflows)
    .set({ needsReassignment: false })
    .where(and(eq(workflows.ownerUserId, userId), eq(workflows.needsReassignment, true)))
    .returning({ id: workflows.id })

  return cleared.length
}

/**
 * Deactivate or reactivate a user (FR-172, FR-175, FR-176).
 *
 * **Deactivation is not deletion.** No row is removed and nothing is anonymised: the user keeps
 * their history, their past workflows, corrections and configuration changes stay attributed to
 * them, and the only thing that changes is that `authedProcedure` turns them away from their next
 * request onward — immediately, because sessions are database-backed (FR-175).
 */
export const setUserActive = async (
  request: UserChangeRequest & { readonly isActive: boolean },
): Promise<UserChangeResult> => {
  const { writer, actorUserId, userId, isActive, reason } = request
  const { subject, activeAdminCount } = await lockSubject(writer, userId)

  if (subject.isActive === isActive) {
    return {
      user: await readAdministeredUser(writer, userId),
      changed: false,
      workflowsFlaggedForReassignment: 0,
    }
  }

  assertActiveAdminRemains({
    activeAdminCount,
    before: subject,
    after: { role: subject.role, isActive },
  })

  const updated = await writer
    .update(users)
    .set({ isActive })
    .where(eq(users.id, userId))
    .returning(administeredUserColumns)

  const user = firstRow(updated)
  if (user === undefined) {
    throw userNotFoundError()
  }

  const workflowsFlaggedForReassignment = isActive
    ? await clearReassignmentFlag(writer, userId)
    : await flagOwnedWorkflows(writer, userId)

  await writer.insert(roleChanges).values({
    actorUserId,
    subjectUserId: userId,
    change: isActive ? 'activate' : 'deactivate',
    reason: reason ?? null,
  })

  const action: AuditedAction = isActive ? 'activated' : 'deactivated'
  await recordConfigurationChange(writer, {
    actorUserId,
    entityType: 'user',
    entityId: userId,
    action,
    detail: { reason: reason ?? null, workflowsFlaggedForReassignment },
  })

  return { user, changed: true, workflowsFlaggedForReassignment }
}
