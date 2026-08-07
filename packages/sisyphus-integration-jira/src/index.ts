import type { IntegrationConnector } from '@bluetel-ai/sisyphus-api/contracts'

import type { JiraIntegrationConfig } from './config'
import type { createJiraConnector } from './connector'

/**
 * `@bluetel-ai/sisyphus-integration-jira` — the Jira connector (US8, FR-192).
 *
 * One package per integration type. Nothing here is imported by the control plane by name: it
 * depends on the connector contract in `@bluetel-ai/sisyphus-api/contracts` and reaches this
 * package through the registry, which is what makes a second integration type a new package and a
 * registry entry rather than a change to everything that already exists.
 *
 * **This barrel is where the package proves it satisfies that contract**, below, at the type
 * level. `./connector.ts` deliberately does not annotate its return type, so the assertion is made
 * against what the implementation actually is: change the contract in `sisyphus-api`, or let a
 * method here drift from it, and this package stops compiling. A comment claiming conformance
 * would have gone on looking true for as long as nobody checked.
 */

/** The contract this package implements. */
export type JiraConnector = IntegrationConnector<JiraIntegrationConfig>

/**
 * Compiles only while `T` satisfies the connector contract.
 *
 * The constraint is the assertion; the alias exists to give it somewhere to live.
 */
type SatisfiesConnectorContract<T extends JiraConnector> = T

/**
 * The assertion itself: the *inferred* shape of {@link createJiraConnector}'s result, checked
 * against the contract. A drift in either direction is a compile error in this package.
 */
export type AssertedJiraConnector = SatisfiesConnectorContract<
  ReturnType<typeof createJiraConnector>
>

export { toCandidateItem, UNUSABLE_ISSUE } from './candidate'
export type { CandidateResult } from './candidate'

export type {
  JiraCommentPage,
  JiraCommentRecord,
  JiraIssue,
  JiraIssueFields,
  JiraRestClient,
  JiraSearchPage,
  JiraUser,
} from './client'

/**
 * The HTTP adapter for the port above — the only thing in this package that opens a socket, and the
 * only thing a deployment needs beyond {@link createJiraConnector} to reach a real board.
 */
export {
  authorisationHeader,
  createJiraHttpClient,
  DISCOVERY_FIELDS,
  JIRA_API_BASE,
  requestFailedError,
} from './client-http'
export type { JiraHttpClientOptions } from './client-http'

export { createFakeJiraClient } from './client-fake'
export type {
  FakeAddCommentBehaviour,
  FakeJiraClient,
  FakeJiraClientOptions,
  FakeJiraCommentPost,
  FakeJiraSearch,
} from './client-fake'

export {
  commentIdentity,
  commentKey,
  hasMarker,
  JIRA_COMMENT_ACTION,
  renderCommentBody,
  renderMarker,
} from './comment-body'

export {
  jiraExtraFilters,
  jiraIntegrationConfigSchema,
  jiraServiceAccount,
  parseJiraConfig,
  resolveJiraConfig,
} from './config'
export type { JiraIntegrationConfig, JiraServiceAccount, ResolvedJiraConfig } from './config'

export { createJiraConnector } from './connector'
export type { JiraConnectorOptions } from './connector'

export { discover, DISCOVERY_TRUNCATED } from './discover'

export {
  isPlatformAuthored,
  type JiraCommentAuthor,
  type PlatformIdentity,
} from './is-platform-authored'

export { buildDiscoveryJql, DISCOVERY_ORDER, escapeJqlValue, jqlClause, jqlField } from './jql'

export { resolvePlatformIdentity, UnknownPlatformIdentityError } from './platform-identity'

export {
  assemblePromptParts,
  DEFAULT_MAX_COMMENT_CHARACTERS,
  DEFAULT_MAX_COMMENTS,
} from './prompt-parts'

export { resolveProfile } from './resolve-profile'

export { sanitiseFailure } from './sanitise-failure'

export {
  CONFIGURATION_CHECK,
  CONNECTIVITY_CHECK,
  DISCOVERY_CHECK,
  SERVICE_ACCOUNT_CHECK,
  validate,
} from './validate'

export { writeBack } from './write-back'
