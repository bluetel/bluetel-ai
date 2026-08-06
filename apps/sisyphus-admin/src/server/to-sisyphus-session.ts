import type { SisyphusSession } from '@bluetel-ai/sisyphus-api/server'

/**
 * The projection from Auth.js's session onto the contract's {@link SisyphusSession}.
 *
 * `sisyphus-api` deliberately does not know Auth.js exists: it declares what it needs — a
 * `resolveSession` returning this shape — and the host application supplies it. This module is the
 * panel's half of that, kept apart from `./resolve-session` so the projection is testable without
 * a request, a cookie jar, a validated environment or a database.
 */

/** What this module reads off an Auth.js session. Structural, so a test can build one. */
export interface AuthSessionLike {
  readonly user?: {
    readonly id?: unknown
    readonly email?: unknown
    readonly displayName?: unknown
    readonly role?: unknown
    readonly isActive?: unknown
  }
  /** Auth.js serialises the expiry as an ISO string, even for a database-backed session. */
  readonly expires?: unknown
}

/** The epoch, used for a session whose expiry could not be read. Already over, so nothing trusts it. */
const ALREADY_EXPIRED = 0

/**
 * Project an Auth.js session onto the contract's shape, or `null` when there is no usable one.
 *
 * **The fields are re-checked rather than cast.** The module augmentation in
 * `src/types/next-auth.d.ts` makes the compiler believe `session.user` is a `SisyphusSessionUser`,
 * but that belief rests on the `session` callback having run and having found a `users` row. A
 * half-populated session arriving at `adminProcedure` as a *typed* one is how a caller ends up
 * with `role: undefined` being compared against `'admin'`. A session that fails the check is
 * treated as absent, which is the safe direction — the caller is refused rather than admitted.
 *
 * @param session - Whatever `auth()` resolved, or `null`.
 * @returns The contract session, or `null` for an unauthenticated request.
 */
export const toSisyphusSession = (session: AuthSessionLike | null): SisyphusSession | null => {
  const user = session?.user
  if (user === undefined) return null

  const { id, email, displayName, role, isActive } = user
  if (typeof id !== 'string' || typeof email !== 'string' || typeof displayName !== 'string') {
    return null
  }
  if ((role !== 'admin' && role !== 'engineer') || typeof isActive !== 'boolean') {
    return null
  }

  const expires = new Date(typeof session?.expires === 'string' ? session.expires : '')

  return {
    // `isActive` is carried through rather than filtered on here. `authedProcedure` refuses an
    // inactive session *and records the denial* (FR-175); dropping the session to `null` here
    // would turn that recorded refusal into an ordinary "not signed in" and lose the event.
    user: { id, email, displayName, role, isActive },
    expiresAt: Number.isNaN(expires.getTime()) ? new Date(ALREADY_EXPIRED) : expires,
  }
}
