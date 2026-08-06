import type { RouterInputs } from '@sisyphus-admin/trpc'

import { isIdentifier } from './audit-scope'

/**
 * What the **configuration** trail is narrowed to, and how that survives a reload (FR-178).
 *
 * ## Why this is a second scope module rather than three more fields on `./audit-scope.ts`
 *
 * The two are filters of different questions. `AuditScope` carries a **subject** — the user a
 * change was made *about* — because that is what the role-and-activation trail and the access
 * trail are both indexed by. This trail is not about a user at all: it is about a bundle, a
 * workspace, a profile or an integration, and the useful filters are *which thing* and *which
 * admin*. Folding them together would give one object where half the fields are meaningless to
 * whichever query is reading it, and a `hasSubject`-shaped guard that has to say which half it
 * means.
 *
 * They do share the identifier rule, and that is imported rather than restated: a second copy of
 * the UUID pattern is exactly the drift `audit-scope.ts` already warns about.
 *
 * ## Everything is validated before it is sent, and dropped if it is not
 *
 * The same rule the subject follows. A value that is not an identifier blocks the read and marks
 * the field rather than being forwarded, and a value a hand-edited URL invented is dropped rather
 * than passed through — a stale link should produce a history, not a validation error.
 *
 * The vocabularies are **not** restated either. `entityType` and `action` are taken from the
 * procedure's own input type, so the set of things this screen can ask about is the set the server
 * accepts, by construction.
 */

type ConfigurationAuditInput = RouterInputs['admin']['audit']['list']

/** An entity class the trail covers, as the procedure names them. */
export type AuditEntityType = NonNullable<ConfigurationAuditInput['entityType']>

/** An action the trail records, as the procedure names them. */
export type AuditAction = NonNullable<ConfigurationAuditInput['action']>

/** The query-string keys this narrowing travels under. */
export const ENTITY_TYPE_PARAM = 'entity'
export const ENTITY_ID_PARAM = 'entityId'
export const ACTOR_PARAM = 'actor'

/**
 * What the configuration trail is narrowed to.
 *
 * Every field is `''` rather than `undefined` when unset, for the reason `AuditScope` gives: these
 * are bound to controls, and a control whose value flips between `undefined` and a string is an
 * uncontrolled-input warning waiting to happen. The conversion to "absent" happens once, at the
 * query.
 */
export interface ConfigurationScope {
  readonly entityType: string
  readonly entityId: string
  readonly actorUserId: string
}

/** Nothing narrowed: every recorded configuration change, newest first. */
export const EMPTY_CONFIGURATION_SCOPE: ConfigurationScope = {
  entityType: '',
  entityId: '',
  actorUserId: '',
}

/**
 * The entity classes, with what an operator calls each.
 *
 * A `Record` over the union rather than an array of pairs, and that is the whole point: adding a
 * class to `AUDITED_ENTITY_TYPES` in the API makes this a **compile error** until the panel gives
 * it a label, so the filter cannot quietly stop offering a class the trail has started recording.
 */
export const ENTITY_TYPE_LABELS: Record<AuditEntityType, string> = {
  setup_bundle: 'setup bundle',
  workspace: 'workspace',
  execution_profile: 'execution profile',
  integration: 'integration',
  user: 'user',
  profile_access_grant: 'profile access grant',
  workflow: 'workflow',
}

/** The actions, labelled the same way and exhaustive for the same reason. */
export const ACTION_LABELS: Record<AuditAction, string> = {
  registered: 'registered',
  replaced: 'replaced',
  updated: 'updated',
  enabled: 'enabled',
  disabled: 'disabled',
  granted: 'granted',
  revoked: 'revoked',
  role_changed: 'role changed',
  activated: 'activated',
  deactivated: 'deactivated',
  owner_reassigned: 'owner reassigned',
}

/** One choice in a picker: what the operator reads, and what the request carries. */
export interface ScopeOption {
  readonly value: string
  readonly label: string
}

const toOptions = (labels: Readonly<Record<string, string>>): readonly ScopeOption[] =>
  Object.entries(labels).map(([value, label]) => ({ value, label }))

