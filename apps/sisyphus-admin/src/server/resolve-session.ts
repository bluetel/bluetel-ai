import type { SisyphusSession } from '@bluetel-ai/sisyphus-api/server'
import { auth } from '@sisyphus-admin/lib/auth'

import { toSisyphusSession } from './to-sisyphus-session'

/**
 * The `resolveSession` the tRPC context is built with.
 *
 * **It takes no `headers` argument, and that is deliberate.** The contract's signature is
 * `(headers: Headers) => Promise<SisyphusSession | null>` because a host that authenticates from a
 * bearer token needs them; Auth.js does not. `auth()` reads the session cookie from Next.js's
 * per-request store and re-reads the `users` row behind it — which is the whole of FR-175, since a
 * role change or a deactivation lands on the very next request rather than at next sign-in.
 * Accepting a `Headers` object here and ignoring it would suggest it was consulted. A
 * zero-argument function is assignable to the one-argument type, so nothing is lost.
 */
export const resolveSisyphusSession = async (): Promise<SisyphusSession | null> =>
  toSisyphusSession(await auth())
