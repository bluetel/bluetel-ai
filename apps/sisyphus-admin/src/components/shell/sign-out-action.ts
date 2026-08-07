'use server'

import { signOut } from '@sisyphus-admin/lib/auth'
import { SIGN_IN_PATH } from '@sisyphus-admin/server'

/**
 * Ending the session, as a server action (T151, FR-194, SC-058).
 *
 * `signOut` is exported by `src/lib/auth/index.ts` and, until this module, was imported by nothing:
 * the panel could start a session and had no way to end one. It is a **server** function — it
 * deletes the database session row and clears the cookie — so the control that calls it is a form
 * posting to this action rather than an `onClick`. That is why the top bar's sign-out works with
 * JavaScript disabled, and why signing out is not something a client bundle can be persuaded to do
 * halfway.
 *
 * `redirectTo` is the sign-in screen and not `/`: the root route redirects a signed-out visitor to
 * sign-in anyway, so routing through it would be one extra round trip to reach the same place.
 */
export const signOutAction = async (): Promise<void> => {
  await signOut({ redirectTo: SIGN_IN_PATH })
}