export const ENTITY_TYPE_OPTIONS = toOptions(ENTITY_TYPE_LABELS)
export const ACTION_OPTIONS = toOptions(ACTION_LABELS)

/** Whether a value is one of the entity classes the procedure accepts. */
export const isEntityType = (value: string): value is AuditEntityType =>
  Object.hasOwn(ENTITY_TYPE_LABELS, value)

/** Whether the entity-id field holds something that is not an identifier. */
export const hasInvalidEntityId = (scope: ConfigurationScope): boolean =>
  scope.entityId.trim() !== '' && !isIdentifier(scope.entityId)

/** Whether the actor field holds something that is not an identifier. */
export const hasInvalidActor = (scope: ConfigurationScope): boolean =>
  scope.actorUserId.trim() !== '' && !isIdentifier(scope.actorUserId)

/** Whether anything in this narrowing would block the read. */
export const hasInvalidConfigurationScope = (scope: ConfigurationScope): boolean =>
  hasInvalidEntityId(scope) || hasInvalidActor(scope)

/** Whether anything at all is narrowed, for deciding whether a "clear" control is worth offering. */
export const hasConfigurationNarrowing = (scope: ConfigurationScope): boolean =>
  scope.entityType !== '' || scope.entityId.trim() !== '' || scope.actorUserId.trim() !== ''

/** Read one value out of a search-param record, taking the first when a key repeats. */
const single = (value: string | readonly string[] | undefined): string => {
  if (value === undefined) return ''
  return (typeof value === 'string' ? value : (value[0] ?? '')).trim()
}

/**
 * Read the configuration narrowing back out of a URL.
 *
 * Total: an entity class the procedure does not know and an id that is not an identifier are both
 * dropped, so a link someone edited by hand produces a trail rather than a refusal.
 *
 * @param params - The page's `searchParams`, as Next.js hands them over.
 */
export const parseConfigurationScope = (
  params: Readonly<Record<string, string | readonly string[] | undefined>>,
): ConfigurationScope => {
  const entityType = single(params[ENTITY_TYPE_PARAM])
  const entityId = single(params[ENTITY_ID_PARAM])
  const actorUserId = single(params[ACTOR_PARAM])

  return {
    entityType: isEntityType(entityType) ? entityType : '',
    entityId: isIdentifier(entityId) ? entityId : '',
    actorUserId: isIdentifier(actorUserId) ? actorUserId : '',
  }
}

/**
 * Write the configuration narrowing into a URL.
 *
 * An unset or unusable value contributes **no key**, so a cleared filter leaves no trace in the
 * address bar.
 *
 * @param scope - The applied narrowing.
 * @returns The query string without its leading `?`, empty when nothing is narrowed.
 */
export const toConfigurationSearchParams = (scope: ConfigurationScope): string => {
  const params = new URLSearchParams()

  if (isEntityType(scope.entityType)) params.set(ENTITY_TYPE_PARAM, scope.entityType)
  if (isIdentifier(scope.entityId)) params.set(ENTITY_ID_PARAM, scope.entityId.trim())
  if (isIdentifier(scope.actorUserId)) params.set(ACTOR_PARAM, scope.actorUserId.trim())

  return params.toString()
}

/**
 * Turn the narrowing into the `admin.audit.list` input.
 *
 * Each key is **omitted entirely** when unset rather than sent as `undefined`, so the unfiltered
 * read and a narrowed one are different shapes rather than one shape with holes in it — the same
 * rule `toRoleChangesInput` follows.
 */
export const toConfigurationAuditInput = (
  scope: ConfigurationScope,
  limit: number,
): ConfigurationAuditInput => ({
  limit,
  ...(isEntityType(scope.entityType) ? { entityType: scope.entityType } : {}),
  ...(isIdentifier(scope.entityId) ? { entityId: scope.entityId.trim() } : {}),
  ...(isIdentifier(scope.actorUserId) ? { actorUserId: scope.actorUserId.trim() } : {}),
})
