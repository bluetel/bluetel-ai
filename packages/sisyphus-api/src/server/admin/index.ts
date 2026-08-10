/**
 * The administration surface — configuration, identity and access.
 *
 * Everything here is `adminProcedure` with one deliberate exception, `bundles.list`, which any
 * authenticated user may read because selecting a bundle is part of building a profile (FR-086).
 * The exception is stated in `bundles.ts` rather than being inferred from the absence of a check.
 *
 * `adminRouter` is what `root.ts` mounts. The sub-routers are also exported individually so the
 * control plane's in-process caller and the contract tests can reach one without assembling all of
 * them.
 *
 * `test-database.ts` is intentionally **not** re-exported: it is test support for the live-database
 * suites in this directory, and nothing in `src/server/` imports it.
 */

import { createTRPCRouter } from '../procedures'

import { auditRouter } from './audit'
import { bundlesRouter } from './bundles'
import { credentialGroupsRouter } from './credential-groups'
import { credentialPoolRouter } from './credential-pool'
import { credentialsRouter } from './credentials'
import { adminGrantsRouter } from './grants'
import { integrationsRouter } from './integrations'
import { profilesRouter } from './profiles'
import { usersRouter } from './users'
import { workspacesRouter } from './workspaces'

export const adminRouter = createTRPCRouter({
  users: usersRouter,
  grants: adminGrantsRouter,
  bundles: bundlesRouter,
  workspaces: workspacesRouter,
  profiles: profilesRouter,

  /**
   * The credential pool's capacity groups and their profile attachments (003/FR-060..FR-067).
   *
   * Mounted beside `profiles` rather than inside it even though half of what it does is edit a
   * profile's attachments, because the group is the entity: a group outlives every profile attached
   * to it, is administered by whoever owns pool capacity, and is what the audit trail records
   * against. The credentials themselves, and the pool view over them, arrive as their own mounts in
   * later phases.
   */
  credentialGroups: credentialGroupsRouter,

  /**
   * The seats in those pools — registration, the hosted login and re-login, disable and the FR-005
   * delete refusal (003/FR-004..FR-010, 003/FR-061, 003/FR-069..003/FR-072).
   *
   * Mounted as the default `credentialsRouter`, which is wired to the **refusing** login
   * provisioner, for the same reason `integrations` is mounted with the refusing connector
   * registry: until a deployment supplies one through `SisyphusDependencies.agentCredentialLogin`,
   * the platform genuinely cannot provision an environment to log in inside, and a mount that
   * answered anyway would report a session that does not exist.
   */
  credentials: credentialsRouter,

  /**
   * The report over the two above — "should we buy another seat", per group (003/FR-053..FR-055,
   * 003/FR-074, 003/SC-011).
   *
   * A third mount rather than a procedure on either sibling, because it answers a different kind of
   * question: those two say what is configured, this says whether the configuration is enough, and
   * it reads the runs currently drawing on the pool to do it. Mounting it under `credentials` would
   * have put a read that joins `workflows` and `credential_leases` beside the registration
   * mutations, and mounting it under `credentialGroups` would have implied it was scoped to one.
   *
   * `adminProcedure` throughout, including the read — FR-053 says administrator-only in as many
   * words, and data-model.md → Access scoping says why the reads are too.
   */
  credentialPool: credentialPoolRouter,

  /**
   * The boards the platform polls (FR-096..FR-108, FR-186).
   *
   * Mounted as the default `integrationsRouter`, which is wired to the refusing connector registry
   * and the refusing prompt assembler. That is the honest default: until a deployment supplies both
   * through `createIntegrationsRouter`, the platform genuinely cannot reach a board, and a mount
   * that answered anyway would report a check it had not made.
   */
  integrations: integrationsRouter,

  /**
   * The read side of FR-178's configuration trail.
   *
   * `./audit-log.ts` has written this table since the first bundle was registered, and until this
   * mount nothing could read it: the panel's audit view showed role changes and grants and was
   * blind to bundles, workspaces, profiles and integrations. `api-surface.md` does not name this
   * sub-router — it is a strict extension over a table that already existed, built from the
   * vocabularies that already write it. See `./audit.ts`.
   */
  audit: auditRouter,
})

