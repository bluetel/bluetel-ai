import { users } from '@bluetel-ai/sisyphus-api/db'
import { env } from '@sisyphus-admin/env'
import { eq } from 'drizzle-orm'
import type { NextAuthConfig } from 'next-auth'
import Google from 'next-auth/providers/google'

import { createSisyphusAdapter } from './adapter'
import { attachSessionUser, createSignInCallback } from './callbacks'
import { getAuthDatabase } from './database'
import { createEngineerOnFirstSignIn, mapGoogleProfile } from './on-sign-in'
import type { SessionUserRow } from './session-user'
import type { ExistingUserFacts } from './sign-in-decision'

/**
 * Auth.js configuration for the panel — Google Workspace sign-in, verified server-side.
 *
 * ## Why the session strategy is `database` and not `jwt`
 *
 * A JWT session is self-contained: once issued, nothing reads the database again until it expires.
 * A user deactivated at 09:00 would keep working, with whatever role their token was minted with,
 * until that token ran out. FR-175 requires the opposite — a role or activation change takes
 * effect at the **next request** — so the session row is looked up on every request and the
 * `users` row it points at is re-read with it. That is the bug this choice exists to prevent, and
 * it is worth one indexed primary-key lookup per request.
 *
 * ## Where the `hd` claim is verified
 *
 * `profile` in the `signIn` callback is the ID token payload Auth.js fetched from Google's token
 * endpoint over a server-to-server call and verified before invoking any callback. Nothing on that
 * path is client-supplied. The `hd` claim in it — not the email suffix, which anyone can produce
 * on a personal account — is compared with `SISYPHUS_PERMITTED_EMAIL_DOMAINS`; the comparison
 * itself is in `./permitted-domains.ts` and the gate around it in `./callbacks.ts`.
 *
 * This module is wiring only. Everything that can be got wrong is in a module beside it with a
 * colocated test.
 */

/** Only what the panel needs from Google: identity, not calendar or drive. */
const GOOGLE_SCOPE = 'openid email profile'

const findExistingUser = async (email: string): Promise<ExistingUserFacts | undefined> => {
  const rows = await getAuthDatabase()
    .select({ isActive: users.isActive })
    .from(users)
    // `email` is `citext`, so this comparison is case-insensitive at the database rather than by
    // lower-casing here — an address that differs only in case is the same address (R13).
    .where(eq(users.email, email))
    .limit(1)

  return rows[0]
}

/**
 * Build the configuration.
 *
 * A **function**, not a module-level constant, because everything below reads validated
 * environment and opens a database pool. Next.js imports every route module during
 * `next build`'s page-data collection, so a constant here means the build itself needs
 * `DATABASE_URL` and the OAuth secrets — it fails in CI, and it fails in any checkout without a
 * database, for a route nobody is calling. Auth.js v5 accepts a config factory precisely so this
 * work happens on the first request instead. See `./index.ts` for where it is invoked.
 */
export const createAuthConfig = (): NextAuthConfig => ({
  // The panel runs behind CloudFront/Lambda (OpenNext), which does not present a single fixed
  // origin to Auth.js the way a traditional server would. Without this, Auth.js compares the
  // request's `Host` header against its own guess of the origin and refuses anything it does not
  // recognise — `UntrustedHost` — even for the panel's real domain. `AUTH_URL`/`SISYPHUS_PANEL_URL`
  // still pin the canonical origin used for callback URLs; this only stops the host check from
  // rejecting legitimate requests.
  trustHost: true,
  adapter: createSisyphusAdapter({
    db: getAuthDatabase(),
    // T037: a first-time signer-in is created as `engineer` (FR-170). The override exists because
    // the stock `createUser` cannot populate `google_subject`/`display_name`, both `not null`.
    createUser: createEngineerOnFirstSignIn({
      db: getAuthDatabase(),
      permittedDomains: env.SISYPHUS_PERMITTED_EMAIL_DOMAINS,
    }),
  }),
  // Database-backed, not JWT: deactivation takes effect at the next request rather than at next
  // sign-in (FR-175). See the module comment above — this one line is the whole guarantee.
  session: { strategy: 'database' },
  providers: [
    Google({
      clientId: env.AUTH_GOOGLE_ID,
      clientSecret: env.AUTH_GOOGLE_SECRET,
      // Auth.js replaces the provider's `sub` with a random id before calling `createUser`, so
      // without this mapping the verified subject never reaches the adapter and the insert has
      // nothing to put in `google_subject`.
      profile: mapGoogleProfile,
      authorization: {
        params: {
          scope: GOOGLE_SCOPE,
          // A hint that pre-fills Google's account chooser. Google may ignore it and a caller may
          // rewrite it, which is exactly why the returned `hd` claim is still verified server-side.
          hd: env.SISYPHUS_PERMITTED_EMAIL_DOMAINS[0],
        },
      },
    }),
  ],
  callbacks: {
    signIn: createSignInCallback({
      permittedDomains: env.SISYPHUS_PERMITTED_EMAIL_DOMAINS,
      findExistingUser,
      warn: (message) => {
        console.warn(message)
      },
    }),
    session: ({ session, user }) =>
      // `user` is the `users` row this request's session token resolved to.
      attachSessionUser({ session, user: user as unknown as SessionUserRow }),
  },
  pages: {
    // One provider, so the stock provider-picker page has nothing to pick.
    signIn: '/sign-in',
    error: '/sign-in',
  },
})
