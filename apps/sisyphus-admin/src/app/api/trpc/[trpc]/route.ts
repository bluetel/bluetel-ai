import { SISYPHUS_TRPC_ENDPOINT } from '@bluetel-ai/sisyphus-api/client'
import { appRouter, createTRPCContext } from '@bluetel-ai/sisyphus-api/server'
import { env } from '@sisyphus-admin/env'
import { createSisyphusDependencies } from '@sisyphus-admin/server'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'

/**
 * The interactive tRPC surface — `appRouter` over HTTP (api-surface.md → Route handlers).
 *
 * ## What the context is built from
 *
 * `createTRPCContext` is the setup factory's own context creator, and the additional-context hook
 * it was created with is `createSisyphusAdditionalContext` — so mounting through it is what puts
 * the session, the lazy scope resolver and the lazy credential resolver on `ctx`. Calling
 * `createSisyphusAdditionalContext` directly instead would produce those three values and lose
 * `headers` and `dependencies`, which is what `adminProcedure` records a denial through.
 *
 * The four dependencies come from `createSisyphusDependencies()`, called **per request**: the
 * database handle is memoised inside `sisyphus-api`, `resolveSession` is Auth.js's `auth()`, and
 * the machine-credential resolver answers `null` because `appRouter` contains no machine procedure
 * to authorise (FR-005). Nothing is evaluated at module scope, which matters because `next build`
 * imports every route module while collecting page data — a pool opened or a secret read up here
 * would make the build itself need a database.
 *
 * ## The machine surface is not here
 *
 * `/api/machine` mounts `machineRouter` with its own credential verifier and lands with the
 * executor protocol work. Two mounts rather than two branches of one is what makes "an executor
 * credential grants nothing on the interactive surface" structural rather than a check.
 */
const handler = (request: Request): Promise<Response> =>
  fetchRequestHandler({
    endpoint: SISYPHUS_TRPC_ENDPOINT,
    req: request,
    router: appRouter,
    createContext: ({ req }) =>
      createTRPCContext({ headers: req.headers, dependencies: createSisyphusDependencies() }),
    /**
     * Gated on the validated environment rather than on `process.env` directly, and off outside
     * development. The gate is load-bearing on the machine surface — an unconditional `onError`
     * writes executor-reported content into platform logs, outside the FR-045 sanitisation the
     * executor applies on its own side — and the interactive mount keeps the same rule so the two
     * handlers cannot drift into disagreeing about it.
     */
    onError:
      env.NEXT_PUBLIC_NODE_ENV === 'development'
        ? ({ path, error }) => {
            console.error(`sisyphus.trpc path=${path ?? '<none>'} code=${error.code}`)
          }
        : undefined,
  })

export { handler as GET, handler as POST }
