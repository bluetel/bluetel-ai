import type { IntegrationConnector } from '@bluetel-ai/sisyphus-api/contracts'
import { createJiraConnector, createJiraHttpClient } from '@bluetel-ai/sisyphus-integration-jira'

import type { ConnectorFactory, ConnectorRegistry, IntegrationType } from './connector-registry'
import { createConnectorRegistry } from './connector-registry'

/**
 * **The composition root: the one file in the control plane that names a board (FR-192).**
 *
 * `connector-registry.ts` is a map the composition root fills in, and its own module comment sketches
 * exactly this file. It is deliberately alone in importing an integration package, and
 * `connector-registry.test.ts` holds that line as a source-level assertion over the modules that make
 * up the tick — `assemble-prompt`, `connector-registry`, `integration-health`, `integration-store`,
 * `integration-tick`, `prompt-redact` and `sync-schedules`. None of those changes when a second
 * integration type lands. This file gains one entry, and `package.json` gains one dependency. That
 * is the whole cost, and it is the test FR-192 sets.
 *
 * The registry entry is a **factory**, not a connector, because a connector is built around a client
 * and a client is built around one board's credential — read from the secret store at tick time and
 * never cached to disk (FR-072). One entry therefore serves every Jira board the platform is
 * configured with.
 *
 * ## Why the widening is here rather than in the registry
 *
 * `ConnectorFactory` answers `IntegrationConnector<unknown>`, and the Jira connector is an
 * `IntegrationConnector<JiraIntegrationConfig>`. Those are not assignable under
 * `strictFunctionTypes`, and they should not be: each connector owns its configuration schema and
 * **parses** it, which is what lets the control plane assemble a config shape from the row without
 * holding a union of every type's config. {@link widenConnectorConfig} is that boundary, made
 * explicit and made once. A config the connector cannot parse fails the tick, which is recorded and
 * retried (FR-105, FR-108) — which is the designed behaviour, not a hole the cast opens.
 *
 * ## Nothing here reaches a board
 *
 * Building a client opens nothing: `createJiraHttpClient` closes over a base URL and a credential and
 * returns four functions. No test in this directory makes a request, and the composition below is
 * exercised against an injected `fetch` that refuses.
 */

/**
 * Present a connector that parses its own configuration as one the registry can hold.
 *
 * @param connector - The connector, typed in its own configuration.
 */
export const widenConnectorConfig = <TConfig>(
  connector: IntegrationConnector<TConfig>,
): IntegrationConnector<unknown> => ({
  type: connector.type,
  validate: async (config) => connector.validate(config as TConfig),
  discover: async (config, ctx) => connector.discover(config as TConfig, ctx),
  resolveProfile: (item, mappings) => connector.resolveProfile(item, mappings),
  assemblePromptParts: (item, ctx) => connector.assemblePromptParts(item, ctx),
  writeBack: async (config, item, event) => connector.writeBack(config as TConfig, item, event),
})

/**
 * One Jira board, from its row and its freshly-read credential.
 *
 * The credential is passed to the client and never onto the config, so a configuration that reaches
 * a log or an integration run record cannot carry a token (FR-072, FR-098).
 */
export const jiraConnectorFactory: ConnectorFactory = ({ credential, baseUrl }) =>
  widenConnectorConfig(
    createJiraConnector({ client: createJiraHttpClient({ baseUrl, credential }) }),
  )

/** Every integration type this deployment can actually tick. */
export const REGISTERED_CONNECTOR_TYPES: readonly IntegrationType[] = ['jira']

/**
 * The registry the control plane's entrypoint hands to {@link import('./integration-tick').integrationTick}.
 *
 * A deployment that wants fewer types builds its own with {@link createConnectorRegistry}; the
 * refusal an unregistered type produces is more honest than a stub that ticks nothing and reports
 * success.
 */
export const createRegisteredConnectorRegistry = (): ConnectorRegistry =>
  createConnectorRegistry({ jira: jiraConnectorFactory })