export type AdminRouter = typeof adminRouter

export {
  AUDITED_ACTIONS,
  AUDITED_ENTITY_TYPES,
  readEntityHistory,
  recordConfigurationChange,
} from './audit-log'
export type {
  AuditedAction,
  AuditedEntityType,
  AuditWriter,
  ConfigurationChange,
} from './audit-log'

export {
  auditRouter,
  entityHistoryInput,
  listConfigurationAudit,
  listConfigurationAuditConditions,
  listConfigurationAuditInput,
  readConfigurationHistory,
} from './audit'
export type {
  AuditPage,
  AuditRouter,
  ConfigurationAuditRow,
  EntityHistoryInput,
  ListConfigurationAuditInput,
} from './audit'

export { bundleNotFoundError, bundlesRouter, duplicateBundleNameError } from './bundles'
export type { BundleRegistration, BundlesRouter } from './bundles'

export { adminGrantsRouter, grantTargetNotFoundError } from './grants'
export type { AdminGrantsRouter, GrantIssued, GrantRevoked } from './grants'

export { usersRouter } from './users'
export type { UsersRouter } from './users'

export {
  duplicateWorkspaceNameError,
  workspaceNotFoundError,
  workspacesRouter,
  workspaceStateError,
} from './workspaces'
export type { WorkspacesRouter } from './workspaces'

export {
  duplicateProfileNameError,
  profilesRouter,
  profileStateError,
  profileTargetNotFoundError,
} from './profiles'
export type { ProfilesRouter } from './profiles'

export {
  credentialGroupNotDeletableError,
  credentialGroupsRouter,
  credentialGroupStateError,
  credentialTargetNotFoundError,
  duplicateCredentialGroupNameError,
} from './credential-groups'
export type {
  CredentialGroupChanged,
  CredentialGroupsRouter,
  CredentialMoved,
  ProfileAttachments,
} from './credential-groups'

export {
  assemblePool,
  credentialPoolRouter,
  GROUP_UNDERSIZED,
  healthOf,
  holderKindOf,
  POOL_HEALTHY,
  POOL_UNDERSIZED,
  pressureOf,
  verdictOf,
} from './credential-pool'
export type {
  AssemblePoolInput,
  CredentialConsumption,
  CredentialGroupPool,
  CredentialHealth,
  CredentialHolderKind,
  CredentialPoolHolder,
  CredentialPoolRouter,
  CredentialPoolSeat,
  CredentialPoolView,
  CredentialQueueView,
  GroupPressure,
  HolderBreakdown,
  PoolVerdict,
} from './credential-pool'

export {
  agentCredentialNotDeletableError,
  agentCredentialStateError,
  createCredentialsRouter,
  credentialsRouter,
  duplicateAgentCredentialNameError,
  forceReleaseNotConfiguredError,
  loginNotStartableError,
  noLeaseToForceReleaseError,
} from './credentials'
export type {
  AgentCredentialChanged,
  CredentialLoginStatus,
  CredentialsRouter,
  CredentialsRouterOptions,
  ForceReleasedCredential,
  StartedCredentialLogin,
} from './credentials'

/**
 * The lease-release seam (003/FR-057, 003/FR-058).
 *
 * Published for the reason the login port is: the composition root that supplies
 * `SisyphusDependencies.agentCredentialLeases` lives in an application and needs the port's type in
 * order to wire one — or the refusing default in order to say it deliberately wires none.
 *
 * The workflow resolution beside it is **not** part of the port and is exported anyway, because it
 * is the other half of FR-057 and a host reading the port's type should be able to see what this
 * package already does without it: the run is ended here, under this package's own workflow row
 * lock, and only the lease crosses the boundary.
 */
