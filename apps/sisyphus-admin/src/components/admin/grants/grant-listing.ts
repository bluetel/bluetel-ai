import { formatTimestamp } from '@sisyphus-admin/components/admin/format-timestamp'
import type { RouterOutputs } from '@sisyphus-admin/trpc'

/**
 * Shaping a `admin.grants.listForProfile` row into what the access list renders (FR-179, FR-184).
 *
 * A grant is never deleted. Revoking writes `revoked_at`, so the same table is both the live access
 * list and the access **history** — which is why the row's state has to be derived rather than
 * assumed from its presence in the list. A revoked grant rendered as though it were live is the
 * one mistake this file exists to make impossible.
 */

/** One grant as `admin.grants.listForProfile` returns it. */
export type ProfileGrant = RouterOutputs['admin']['grants']['listForProfile']['items'][number]

/** What one row of the access list shows. */
export interface GrantReadouts {
  readonly id: string
  readonly userId: string
  readonly displayName: string
  readonly email: string
  /** `live` or `revoked`. Derived from `revokedAt`, never from the row being present. */
  readonly state: string
  readonly grantedAt: string
  /** `never` for a live grant — the same readout an absent timestamp gets everywhere else. */
  readonly revokedAt: string
}

/** Whether the grant is in force. The only definition, so no caller invents a second one. */
export const isLiveGrant = (grant: Pick<ProfileGrant, 'revokedAt'>): boolean =>
  grant.revokedAt === null

/**
 * Derive the readouts for one grant.
 *
 * @param grant - The row as the procedure returned it.
 */
export const toGrantReadouts = (grant: ProfileGrant): GrantReadouts => ({
  id: grant.id,
  userId: grant.userId,
  displayName: grant.displayName,
  email: grant.email,
  state: isLiveGrant(grant) ? 'live' : 'revoked',
  grantedAt: formatTimestamp(grant.grantedAt),
  revokedAt: formatTimestamp(grant.revokedAt),
})

/**
 * The user ids that currently hold access.
 *
 * Used to keep someone who already holds a live grant out of the issue form's picker: granting
 * twice is a duplicate request rather than an error — the server returns the existing grant with
 * `created: false` — but offering it invites an admin to think they changed something.
 */
export const liveGrantHolderIds = (grants: readonly ProfileGrant[]): ReadonlySet<string> =>
  new Set(grants.filter(isLiveGrant).map((grant) => grant.userId))
