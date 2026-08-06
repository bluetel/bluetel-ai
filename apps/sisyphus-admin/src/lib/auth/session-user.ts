import type { UserRole } from '@bluetel-ai/sisyphus-api/client'
import type { User } from '@bluetel-ai/sisyphus-api/db'

/**
 * The platform's own view of the signed-in user, projected from the database row that the
 * **database-backed** session resolves on every request.
 *
 * That "on every request" is the whole reason the session strategy is `database` rather than
 * `jwt`: role and activation are re-read from `users` each time, so a deactivation takes effect at
 * the next request (FR-175). With a JWT session nothing would consult the database between
 * sign-in and token expiry, and a user who had been deactivated would keep working — with their
 * old role — until their token happened to run out. That is the bug this choice exists to
 * prevent, not a performance trade-off.
 */
export interface SisyphusSessionUser {
  readonly id: string
  readonly email: string
  /** What the panel renders. Falls back to the address when neither name column is populated. */
  readonly displayName: string
  readonly role: UserRole
  /** Deactivation is never deletion (FR-176), so an inactive user still has a row and a session. */
  readonly isActive: boolean
}

/** The columns of `users` this projection reads. Narrower than `User` so tests can build one. */
export type SessionUserRow = Pick<
  User,
  'id' | 'email' | 'displayName' | 'name' | 'role' | 'isActive'
>

/**
 * Project a `users` row onto the session.
 *
 * `display_name` wins over the adapter's `name` column: `name` is whatever Google last returned
 * and changes when someone edits their Workspace profile, while `display_name` is the name a year
 * of run history and notifications is attached to.
 */
export const toSessionUser = (row: SessionUserRow): SisyphusSessionUser => ({
  id: row.id,
  email: row.email,
  displayName: firstNonEmpty(row.displayName, row.name) ?? row.email,
  role: row.role,
  isActive: row.isActive,
})

const firstNonEmpty = (...values: readonly (string | null)[]): string | undefined =>
  values.find((value): value is string => typeof value === 'string' && value.trim() !== '')

/**
 * Whether a resolved session may act.
 *
 * This is the request-time half of FR-175, and it is where a deactivated user is turned away: the
 * `signIn` callback stops them acquiring a *new* session, and this stops the session they already
 * hold from being honoured on the very next request. Both halves are needed — refusing only at
 * sign-in would leave an existing session live for its full lifetime.
 */
export const isActiveSessionUser = (
  user: SisyphusSessionUser | undefined,
): user is SisyphusSessionUser => user?.isActive === true

/** `true` when the caller holds an active session with the `admin` role (FR-169). */
export const isAdminSessionUser = (user: SisyphusSessionUser | undefined): boolean =>
  isActiveSessionUser(user) && user.role === 'admin'
