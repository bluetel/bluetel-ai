import { initTRPC } from '@trpc/server'
import superjson from 'superjson'
import { ZodError } from 'zod'

/**
 * The tRPC setup factory — one definition, three consumption modes (plan.md R4).
 *
 * The panel mounts the router through `fetchRequestHandler`, the control plane calls the same
 * resolvers in-process through `createCallerFactory`, and the executor imports only the router
 * *type*. All three take their context from {@link createTRPCSetup}, so there is exactly one place
 * where a caller's identity and access scope are established.
 */

/**
 * What a caller hands in to build a request context.
 *
 * `dependencies` is how the database handle, the session resolver and the credential resolver
 * reach the context **without this package importing the app's environment**. The alternative — a
 * module-level singleton captured at import time — would make the package unusable from the
 * control plane and untestable without a live database.
 */
export interface TRPCContextOptions<TDependencies> {
  readonly headers: Headers
  readonly dependencies: TDependencies
}

/**
 * Flattened Zod issues, attached to `data.zodError` on every `BAD_REQUEST` raised by `.input()`.
 *
 * The panel renders validation failures field by field (FR-008), which needs the field names the
 * server validated — the same names, because the schema is shared (see `src/schemas/`).
 */
export type FlattenedZodError = ReturnType<ZodError['flatten']>

/**
 * Build a tRPC instance, its context creator, its router builder and its caller factory.
 *
 * **`createAdditionalContext` is async, and that is a requirement rather than a style choice.**
 * A synchronous hook cannot await the session lookup or the profile-grant query. Anything it
 * cannot await has to be re-derived inside each resolver instead — which is precisely the
 * per-resolver duplication FR-190 cannot survive: the scoping predicate would be rewritten by
 * hand in every workflow query, and the one that forgets it leaks silently rather than failing.
 * Both `fetchRequestHandler` and `createCallerFactory` accept a promise-returning context
 * creator, so async costs nothing structurally.
 *
 * @param config - Supplies the async hook that extends the base `{ headers, dependencies }`
 *   context with request-scoped values.
 * @returns The tRPC instance plus the four things routers and route handlers need from it.
 *
 * @example
 * ```ts
 * const { createTRPCRouter, publicProcedure } = createTRPCSetup<Extra, Deps>({
 *   createAdditionalContext: async ({ headers, dependencies }) => ({
 *     session: await dependencies.resolveSession(headers),
 *   }),
 * })
 * ```
 */
export const createTRPCSetup = <TAdditionalContext extends object, TDependencies>(config: {
  readonly createAdditionalContext: (
    options: TRPCContextOptions<TDependencies>,
  ) => Promise<TAdditionalContext>
}) => {
  const createTRPCContext = async (
    options: TRPCContextOptions<TDependencies>,
  ): Promise<TRPCContextOptions<TDependencies> & TAdditionalContext> => {
    const additional = await config.createAdditionalContext(options)
    return { ...options, ...additional }
  }

  const t = initTRPC.context<Awaited<ReturnType<typeof createTRPCContext>>>().create({
    /**
     * `superjson` so `Date` survives the wire in both directions. Timestamps are `timestamptz`
     * and money is `numeric` rendered as a string; a JSON-only transformer would hand the panel
     * an ISO string where the type says `Date`, and the mismatch would only show up at run time.
     */
    transformer: superjson,
    errorFormatter: ({ shape, error }) => ({
      ...shape,
      data: {
        ...shape.data,
        zodError: error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    }),
  })

  return {
    /** The tRPC instance, for middleware and for anything the four helpers below do not cover. */
    t,
    /** Builds the per-request context. Async — see the note on this function. */
    createTRPCContext,
    /** In-process calls with no network hop, used by the control plane (R4). */
    createCallerFactory: t.createCallerFactory,
    /** Router and sub-router builder. */
    createTRPCRouter: t.router,
    /** Unauthenticated procedure. Health check only — everything else builds on it. */
    publicProcedure: t.procedure,
  }
}
