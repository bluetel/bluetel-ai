import { TRPCError } from '@trpc/server'
import { and, eq, or } from 'drizzle-orm'

import type { SisyphusDatabase } from '../../db'
import { users } from '../../db'
import type { UserRole } from '../../enums'

/**
 * The never-zero-active-admins invariant (FR-173), and the lock that makes it hold under
 * concurrency.
 *
 * The naive implementation counts active admins, decides, and then writes. Two admins demoting
 * each other at the same moment both read "2", both decide the change is safe, and the platform
 * ends up with none — after which nothing can register a bundle, revoke a grant or restore an
 * admin, and recovery is a redeploy. That is the exact sequence this module exists to forbid, so
 * the count is taken **inside the caller's transaction with the rows locked**, never before it.
 *
 * ## How the lock works
 *
 * {@link lockUsersForRoleChange} issues one statement:
 *
 * ```sql
 * select id, role, is_active from users
 *  where id = $subject or (role = 'admin' and is_active)
 *  order by id
 *    for update
 * ```
 *
 * Three properties are load-bearing, and each of them is a bug if it is dropped:
 *
 * 1. **One statement, not two.** Locking the subject and then the admin set would let two
 *    transactions acquire the two halves in opposite orders and deadlock. A single locking
 *    statement takes the whole set at once.
 * 2. **`order by id`.** Postgres puts the `LockRows` node above the sort, so rows are locked in
 *    id order. Two concurrent callers therefore queue on the same row rather than on each other.
 * 3. **`for update`, not a plain read.** Under `read committed` — the default the callers'
 *    transactions run in — a locking read that meets a row updated by a transaction that has
 *    since committed re-fetches the newest version and re-checks the `where` against it
 *    (EvalPlanQual). So the loser of a race does not merely block: it wakes up seeing the
 *    *winner's* demotion already applied, its count comes back one lower, and it refuses. A
 *    non-locking `select count(*)` would return the pre-race number and let both changes through.
 *
 * Rows that concurrently *become* active admins are not locked, and need not be: a new admin can
 * only make the invariant easier to satisfy.
 */

/**
 * Anything that can run a locking select and a write — the pooled handle or, in practice always,
 * a transaction derived from it. Typed structurally so a caller inside `db.transaction(...)` can
 * pass the transaction object without a cast, exactly like `AuditWriter` in `./audit-log`.
 */
export type UserWriter = Pick<SisyphusDatabase, 'select' | 'insert' | 'update'>

/** The three facts about a user row that the invariant depends on. Nothing else is read. */
export interface LockedUserState {
  readonly id: string
  readonly role: UserRole
  readonly isActive: boolean
}

/** What a user row will look like after the change being considered. */
export interface ProposedUserState {
  readonly role: UserRole
  readonly isActive: boolean
}

/** The result of taking the lock: the subject as it is now, and how many admins remain active. */
export interface ActiveAdminLock {
  /** `undefined` when no such user exists. Callers turn that into {@link userNotFoundError}. */
  readonly subject: LockedUserState | undefined
  /** Active admins **as locked**, including the subject when they are one. */
  readonly activeAdminCount: number
}

/**
 * Lock the subject row and every active admin row, then report both.
 *
 * Must be called inside a transaction. Called on the pooled handle the locks are taken and
 * released by the same implicit transaction as the select, which makes the count advisory again —
 * see the module comment.
 *
 * @param writer - The surrounding transaction.
 * @param subjectUserId - The user about to be changed.
 */
export const lockUsersForRoleChange = async (
  writer: UserWriter,
  subjectUserId: string,
): Promise<ActiveAdminLock> => {
  const rows = await writer
    .select({ id: users.id, role: users.role, isActive: users.isActive })
    .from(users)
    .where(or(eq(users.id, subjectUserId), and(eq(users.role, 'admin'), eq(users.isActive, true))))
    .orderBy(users.id)
    .for('update')

  return {
    subject: rows.find((row) => row.id === subjectUserId),
    activeAdminCount: rows.filter((row) => row.role === 'admin' && row.isActive).length,
  }
}

/** Whether a user row counts towards the invariant. */
export const isActiveAdmin = (state: ProposedUserState): boolean =>
  state.role === 'admin' && state.isActive

/**
 * Whether applying `after` to `before` would remove the last active admin.
 *
 * Pure, and separated from the lock so the decision itself is testable without a database. It
 * covers self-demotion without a special case: an admin revoking or deactivating themselves is
 * simply the case where the subject is the last one counted (FR-173).
 */
export const wouldLeaveZeroActiveAdmins = (options: {
  readonly activeAdminCount: number
  readonly before: LockedUserState
  readonly after: ProposedUserState
}): boolean =>
  isActiveAdmin(options.before) && !isActiveAdmin(options.after) && options.activeAdminCount <= 1

/**
 * The refusal.
 *
 * `PRECONDITION_FAILED` rather than `FORBIDDEN`: the caller holds the admin role and is allowed to
 * perform this class of action — the platform's state is what makes this particular one
 * impossible. The message says why, because nothing here is about anyone's data and a refusal the
 * admin cannot explain is a support ticket (FR-173).
 */
export const lastActiveAdminError = (): TRPCError =>
  new TRPCError({
    code: 'PRECONDITION_FAILED',
    message:
      'Refused: this would leave the platform with no active admin, and nobody could then register a bundle, revoke a grant or restore an admin.',
  })

/**
 * A user who does not exist is **absent**, never forbidden (FR-190).
 *
 * Only admins reach these procedures and admins see every user, so there is no scope to leak here
 * — but the code is the same one every other out-of-scope read uses, so no resolver has to decide.
 */
export const userNotFoundError = (): TRPCError =>
  new TRPCError({ code: 'NOT_FOUND', message: 'User not found.' })

/** Throw {@link lastActiveAdminError} when the proposed change would break the invariant. */
export const assertActiveAdminRemains = (options: {
  readonly activeAdminCount: number
  readonly before: LockedUserState
  readonly after: ProposedUserState
}): void => {
  if (wouldLeaveZeroActiveAdmins(options)) {
    throw lastActiveAdminError()
  }
}
