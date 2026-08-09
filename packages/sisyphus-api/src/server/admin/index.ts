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
