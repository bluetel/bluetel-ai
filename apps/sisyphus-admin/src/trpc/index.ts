/**
 * The panel's tRPC client wiring — one of the three consumption modes of the single contract
 * (plan.md R4).
 *
 * Everything here talks to the router over HTTP with types only. The router **type**, the shared
 * input schemas and the `RouterInputs`/`RouterOutputs` helpers all come from
 * `@bluetel-ai/sisyphus-api/client`; nothing in this directory imports `./server` or `./db`, which
 * carry resolvers, Drizzle and the `postgres` driver and are not safe in a browser bundle.
 *
 * **Typing API-derived values.** Use `RouterOutputs['workflow']['byId']`, never a hand-written DTO
 * that happens to match it today. A mirrored type is duplication the qlty gate flags, and it drifts
 * silently — nothing fails when the procedure changes and the copy does not.
 *
 * Consumers import this barrel, never a module inside it.
 */

export { api } from './api'
export { resolveBaseUrl, resolveTrpcUrl } from './base-url'
export { HydrateClient } from './hydration'
export { TRPCReactProvider } from './provider'
export { createQueryClient, DEFAULT_STALE_TIME_MS, getQueryClient } from './query-client'

export type { RouterInputs, RouterOutputs } from '@bluetel-ai/sisyphus-api/client'
