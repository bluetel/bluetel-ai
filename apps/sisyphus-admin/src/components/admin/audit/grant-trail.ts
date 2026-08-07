import { formatTimestamp } from '@sisyphus-admin/components/admin/format-timestamp'
import { isLiveGrant } from '@sisyphus-admin/components/admin/grants/grant-listing'
import type { RouterOutputs } from '@sisyphus-admin/trpc'

/**
 * Shaping one row of a user's access history (FR-183, FR-184, SC-053).
 *
 * ## Why this is a second shaping module and not a duplicate
 *
 * `components/admin/grants/grant-listing.ts` shapes `admin.grants.listForProfile` — the same table
 * read from the profile's side, so its rows name the *user* who holds each grant. This shapes
 * `admin.grants.listForUser`, whose rows name the *profile* each grant covers. Two different
 * questions, two different row shapes; what they share — what makes a grant live — is imported from
 * there rather than restated, because a revoked grant rendered as though it were live is the one
 * mistake either module exists to make impossible.
 *
 * ## A grant is never deleted, which is what makes this an audit
 *
 * Revoking writes `revoked_at` (FR-184), so this list is simultaneously the live access set and its
 * whole history. That is why `includeRevoked` is on for this view and off for the access screen:
 * one is asking who can see what, and this one is asking what happened.
 *
 * SC-053 wants every grant and revocation attributable to an acting admin with a timestamp. The
 * procedure returns those actors as ids rather than names — it joins the profile, not the two
 * users — so the ids are shown as ids rather than dressed up as something they are not.
 */

/** One grant as `admin.grants.listForUser` returns it. */
export type UserGrant = RouterOutputs['admin']['grants']['listForUser']['items'][number]

/** What one row of the access history shows. */
export interface GrantTrailReadouts {
  readonly id: string
  readonly profile: string
  /** `live` or `revoked`. Derived from `revokedAt`, never from the row being present. */
  readonly state: string
  readonly grantedAt: string
  /** Always present: a grant cannot exist without the record of who issued it (SC-053). */
  readonly grantedBy: string
  /** `never` for a live grant — the same readout an absent timestamp gets everywhere else. */
  readonly revokedAt: string
  readonly revokedBy: string
}

/**
 * What the revoking actor reads as when there has been no revocation.
 *
 * An em dash, so the column keeps its shape. Not reachable for the granting actor: `granted_by` is
 * not null, because a grant cannot exist without the record of who issued it (SC-053).
 */
export const NO_ACTOR = '—'

/**
 * Derive the readouts for one grant.
 *
 * @param grant - The row as the procedure returned it.
 */
export const toGrantTrailReadouts = (grant: UserGrant): GrantTrailReadouts => ({
  id: grant.id,
  profile: grant.profileName,
  state: isLiveGrant(grant) ? 'live' : 'revoked',
  grantedAt: formatTimestamp(grant.grantedAt),
  grantedBy: grant.grantedByUserId,
  revokedAt: formatTimestamp(grant.revokedAt),
  revokedBy: grant.revokedByUserId ?? NO_ACTOR,
})
