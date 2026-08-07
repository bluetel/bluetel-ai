/**
 * The configuration audit view (T136, FR-177, FR-183, FR-184, SC-050, SC-053).
 *
 * The page imports {@link AuditPanel} and {@link parseAuditScope} and nothing else; the rest is
 * exported for the colocated tests. Consumers import this barrel, never a module inside it.
 *
 * Nothing here writes. Every trail this directory renders is append-only in the database, and no
 * component below exposes an edit or a delete — an affordance offered for something that cannot be
 * done would be a lie about the record.
 *
 * The role-and-activation history itself is **not** re-implemented here: `RoleChangeHistory` in
 * `components/admin/users` already renders it, and a second copy would be a second opinion about
 * what an append-only trail looks like. What this directory owns is the screen around it — the
 * subject narrowing, and the access history that reads the grants table from the user's side.
 *
 * FR-178's `configuration_audit` trail is written by `sisyphus-api`'s `server/admin/audit-log.ts`
 * and is read by `admin.audit.list`. Its narrowing, shaping and card live here beside the access
 * trail's — as a **second** scope module rather than three more fields on the first, because "what
 * happened to this account" and "what was changed about this bundle" are different questions with
 * different answers. See `./configuration-scope.ts`.
 */

export { AUDIT_PAGE_SIZE, AuditPanel } from './audit-panel'

export {
  EMPTY_AUDIT_SCOPE,
  hasInvalidSubject,
  hasSubject,
  isIdentifier,
  parseAuditScope,
  SUBJECT_PARAM,
  toAuditSearchParams,
  toRoleChangesInput,
} from './audit-scope'
export type { AuditScope } from './audit-scope'

export {
  ACTION_LABELS,
  ACTION_OPTIONS,
  ACTOR_PARAM,
  EMPTY_CONFIGURATION_SCOPE,
  ENTITY_ID_PARAM,
  ENTITY_TYPE_LABELS,
  ENTITY_TYPE_OPTIONS,
  ENTITY_TYPE_PARAM,
  hasConfigurationNarrowing,
  hasInvalidActor,
  hasInvalidConfigurationScope,
  hasInvalidEntityId,
  isEntityType,
  parseConfigurationScope,
  toConfigurationAuditInput,
  toConfigurationSearchParams,
} from './configuration-scope'
export type {
  AuditAction,
  AuditEntityType,
  ConfigurationScope,
  ScopeOption,
} from './configuration-scope'

export { describeActor, summariseDetail, toConfigurationTrailReadouts } from './configuration-trail'
export type { ConfigurationAuditEntry, ConfigurationTrailReadouts } from './configuration-trail'

export { ConfigurationFilters } from './configuration-filters'
export { ConfigurationTrailCard } from './configuration-trail-card'

export { NO_ACTOR, toGrantTrailReadouts } from './grant-trail'
export type { GrantTrailReadouts, UserGrant } from './grant-trail'

export { GrantTrailCard } from './grant-trail-card'
