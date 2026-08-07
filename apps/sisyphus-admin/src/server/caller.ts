import { createCaller, createTRPCContext } from '@bluetel-ai/sisyphus-api/server'
import { headers } from 'next/headers'

import { createSisyphusDependencies } from './dependencies'

/**
 * The interactive surface, called in-process from a server component (plan.md R4, mode 2).
 *
 * ## Why a page ever calls a procedure instead of the database
 *
 * A server component that reaches `getAuthDatabase()` and writes its own `select` is a second
 * implementation of a read the API already owns — with its own opinion about what the caller may
 * see. `/settings/notifications` used to do exactly that for the one column no procedure exposed,
 * and the module that did it carried a comment saying to delete it when one existed.
 * `workflow.notificationSettings` is that procedure, and this is how a page reaches it.
 *
 * The call is **not** a privileged back door: it goes through `createTRPCContext` and therefore
 * through the same session resolution, the same `authedProcedure` gate and the same scope resolver
 * an HTTP request would. What it skips is the network hop and the serialisation, not a check.
 *
 * ## Why the context is a function
 *
 * `createCaller` accepts a context or a factory for one, and the factory is what keeps `headers()`
 * and `createSisyphusDependencies()` out of module evaluation. `next build` imports every page
 * module while collecting page data; a context built at module scope would open a database pool and
 * read the request store at build time, and `headers()` throws outside a request.
 *
 * Per-call rather than memoised, for the same reason `createSisyphusDependencies` is: the database
 * handle behind it is memoised inside `sisyphus-api`, so what is rebuilt each time is three
 * function references.
 */
export const createServerCaller = () =>
  createCaller(async () =>
    createTRPCContext({ headers: await headers(), dependencies: createSisyphusDependencies() }),
  )
