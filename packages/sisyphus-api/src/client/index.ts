import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server'

import type { AppRouter, MachineRouter } from '../server/root'

/**
 * Browser-safe entry point — `@bluetel-ai/sisyphus-api/client`.
 *
 * Carries the `AppRouter` type, `RouterInputs`/`RouterOutputs`, the shared input schemas and the
 * enums. No resolver and no database driver is reachable from here, which is what lets the executor
 * import the router as a type only (FR-005).
 *
 * The one import that reaches into `../server` is an `import type` and must stay one. A type import
 * is erased at compile time, so it creates no module edge a bundler could follow — which is exactly
 * the mechanism the executor's hard boundary relies on. **Never make it a value import**: a single
 * `import { appRouter }` here would put `postgres`, Drizzle and every resolver one hop from a panel
 * client component, and removing the root barrel from the exports map would stop meaning anything.
 */

/**
 * Mount path of the interactive tRPC surface (api-surface.md → Interactive surface).
 *
 * Exported from the client subpath because both sides need the same value: the admin app's route
 * handler is mounted at this path and the panel's `httpBatchLink` points at it. Sharing the
 * constant is what stops the two from drifting.
 */
export const SISYPHUS_TRPC_ENDPOINT = '/api/trpc'

export type SisyphusTrpcEndpoint = typeof SISYPHUS_TRPC_ENDPOINT

/**
 * Mount path of the machine surface — executor report-back, authorised by a workflow-scoped
 * credential. Separate from the interactive surface because an executor credential grants nothing
 * there (FR-005).
 */
export const SISYPHUS_MACHINE_ENDPOINT = '/api/machine'

export type SisyphusMachineEndpoint = typeof SISYPHUS_MACHINE_ENDPOINT

export type { AppRouter, MachineRouter }

/**
 * Inputs and outputs inferred from the routers.
 *
 * **These are the only sanctioned way to type anything API-derived.** A hand-written DTO that
 * mirrors a procedure's return type is a defect rather than a convenience: it is duplication the
 * qlty gate will flag, and — worse — it drifts silently, because nothing fails when the procedure
 * changes and the copy does not. Write `RouterOutputs['workflow']['byId']`, never a `WorkflowDto`
 * that happens to match it today.
 *
 * @example
 * ```ts
 * type WorkflowDetail = RouterOutputs['workflow']['byId']
 * type StartInput = RouterInputs['workflow']['start']
 * ```
 */
export type RouterInputs = inferRouterInputs<AppRouter>
export type RouterOutputs = inferRouterOutputs<AppRouter>

/** The same inference, for the surface the executor talks to. */
export type MachineRouterInputs = inferRouterInputs<MachineRouter>
export type MachineRouterOutputs = inferRouterOutputs<MachineRouter>

/**
 * The input schemas the resolvers validate with. The panel's forms take these same objects, so a
 * form and its procedure cannot disagree about a field name or a rule (FR-008).
 */
export * from '../schemas'

/** The platform's closed vocabularies — plain data, no runtime dependencies. */
export * from '../enums'