export {
  createRefusingLeaseReleases,
  FORCED_RELEASE_OUTCOME,
  forcedReleaseOutcomeReason,
  LEASE_RELEASE_NOT_CONFIGURED_REASON,
  resolveWorkflowForForcedRelease,
} from './credential-leases'
export type {
  AgentCredentialLeaseReleases,
  ForcedLeaseRelease,
  ForcedReleaseWorkflowResolution,
  ForceReleaseLeaseRequest,
  ResolveWorkflowForForcedReleaseOptions,
} from './credential-leases'

/**
 * The hosted login seam, and the wall-clock sweep over it (003/FR-069..003/FR-072).
 *
 * Published for the same reason `createRefusingConnectorRegistry` is: the composition root that
 * supplies `SisyphusDependencies.agentCredentialLogin` lives in an application, and it needs the
 * port's type and the refusing default in order to wire one — or to state that it deliberately
 * wires none. A holder of one cannot reach credential material; see the module for why that is the
 * point rather than a limitation.
 *
 * `reapAbandonedLogins` is exported beside the port because the control plane's scheduled reaper is
 * its only production caller. The sweep writes this package's table and calls this package's port,
 * so it lives here; the schedule, the clock and the job wrapper live there.
 */
export {
  ABANDONED_LOGIN_REASON,
  createRefusingLoginEnvironments,
  LOGIN_ENVIRONMENT_NOT_CONFIGURED_REASON,
  reapAbandonedLogins,
} from './credential-login'
export type {
  AgentCredentialLoginEnvironments,
  LoginEnvironment,
  LoginRelay,
  ReapAbandonedLoginsOptions,
  ReapAbandonedLoginsResult,
  ReapedLogin,
  StartedLogin,
} from './credential-login'

/**
 * The credential store's **types**, and the one function with a caller outside this package.
 *
 * The rest stay behind the module: every other caller is in this directory and imports it directly,
 * the way `profiles.ts` imports `profile-store.ts`. This is the deliberate widening the note here
 * anticipated — {@link readCredentialPool} is what the control plane's FR-056 alert sweep reads the
 * pool with, and it reads it through this query rather than one of its own precisely so that "which
 * seat is held, and by what" has a single definition. A second copy in the control plane would be a
 * second answer to FR-074's question, and the two would disagree the first time the live-lease
 * predicate changed.
 *
 * Nothing else from the store is published. In particular no writer is: the alerter's whole design
 * is that it can raise a seat's condition and cannot act on it.
 */
export { readCredentialPool } from './credential-store'
export type {
  AgentCredentialListing,
  AttachedProfileReference,
  CredentialConsumptionRow,
  CredentialGroupListing,
  CredentialGroupReferences,
  CredentialPoolRow,
  CredentialQueueRow,
  CredentialQueueTotals,
  ProfileCredentialGroupAttachment,
} from './credential-store'

export { credentialGroupAttachmentCheck } from './profile-gate'
export type {
  AttachedCredentialGroup,
  ProfileEnableCheck,
  ProfileEnableFailure,
} from './profile-gate'

export {
  createIntegrationsRouter,
  duplicateIntegrationNameError,
  enableRefusals,
  integrationsRouter,
  integrationStateError,
  integrationTargetNotFoundError,
  MANUAL_TICK_CHANNEL,
} from './integrations'
export type {
  IntegrationPromptPreview,
  IntegrationsRouter,
  IntegrationsRouterOptions,
  IntegrationValidation,
  ManualTickRequested,
} from './integrations'

export {
  CONNECTOR_NOT_CONFIGURED_REASON,
  createRefusingConnectorRegistry,
  createRefusingPromptLayering,
  PROMPT_LAYERING_NOT_CONFIGURED,
} from './integration-connectors'
export type {
  AssembledPromptPreview,
  ConnectorRequest,
  IntegrationConnectorRegistry,
  PromptLayering,
  PromptLayeringInput,
} from './integration-connectors'
