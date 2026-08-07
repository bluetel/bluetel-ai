'use client'

import type { AppRouter } from '@bluetel-ai/sisyphus-api/client'
import { createTRPCReact } from '@trpc/react-query'

/**
 * The panel's typed hooks — one of the three consumption modes of the single contract (plan.md R4).
 *
 * The router arrives as a **type** from `@bluetel-ai/sisyphus-api/client`, the browser-safe subpath.
 * `./server` and `./db` carry Drizzle and the `postgres` driver and must never be reached from a
 * client component; the package deliberately publishes no root `.` export so that boundary is a
 * build-time fact rather than a review convention.
 *
 * `'use client'` is required rather than stylistic: `createTRPCReact` builds a React context at
 * module scope, which a server component cannot evaluate.
 */
export const api = createTRPCReact<AppRouter>()
