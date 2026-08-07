import { createTRPCRouter, publicProcedure } from './procedures'

/**
 * The one unauthenticated procedure in the platform.
 *
 * It deliberately touches neither the database nor `ctx.scope`. A load balancer polls this every
 * few seconds; if the health check resolved the caller's scope it would run a
 * `profile_access_grants` query per poll for a caller that has no grants and reads no workflow —
 * which is the concrete cost the memoised resolver exists to avoid (FR-190, `scope.ts`).
 *
 * `checkedAt` is a `Date` rather than an ISO string on purpose: it is the cheapest live proof
 * that the `superjson` transformer is wired at both ends, because a plain-JSON transport would
 * hand the caller a string where the inferred type says `Date`.
 */
export const healthRouter = createTRPCRouter({
  check: publicProcedure.query(() => ({
    status: 'ok' as const,
    checkedAt: new Date(),
  })),
})
