import { SISYPHUS_MACHINE_ENDPOINT } from '@bluetel-ai/sisyphus-api/client'
import { createTRPCContext, machineRouter } from '@bluetel-ai/sisyphus-api/server'
import { env } from '@sisyphus-admin/env'
import { createMachineDependencies } from '@sisyphus-admin/server'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'

/**
 * The machine tRPC surface — `machineRouter` over HTTP (api-surface.md → Route handlers, FR-005,
 * FR-037).
 *
 * ## Two surfaces, two mounts
 *
 * This is a **separate route module** from `/api/trpc`, mounting a **separate router** built from
 * separate dependencies. That is what makes "an executor credential grants nothing on the
 * interactive surface" a structural fact rather than a check somebody could forget: the
 * interactive procedures are not reachable from this path at all, and `createMachineDependencies`
 * resolves no session, so a panel cookie arriving here authenticates nobody. Conversely
 * `/api/trpc` supplies `resolveNoMachineCredential`, so an executor token presented there is never
 * inspected.
 *
 * A single mount branching on the presented credential would have both surfaces one `if` away from
 * each other, and the failure mode of getting that `if` wrong is silent privilege confusion.
 *
 * ## Nothing is evaluated at module scope
 *
 * `next build` imports every route module while collecting page data, so the database handle and
 * `SISYPHUS_MACHINE_CREDENTIAL_SECRET` are both reached **inside** `createMachineDependencies()`,
 * per request. A constant here would make the build itself need a database and a signing secret.
 *
 * ## `onError` stays off outside development, and here it matters most
 *
 * The machine surface carries executor-reported content. An unconditional `onError` would write
 * that content into platform logs, outside the FR-045 sanitisation the executor applies on its own
 * side, and the sanitisation is the reason an unredacted copy is supposed never to exist. Only the
 * procedure path and the tRPC code are ever printed, and only in development.
 */
const handler = (request: Request): Promise<Response> =>
  fetchRequestHandler({
    endpoint: SISYPHUS_MACHINE_ENDPOINT,
    req: request,
    router: machineRouter,
    createContext: ({ req }) =>
      createTRPCContext({ headers: req.headers, dependencies: createMachineDependencies() }),
    onError:
      env.NEXT_PUBLIC_NODE_ENV === 'development'
        ? ({ path, error }) => {
            console.error(`sisyphus.machine path=${path ?? '<none>'} code=${error.code}`)
          }
        : undefined,
  })

export { handler as GET, handler as POST }
