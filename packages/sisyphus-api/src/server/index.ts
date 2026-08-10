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
  ValidationRunCredential,
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
  validationProcedure,
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
  inspectCredentialToken,
  VALIDATION_SUBJECT_PREFIX,
  validationRunIdFromSubject,
  validationSubject,
  verifyScopedCredential,
  WORKFLOW_SUBJECT_PREFIX,
  workflowIdFromSubject,
  workflowSubject,
} from './machine'
export type {
  CredentialTokenClaims,
  CredentialTokenRefusal,
  ScopedCredentialJwtOptions,
  ScopedCredentialJwtResult,
  ScopedCredentialJwtVerifier,
  ScopedCredentialOutcome,
  ScopedCredentialRefusal,
  ScopedCredentialResolverOptions,
} from './machine'

/**
 * The **validation** half of the same story (T200, FR-147, 003/FR-052).
 *
 * A sibling export rather than an addition to the block above, because it is a sibling mechanism: a
 * different subject space, a different table and a different credential type, sharing only the
 * signature-and-claims check. Both hosts wire both resolvers; neither resolver can produce the
 * other's credential. Exported from `/server` for the same reason and with the same exclusion from
 * `./client` — the executor presents credentials and must never bundle what accepts them.
 */
export {
  createValidationCredentialResolver,
  inspectValidationCredential,
  reportValidation,
  reportValidationProcedure,
  validationOutcomeFor,
  validationPhaseResults,
  verifyValidationCredential,
} from './machine'
export type {
  ValidationContext,
  ValidationCredentialOutcome,
  ValidationCredentialRefusal,
  ValidationPhaseResults,
  ValidationReport,
} from './machine'

/**
 * The machine-surface material seam (003/FR-012, 003/FR-030, 003/FR-032).
 *
 * Exported from `/server` for the same reason the notifier below is: it is a **host** contract. The
 * only implementation that can exist reaches AWS Secrets Manager from the control plane, and it is
 * supplied through `SisyphusDependencies.agentCredentialMaterial`. It is exported from here and
 * **not** from `/contracts`, because a browser-safe subpath is exactly where a capability that
 * returns credential material must not appear.
 */
export {
  agentCredentialMaterialStore,
  createRefusingMaterialStore,
  MATERIAL_STORE_NOT_CONFIGURED_REASON,
} from './machine'
export type { AgentCredentialMaterialStore } from './machine'

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

/**
 * The hosted login seam and the wall-clock sweep over it (003/FR-069..003/FR-072).
 *
 * Exported from `/server` for the same reason the material seam above is: it is a **host**
 * contract. The only implementation that can exist provisions EC2 from the control plane and is
 * supplied through `SisyphusDependencies.agentCredentialLogin`. `reapAbandonedLogins` comes with
 * it because the control plane's scheduled reaper is its only production caller — the sweep writes
 * this package's table and calls this package's port, so it lives here, and the schedule and the
 * clock live there. One definition of "expired", exercised from both sides.
 *
 * A holder of the port cannot reach credential material; see `server/admin/credential-login.ts`
 * for why that is the point rather than a limitation.
 */
export {
  ABANDONED_LOGIN_REASON,
  createRefusingLoginEnvironments,
  LOGIN_ENVIRONMENT_NOT_CONFIGURED_REASON,
  reapAbandonedLogins,
} from './admin'
export type {
  AgentCredentialLoginEnvironments,
  LoginEnvironment,
  LoginRelay,
  ReapAbandonedLoginsOptions,
  ReapAbandonedLoginsResult,
  ReapedLogin,
  StartedLogin,
} from './admin'

/**
 * The lease-release seam (003/FR-057, 003/FR-058).
 *
 * A host contract like the two above it, and the narrowest of the three: one method, which ends one
 * run's lease as one named administrator. The only implementation that can exist is the control
 * plane's `releaseLease`, supplied through `SisyphusDependencies.agentCredentialLeases`.
 *
 * `resolveWorkflowForForcedRelease` is exported beside it and is emphatically **not** part of the
 * port. It is the other half of FR-057 — the affected run resolved to a recorded state — and it
 * stays in this package because `workflows` is this package's table and the row lock it takes is
 * this package's primitive. A host wiring the port should be able to see that it is being asked for
 * the lease and nothing else.
 */
export {
  createRefusingLeaseReleases,
  FORCED_RELEASE_OUTCOME,
  forcedReleaseOutcomeReason,
  LEASE_RELEASE_NOT_CONFIGURED_REASON,
  resolveWorkflowForForcedRelease,
} from './admin'
export type {
  AgentCredentialLeaseReleases,
  ForcedLeaseRelease,
  ForcedReleaseWorkflowResolution,
  ForceReleaseLeaseRequest,
  ResolveWorkflowForForcedReleaseOptions,
} from './admin'

/**
 * The pool as the FR-056 alert sweep reads it (003/FR-053, 003/FR-074).
 *
 * Exported from `/server` because its one caller outside this package is a **control-plane job** —
 * the sweep that decides which seats need an administrator — and that job must read the pool
 * through the same query the pool view does. `sisyphus-notify` states the same rule from its own
 * side: nothing in that package reads `agent_credentials`, because a second query would be a second
 * definition of what a held seat is.
 *
 * A read and nothing else. No writer from `credential-store.ts` is published, which is what keeps
 * an alerter unable to act on what it raises.
 */
export { readCredentialPool } from './admin'
export type { CredentialPoolRow } from './admin'

export { healthRouter } from './health'

export { appRouter, createCaller, createMachineCaller, machineRouter } from './root'
export type { AppRouter, MachineRouter } from './root'
