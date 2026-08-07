/**
 * Server entry point — `@bluetel-ai/sisyphus-api/server`.
 *
 * Everything reachable from here is Node-only: the tRPC router and its resolvers, Drizzle, and the
 * `postgres` driver. The package declares no root `.` export precisely so this module cannot be
 * reached from a panel client component by accident (FR-005). `assertServerOnly` is the runtime
 * backstop for the cases a bundler resolves anyway — a hand-written alias, a mis-ordered
 * `resolve.conditions` — so the failure is a loud error rather than a driver in the browser bundle.
 */

/** True when the current realm looks like a browser rather than a Node/Lambda runtime. */
const inBrowserRealm = (): boolean =>
  typeof (globalThis as { window?: unknown }).window !== 'undefined'

/**
 * Throw if a server-only module has been loaded into a browser realm.
 *
 * @param moduleName - Identifier used in the error message, e.g. `'sisyphus-api/server'`.
 */
export const assertServerOnly = (moduleName: string): void => {
  if (inBrowserRealm()) {
    throw new Error(
      `${moduleName} is server-only and was loaded in a browser realm. ` +
        `Import @bluetel-ai/sisyphus-api/client instead.`,
    )
  }
}

export { createTRPCSetup } from './trpc'
export type { FlattenedZodError, TRPCContextOptions } from './trpc'

export { memoiseAsync } from './memoise'

export { createSisyphusAdditionalContext } from './context'
export type {
  AuthorisationDenial,
  MachineCredential,
  SessionUser,
  SisyphusAdditionalContext,
  SisyphusContext,
  SisyphusDependencies,
  SisyphusSession,
} from './context'

export {
  countWorkflowsInScope,
  createScopeResolver,
  createUnauthenticatedScopeResolver,
  findWorkflowInScope,
  listWorkflowIdsInScope,
  loadGrantedProfileIds,
  memoiseScope,
  requireWorkflowInScope,
  scopedWorkflowWhere,
  visibleWorkflowsFilter,
  workflowNotFoundError,
} from './scope'
export type { ResolvedScope, ScopedReadOptions, ScopeIdentity, ScopeResolver } from './scope'

export {
  adminProcedure,
  assertMachineWorkflowMatches,
  authedProcedure,
  createCallerFactory,
  createTRPCContext,
  createTRPCRouter,
  machineProcedure,
  publicProcedure,
  scopedProcedure,
  t,
} from './procedures'
export type { MachineWriteContext } from './procedures'

/**
 * Workflow-scoped executor credentials: the claim vocabulary, and the verifier both hosts mount.
 *
 * Exported from `/server` rather than left behind the machine barrel because the control plane and
 * the panel each used to carry a step-for-step copy of it — neither can import the other, and two
 * verifiers that can disagree about what a valid credential is is a defect waiting for a divergent
 * edit. This is the single definition; a host supplies only its JOSE binding. It is deliberately
 * *not* on `./client`: the executor presents credentials and must never bundle the thing that
 * accepts them (FR-005, FR-006, FR-037).
 */
export {
  bearerTokenFrom,
  CREDENTIAL_HEADER,
  CREDENTIAL_SCHEME,
  createScopedCredentialResolver,
  credentialSigningKey,
  inspectScopedCredential,
  SCOPED_CREDENTIAL_ALGORITHM,
  SCOPED_CREDENTIAL_AUDIENCE,
  SCOPED_CREDENTIAL_ISSUER,
  SCOPED_CREDENTIAL_MAX_LIFETIME_MS,
  SCOPED_CREDENTIAL_WINDOW_MS,
  VALIDATION_SUBJECT_PREFIX,
  validationSubject,
  verifyScopedCredential,
  WORKFLOW_SUBJECT_PREFIX,
  workflowIdFromSubject,
  workflowSubject,
} from './machine'
export type {
  ScopedCredentialJwtOptions,
  ScopedCredentialJwtResult,
  ScopedCredentialJwtVerifier,
  ScopedCredentialOutcome,
  ScopedCredentialRefusal,
  ScopedCredentialResolverOptions,
} from './machine'

/**
 * The notification seam (FR-136, FR-141).
 *
 * Exported from `/server` because it is a **host** contract, not an internal one: the events this
 * package sets are announced through `SisyphusDependencies.notifier`, and whichever app mounts the
 * machine surface is what supplies one. `emitWorkflowEvent` comes with it so a host that emits on
 * its own behalf gets the same never-throwing wrapper rather than writing a second try/catch with
 * its own opinion of what FR-141 requires.
 */
export {
  emitWorkflowEvent,
  notificationEventForOutcome,
  notificationEventForVerdict,
} from './notify'
export type {
  WorkflowEventEmission,
  WorkflowEventEmitter,
  WorkflowEventNotification,
} from './notify'

export { healthRouter } from './health'

export { appRouter, createCaller, createMachineCaller, machineRouter } from './root'
export type { AppRouter, MachineRouter } from './root'
