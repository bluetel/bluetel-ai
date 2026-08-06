import {
  listRoleChangesInput,
  listUsersInput,
  setUserActiveInput,
  setUserRoleInput,
} from '../../schemas'
import { adminProcedure, createTRPCRouter } from '../procedures'

import { setUserActive, setUserRole } from './user-changes'
import { listRoleChanges, listUsers } from './user-queries'

/**
 * `admin.users` — the user management surface (FR-171..FR-173, FR-175..FR-177).
 *
 * Every procedure is an `adminProcedure`: managing users is configuration, and all configuration
 * is admin-only (FR-169). A non-admin's attempt is refused and recorded by the middleware, so
 * nothing in this file re-checks the role.
 *
 * This module is wiring. The invariant lives in `./active-admins.ts`, the writes in
 * `./user-changes.ts` and the reads in `./user-queries.ts` — each with its own test — so that the
 * one rule that must not be got wrong is not buried in a router definition.
 *
 * **The two mutations run inside `db.transaction`, and the invariant is checked in there.** That
 * is the whole of FR-173: a check performed before opening the transaction is the race the
 * requirement exists to forbid, because two concurrent demotions would both pass it. The default
 * `read committed` isolation is sufficient *because* the count is taken with `select … for
 * update`; see the module comment in `./active-admins.ts` for why the locking read is what makes
 * the loser re-read rather than merely wait.
 */
export const usersRouter = createTRPCRouter({
  /** Every known user with their role, active state, last sign-in and owned runs (FR-171). */
  list: adminProcedure
    .input(listUsersInput)
    .query(({ ctx, input }) => listUsers({ db: ctx.db, input })),

  /** Grant or revoke the admin role (FR-172), refusing the last active admin (FR-173). */
  setRole: adminProcedure.input(setUserRoleInput).mutation(({ ctx, input }) =>
    ctx.db.transaction((writer) =>
      setUserRole({
        writer,
        actorUserId: ctx.user.id,
        userId: input.userId,
        role: input.role,
        reason: input.reason,
      }),
    ),
  ),

  /** Deactivate or reactivate (FR-172, FR-175), never delete (FR-176). */
  setActive: adminProcedure.input(setUserActiveInput).mutation(({ ctx, input }) =>
    ctx.db.transaction((writer) =>
      setUserActive({
        writer,
        actorUserId: ctx.user.id,
        userId: input.userId,
        isActive: input.isActive,
        reason: input.reason,
      }),
    ),
  ),

  /** The append-only role and activation history (FR-177). Readable, never editable. */
  roleChanges: adminProcedure
    .input(listRoleChangesInput)
    .query(({ ctx, input }) => listRoleChanges({ db: ctx.db, input })),
})

export type UsersRouter = typeof usersRouter
