import { authErrorReason } from './error-reason'
import { safeRedirectTarget } from './redirect-target'
import { startGoogleSignIn } from './sign-in-action'
import { SignInPanel } from './sign-in-panel'

/**
 * `/sign-in` — the route the auth layer has always pointed at (T146, FR-195).
 *
 * `src/lib/auth/config.ts` sets **both** `pages.signIn` and `pages.error` to `/sign-in`. Until this
 * file existed, that meant every unauthenticated request and every authentication failure ended at
 * Next.js's 404 — the panel's front door returned "no such page". This is the missing route, not a
 * new feature.
 *
 * Both entry reasons land here and are told apart by the query string alone:
 *
 * - **A prompt.** Auth.js sends `?callbackUrl=` for the screen that was asked for while signed out.
 * - **An error return.** `@auth/core` sends `?error=<code>`, which `./error-reason.ts` turns into a
 *   readable cause. No parameter means no error, which is the ordinary case and must stay silent.
 *
 * Both parameters are untrusted — anyone can compose this URL — so each goes through its own total,
 * tested conversion before it reaches the markup. Neither is echoed.
 *
 * The page must render for someone with no session and no database row, so it resolves no session,
 * mounts no tRPC provider and reads no environment. Dynamic, because its output is a function of
 * the query string.
 */
export const dynamic = 'force-dynamic'

interface SignInPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>
}

const SignInPage = async ({ searchParams }: SignInPageProps) => {
  const params = await searchParams

  return (
    <SignInPanel
      action={startGoogleSignIn}
      redirectTo={safeRedirectTarget(params.callbackUrl)}
      reason={authErrorReason(params.error)}
    />
  )
}

export default SignInPage
