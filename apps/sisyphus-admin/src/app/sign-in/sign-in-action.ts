'use server'

import { signIn } from '@sisyphus-admin/lib/auth'

import { REDIRECT_TARGET_FIELD, safeRedirectTarget } from './redirect-target'

/**
 * Start the Google round trip (T146, FR-195).
 *
 * A **form action** rather than a link, because beginning a sign-in is a state change: Auth.js
 * mints and sets a CSRF token, a code verifier and a state cookie before it hands the browser to
 * Google, and a `GET` that did all that would be followed by a link prefetch. `signIn` never
 * returns — it throws the framework's redirect — so there is nothing here to render a result from.
 *
 * There is one provider, so it is named as a constant rather than chosen: `config.ts` registers
 * Google and nothing else, and a picker would be a control with one option on it.
 *
 * The destination comes off the submitted form rather than out of a closure, so the value this
 * action redirects to is the same value `./redirect-target.ts` cleared — see that module for why a
 * `callbackUrl` is a hostile input on this particular screen.
 */
export const startGoogleSignIn = async (form: FormData): Promise<void> => {
  await signIn('google', { redirectTo: safeRedirectTarget(form.get(REDIRECT_TARGET_FIELD)) })
}
