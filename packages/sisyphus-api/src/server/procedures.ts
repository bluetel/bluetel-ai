import { TRPCError } from '@trpc/server'

import type {
  MachineCredential,
  SessionUser,
  SisyphusAdditionalContext,
  SisyphusDependencies,
} from './context'
import { createSisyphusAdditionalContext } from './context'
import { createTRPCSetup } from './trpc'

/**
 * The six procedure types, and the guarantee each one carries.
 *
 * | Procedure             | Guarantees                                                            |
 * | --------------------- | --------------------------------------------------------------------- |
 * | `publicProcedure`     | Nothing. Health check only.                                           |
 * | `authedProcedure`     | An **active** human session; sets `ctx.user`.                         |
 * | `adminProcedure`      | `authedProcedure` + `role = 'admin'`; the denial is recorded.          |
 * | `scopedProcedure`     | `authedProcedure` + a resolved `ctx.scope` every workflow query uses.  |
 * | `machineProcedure`    | A valid workflow-scoped credential; sets `ctx.workflowId`.            |
 * | `validationProcedure` | A valid validation credential; sets `ctx.validationRunId`.            |
 *
 * Each is built from the one before it with `.use()` rather than from a shared middleware list,
 * so the chained context type is what the next middleware sees — `adminProcedure` reads
 * `ctx.user` because `authedProcedure` put it there, not because it re-derives it.
 *
 * The last two are siblings rather than a chain, and that is the whole of T200's authorisation
 * story: `validationProcedure` is **not** built on `machineProcedure`, because a validation run has
 * no workflow and `machineProcedure`'s entire purpose is to establish one. Building it on top would
 * have required a nullable `ctx.workflowId`, which every existing machine resolver would then have
 * had to handle. Both are built on `publicProcedure` and each resolves its own credential from its
 * own table.
 */

export const { t, createTRPCContext, createCallerFactory, createTRPCRouter, publicProcedure } =
  createTRPCSetup<SisyphusAdditionalContext, SisyphusDependencies>({
    createAdditionalContext: createSisyphusAdditionalContext,
  })

/**
 * Requires an active human session.
 *
 * A deactivated user fails **here**, on every request, rather than at next sign-in: sessions are
 * database-backed precisely so revoking access takes effect immediately (FR-175, FR-176). The
 * message carries no workflow data (FR-011).
 *
 * A missing session is not recorded as a denial — a signed-out browser hitting a page is ordinary
 * traffic, and recording it would bury the refusals that matter. An *inactive* account is
 * recorded, because someone is using credentials that were taken away.
 */
export const authedProcedure = publicProcedure.use(async ({ ctx, path, next }) => {
  const { session } = ctx

  if (session === null) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not signed in.' })
  }

  if (!session.user.isActive) {
    await ctx.dependencies.recordDenial({
      reason: 'inactive_user',
      userId: session.user.id,
      path,
    })
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'This account is no longer active.' })
  }

  return next({ ctx: { session, user: session.user } })
})

/**
 * Requires the `admin` role. Every configuration mutation in the platform is one of these
 * (FR-169).
 *
 * `FORBIDDEN` is correct here and is **not** in tension with FR-190: the caller is asking to
 * perform an administrative action, not asking whether a particular workflow exists, so refusing
 * with a reason discloses nothing about anyone's data.
 */
export const adminProcedure = authedProcedure.use(async ({ ctx, path, next }) => {
  if (ctx.user.role !== 'admin') {
    await ctx.dependencies.recordDenial({ reason: 'not_admin', userId: ctx.user.id, path })
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'This action requires the admin role.',
    })
  }

  return next()
})

/**
 * Requires a session and resolves the caller's visible set **once**, replacing the lazy resolver
 * on `ctx.scope` with the resolved value.
 *
 * This is where FR-190 is enforced. Every workflow read composes its `where` from
 * `visibleWorkflowsFilter(ctx.scope)`; a resolver that assembles its own predicate has re-derived
 * the rule, and when it gets it wrong nothing fails — it just returns a row it should not have.
 * Counts and aggregates go through the same selector, because a total that includes an invisible
 * workflow discloses that the workflow exists.
 */
export const scopedProcedure = authedProcedure.use(async ({ ctx, next }) => {
  const scope = await ctx.scope.resolve()
  return next({ ctx: { scope } })
})

/**
 * Requires a valid workflow-scoped credential and pins the request to one workflow.
 *
 * Built on `publicProcedure` rather than on `authedProcedure` deliberately: the machine surface
 * has its own authorisation and **an executor credential grants nothing on the interactive
 * surface** (FR-005). The converse is enforced here — a request carrying a human session is
 * refused even if it also presents a credential, so the two surfaces cannot be confused into
 * lending each other authority.
 */
