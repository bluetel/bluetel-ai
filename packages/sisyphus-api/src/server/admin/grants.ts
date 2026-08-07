import { TRPCError } from '@trpc/server'

import type { ProfileAccessGrant } from '../../db'
import {
  grantProfileAccessInput,
  listGrantsForProfileInput,
  listGrantsForUserInput,
  revokeProfileAccessInput,
} from '../../schemas'
import { adminProcedure, createTRPCRouter } from '../procedures'

import { recordConfigurationChange } from './audit-log'
import type { GrantPage, ProfileGrantRow, UserGrantRow } from './grant-store'
import {
  executionProfileExists,
  findLiveGrant,
  insertGrant,
  listGrantsForProfile,
  listGrantsForUser,
  markGrantRevoked,
  readUserRole,
  removeWatchesLeftBehind,
} from './grant-store'

/**
 * `admin.grants` — issuing and revoking access to an execution profile (FR-179, FR-184, FR-188).
 *
 * The execution profile is the unit of access control, so this sub-router is the only writer of
 * the table every scoped read composes its `where` from. Three properties are load-bearing:
 *
 * 1. **Revocation writes `revoked_at`; nothing here deletes.** The trail survives (FR-184), and the
 *    partial unique index means a revoked user can be granted again without a duplicate-key
 *    failure — re-granting is an ordinary operation, not a repair.
 * 2. **Revoking removes what the grant was keeping alive (FR-188).** A workflow watch held purely
 *    on the strength of a grant would otherwise keep delivering to someone who can no longer see
 *    the run, which is precisely the failure the requirement names. Watches on workflows the user
 *    owns or initiated are kept, because those never depended on the grant (FR-189).
 * 3. **A target that does not exist is `NOT_FOUND`, never `FORBIDDEN` (FR-190).** `FORBIDDEN`
 *    answers "does this profile exist?" with yes. Every miss here — unknown user, unknown profile,
 *    no live grant — produces the *same* error with the *same* message, so the three cases cannot
 *    be told apart and the router cannot be used to enumerate ids.
 *
 * Every procedure is an `adminProcedure`: granting access is configuration, and all configuration
 * is admin-only (FR-169). The `FORBIDDEN` a non-admin gets from that middleware is not in tension
 * with rule 3 — it answers "may you administer?", not "does this profile exist?".
 */

/**
 * The one refusal this router produces for a target it cannot act on.
 *
 * Deliberately singular. An unknown user, an unknown profile and a pair with no live grant are
 * three different situations and they must be indistinguishable to the caller, because a router
 * that distinguished them would be an oracle for enumerating user and profile ids (FR-190). The
 * message names no id.
 */
export const grantTargetNotFoundError = (): TRPCError =>
  new TRPCError({ code: 'NOT_FOUND', message: 'No such user, execution profile or grant.' })

/** What `grants.grant` answers with. */
export interface GrantIssued {
  readonly grant: ProfileAccessGrant
  /**
   * `false` when a live grant already existed and was returned unchanged. Granting twice is a
   * duplicate request rather than an error — an admin double-clicking a button has not done
   * anything wrong — so the second call writes neither a row nor an audit entry.
   */
  readonly created: boolean
}

/** What `grants.revoke` answers with. */
export interface GrantRevoked {
  readonly grant: ProfileAccessGrant
  /** Watches the grant was keeping alive, now removed (FR-188). */
  readonly watchesRemoved: number
}

export const adminGrantsRouter = createTRPCRouter({
  /** Who holds access to a profile. `includeRevoked` turns the list into an access history. */
  listForProfile: adminProcedure
    .input(listGrantsForProfileInput)
    .query(async ({ ctx, input }): Promise<GrantPage<ProfileGrantRow>> => {
      if (!(await executionProfileExists(ctx.db, input.executionProfileId))) {
        throw grantTargetNotFoundError()
      }

      return listGrantsForProfile(ctx.db, {
        executionProfileId: input.executionProfileId,
        includeRevoked: input.includeRevoked,
        limit: input.limit,
        cursor: input.cursor,
      })
    }),

  /** What one user holds — the same table read from the other side. */
  listForUser: adminProcedure
    .input(listGrantsForUserInput)
    .query(async ({ ctx, input }): Promise<GrantPage<UserGrantRow>> => {
      if ((await readUserRole(ctx.db, input.userId)) === undefined) {
        throw grantTargetNotFoundError()
      }

      return listGrantsForUser(ctx.db, {
        userId: input.userId,
        includeRevoked: input.includeRevoked,
        limit: input.limit,
        cursor: input.cursor,
      })
    }),

  /**
   * Grant a user access to an execution profile (FR-179, FR-184).
   *
   * The existence checks, the insert and the audit row are one transaction, so a grant can never
   * exist without the record of who issued it.
   */
  grant: adminProcedure.input(grantProfileAccessInput).mutation(
    async ({ ctx, input }): Promise<GrantIssued> =>
      ctx.db.transaction(async (tx) => {
        const role = await readUserRole(tx, input.userId)
        if (role === undefined || !(await executionProfileExists(tx, input.executionProfileId))) {
          throw grantTargetNotFoundError()
        }

        const existing = await findLiveGrant(tx, input)
        if (existing !== undefined) {
          return { grant: existing, created: false }
        }

        const grant = await insertGrant(tx, {
          userId: input.userId,
          executionProfileId: input.executionProfileId,
          grantedByUserId: ctx.user.id,
        })

        await recordConfigurationChange(tx, {
          actorUserId: ctx.user.id,
          entityType: 'profile_access_grant',
          entityId: grant.id,
          action: 'granted',
          detail: {
            userId: input.userId,
            executionProfileId: input.executionProfileId,
          },
        })

        return { grant, created: true }
      }),
  ),

  /**
   * Revoke a user's access to an execution profile (FR-184, FR-188).
   *
   * Takes effect for new launches at the caller's next request, because the scope resolver reads
   * live grants per request rather than caching them. Workflows already in flight that the user
   * owns or initiated are untouched, and so is their historical attribution — this writes one
   * timestamp and removes the watches that had no other basis.
   */
  revoke: adminProcedure.input(revokeProfileAccessInput).mutation(
    async ({ ctx, input }): Promise<GrantRevoked> =>
      ctx.db.transaction(async (tx) => {
        const role = await readUserRole(tx, input.userId)
        if (role === undefined) {
          throw grantTargetNotFoundError()
        }

        const live = await findLiveGrant(tx, input)
        if (live === undefined) {
          // Also the answer when the profile does not exist at all: there is no live grant either
          // way, and the two must not be distinguishable (FR-190).
          throw grantTargetNotFoundError()
        }

        const grant = await markGrantRevoked(tx, {
          grantId: live.id,
          revokedByUserId: ctx.user.id,
          revokedAt: new Date(),
        })

        // An admin sees every workflow without holding a grant (FR-183), so their watches were
        // never resting on this grant and removing them would break a subscription that is still
        // legitimate.
        const watchesRemoved =
          role === 'admin'
            ? 0
            : await removeWatchesLeftBehind(tx, {
                userId: input.userId,
                executionProfileId: input.executionProfileId,
              })

        await recordConfigurationChange(tx, {
          actorUserId: ctx.user.id,
          entityType: 'profile_access_grant',
          entityId: grant.id,
          action: 'revoked',
          detail: {
            userId: input.userId,
            executionProfileId: input.executionProfileId,
            watchesRemoved,
          },
        })

        return { grant, watchesRemoved }
      }),
  ),
})

export type AdminGrantsRouter = typeof adminGrantsRouter
