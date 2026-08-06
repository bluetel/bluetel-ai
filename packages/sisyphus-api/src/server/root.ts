import { adminRouter } from './admin'
import { healthRouter } from './health'
import { machineSurfaceRouter } from './machine'
import { createCallerFactory, createTRPCRouter } from './procedures'
import { workflowRouter } from './workflow'

/**
 * The two routers and the in-process caller — one contract, three consumption modes (plan.md R4).
 *
 * 1. **Panel** — `apps/sisyphus-admin` mounts {@link appRouter} at `/api/trpc` and
 *    {@link machineRouter} at `/api/machine` through `fetchRequestHandler`.
 * 2. **Control plane** — `apps/sisyphus-control-plane` calls the same resolvers in-process via
 *    {@link createCaller}. No network hop, no second copy of the authorisation rules.
 * 3. **Executor** — `apps/sisyphus-executor` imports {@link MachineRouter} as a **type only**,
 *    through `@bluetel-ai/sisyphus-api/client`. No resolver and no database driver is bundled
 *    onto the instance, so a compromised setup bundle cannot reach the database (FR-005, FR-006).
 *
 * The two surfaces are separate routers rather than two branches of one, because that is what
 * makes "an executor credential grants nothing on the interactive surface" a structural fact: the
 * interactive procedures are not reachable from the machine mount at all.
 */

/**
 * The interactive surface. Requires a human session everywhere except the health check.
 *
 * Domain sub-routers (`workflow`, `admin`) are mounted here as they land; the procedure types they
 * are built from are already fixed in `procedures.ts`, so adding one cannot introduce a new
 * authorisation shape.
 */
export const appRouter = createTRPCRouter({
  health: healthRouter,
  admin: adminRouter,
  workflow: workflowRouter,
})

export type AppRouter = typeof appRouter

/**
 * The machine surface — executor report-back, authorised by a workflow-scoped credential.
 *
 * Mounted separately at `/api/machine`, and assembled here rather than re-exported directly so
 * both mounts and both callers come from one place. Every procedure on it is scoped to
 * `ctx.workflowId`; a cross-workflow write is refused and recorded as a security event.
 */
export const machineRouter = machineSurfaceRouter

export type MachineRouter = typeof machineRouter

/**
 * In-process caller for the interactive surface.
 *
 * The control plane runs the real resolvers — including the scoping middleware — rather than a
 * privileged back door, so a job that reads workflows is subject to the same FR-190 rules the
 * panel is. It supplies its own context, which is how it presents a system identity.
 */
export const createCaller = createCallerFactory(appRouter)

/** In-process caller for the machine surface, used by the reconciler and by integration tests. */
export const createMachineCaller = createCallerFactory(machineRouter)
