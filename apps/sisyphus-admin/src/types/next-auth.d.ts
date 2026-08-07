import type { SisyphusSessionUser } from '@sisyphus-admin/lib/auth'

/**
 * Widen the Auth.js `Session` to carry the platform's own user facts.
 *
 * Without this every consumer — the tRPC context, `adminProcedure`, a server component asking
 * "may this person see the configuration screens" — would have to cast the session to reach `role`
 * and `isActive`, and a cast is exactly the place a stale JWT-shaped assumption survives a
 * refactor. Declaring the shape once makes the FR-175 fields part of the type the whole app sees.
 */
declare module 'next-auth' {
  interface Session {
    user: SisyphusSessionUser & {
      name?: string | null
      email?: string | null
      image?: string | null
    }
  }
}
