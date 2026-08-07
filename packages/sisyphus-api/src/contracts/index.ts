/**
 * Shared contracts — `@bluetel-ai/sisyphus-api/contracts`.
 *
 * Types, and the handful of pure functions that a type would be meaningless without: browser-safe
 * by construction, because the connector interface and the executor protocol shapes are consumed
 * by the control plane, the executor and the panel alike, so nothing here may carry a runtime
 * dependency that any one of them cannot bundle. Nothing in this directory reads configuration,
 * opens a socket or touches the database — `{@link externalActionKey}` joins strings, and that is
 * the outer limit of what belongs here.
 *
 * The connector interface lives here rather than in an integration package for FR-192: the
 * control plane depends on the abstraction and never on Jira, so adding a second integration type
 * is a new package plus a registry entry, not a change to anything that already exists.
 */

/**
 * Version of the executor ⇄ machine-surface protocol (executor-protocol.md).
 *
 * A literal union rather than `number`: widening it is a deliberate edit, and every message shape
 * that references it fails to compile until the new version is handled.
 */
export type ExecutorProtocolVersion = 'v1'

/**
 * Base shape every message on the executor protocol extends. The control plane rejects an envelope
 * whose version it does not implement, so the field is required rather than optional.
 */
export interface ProtocolMessage {
  readonly protocolVersion: ExecutorProtocolVersion
}

export type {
  CandidateItem,
  DiscoverContext,
  DiscoverySkip,
  IntegrationConnector,
  IntegrationMapping,
  ItemComment,
  MappingResolution,
  PromptContext,
  PromptParts,
  ValidationCheck,
  ValidationResult,
  WriteBackEvent,
  WriteBackSkipReason,
} from './connector'

export { EXTERNAL_ACTION_KEY_SEPARATOR, externalActionKey, NO_WORKFLOW } from './external-action'
export type {
  ExternalActionDisposition,
  ExternalActionIdentity,
  ExternalActionResult,
} from './external-action'