export const machineProcedure = publicProcedure.use(async ({ ctx, path, next }) => {
  const credential = await ctx.machineCredential()

  if (credential === null) {
    await ctx.dependencies.recordDenial({ reason: 'machine_credential_missing', path })
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'This surface requires a workflow-scoped credential.',
    })
  }

  if (credential.expiresAt.getTime() <= Date.now()) {
    await ctx.dependencies.recordDenial({
      reason: 'machine_credential_invalid',
      workflowId: credential.workflowId,
      path,
      detail: 'expired',
    })
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Credential expired.' })
  }

  if (ctx.session !== null) {
    await ctx.dependencies.recordDenial({
      reason: 'surface_confusion',
      userId: ctx.session.user.id,
      workflowId: credential.workflowId,
      path,
      detail: 'human session presented on the machine surface',
    })
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'The machine surface does not accept an interactive session.',
    })
  }

  return next({ ctx: { workflowId: credential.workflowId, credential } })
})

/**
 * Requires a valid **bundle validation** credential and pins the request to one validation run
 * (T200, FR-147, 003/FR-052).
 *
 * ## Why this exists at all
 *
 * Every other procedure on the machine surface is scoped to `ctx.workflowId`, and a validation run
 * has no workflow — which is why, until this existed, a validation-mode executor could not report
 * anything and halted at the boundary rather than provisioning. FR-147 requires per-phase results to
 * be reported and recorded; this is the authorisation that makes reporting them possible.
 *
 * ## Written as a sibling of `machineProcedure`, deliberately
 *
 * Same three checks in the same order, against a different table:
 *
 * 1. **A credential, or `UNAUTHORIZED`.** An unwired host resolves `null` here exactly as a missing
 *    header does, and both are recorded as `machine_credential_missing`. A deployment that has not
 *    supplied `resolveValidationCredential` therefore refuses reports rather than accepting
 *    unauthenticated ones — see the dependency's own note.
 * 2. **The row's expiry, never the token's.** The token's `exp` is a twelve-hour ceiling; the row's
 *    `expires_at` is the short window. A validation is bounded at 45 minutes and its window is 15,
 *    so this check is reached in practice by any run whose `setup.sh` is slow.
 * 3. **No human session.** FR-005 in both directions: an executor credential grants nothing on the
 *    interactive surface, and a request carrying a panel cookie is refused here even when it also
 *    presents a valid credential, so the two surfaces cannot lend each other authority.
 *
 * What it deliberately does **not** do is put a `workflowId` on the context under any name. There is
 * none, and inventing one — the validation run's id, say — would make a validation credential
 * capable of satisfying `assertMachineWorkflowMatches` against a row that does not exist.
 */
export const validationProcedure = publicProcedure.use(async ({ ctx, path, next }) => {
  const credential = await ctx.validationCredential()

  if (credential === null) {
    await ctx.dependencies.recordDenial({ reason: 'machine_credential_missing', path })
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'This surface requires a validation-scoped credential.',
    })
  }

  if (credential.expiresAt.getTime() <= Date.now()) {
    await ctx.dependencies.recordDenial({
      reason: 'machine_credential_invalid',
      validationRunId: credential.validationRunId,
      path,
      detail: 'expired',
    })
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Credential expired.' })
  }

  if (ctx.session !== null) {
    await ctx.dependencies.recordDenial({
      reason: 'surface_confusion',
      userId: ctx.session.user.id,
      validationRunId: credential.validationRunId,
      path,
      detail: 'human session presented on the machine surface',
    })
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'The machine surface does not accept an interactive session.',
    })
  }

  return next({
    ctx: { validationRunId: credential.validationRunId, validationCredential: credential },
  })
})

/** The context a `machineProcedure` resolver runs with. */
export interface MachineWriteContext {
  readonly workflowId: string
  readonly credential: MachineCredential
  readonly dependencies: SisyphusDependencies
}

/**
 * Refuse a machine write that names a workflow other than the credential's.
 *
 * `FORBIDDEN` here, `NOT_FOUND` for an out-of-scope human read — the difference is not an
 * inconsistency. The executor already knows its own workflow exists, so there is nothing to
 * disclose; what matters is that the attempt is recorded as a security event (FR-018, SC-014).
 *
 * @param ctx - The machine-procedure context.
 * @param claimedWorkflowId - The workflow named in the request payload.
 * @param path - Procedure path, for the audit record.
 */
export const assertMachineWorkflowMatches = async (
  ctx: MachineWriteContext,
  claimedWorkflowId: string,
  path?: string,
): Promise<void> => {
  if (claimedWorkflowId === ctx.workflowId) {
    return
  }

  await ctx.dependencies.recordDenial({
    reason: 'cross_workflow_write',
    workflowId: ctx.workflowId,
    path,
    detail: 'write named a workflow the credential does not cover',
  })

  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'This credential does not cover that workflow.',
  })
}

export type { SessionUser }
