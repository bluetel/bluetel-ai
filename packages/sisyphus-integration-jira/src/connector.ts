import type {
  CandidateItem,
  DiscoverContext,
  IntegrationMapping,
  PromptContext,
  WriteBackEvent,
} from '@bluetel-ai/sisyphus-api/contracts'

import type { JiraRestClient } from './client'
import type { JiraIntegrationConfig } from './config'
import { resolveJiraConfig } from './config'
import { discover } from './discover'
import { assemblePromptParts } from './prompt-parts'
import { resolveProfile } from './resolve-profile'
import { validate } from './validate'
import { writeBack } from './write-back'

/**
 * The five operations, assembled into the value the control plane registers (FR-192).
 *
 * ## One connector per integration row, from one entry in the registry
 *
 * A connector is built around a {@link JiraRestClient}, and a client is built around one board's
 * credential — read from the secret store at call time and never cached to disk (FR-072). So the
 * registry holds this *factory* rather than an instance, and the control plane builds a connector
 * for the integration it is ticking. Adding a second integration type adds a package and a
 * registry entry; it changes nothing here and nothing in the control plane, which is the test
 * FR-192 sets.
 *
 * ## The return type is deliberately inferred
 *
 * Nothing in this file declares that it implements the contract. `./index.ts` asserts it, at the
 * type level, on the *inferred* shape — so a method that drifts from
 * `@bluetel-ai/sisyphus-api/contracts` fails the build in this package rather than being papered
 * over by an annotation here.
 *
 * ## Where the configuration is parsed
 *
 * `validate` takes the configuration as the panel holds it and reports on it. The other operations
 * take it parsed, and a configuration that fails to parse throws — deliberately, because these run
 * on a tick: a malformed configuration fails the run, which is recorded and retried (FR-105,
 * FR-108), and that is a great deal better than a tick quietly proceeding with a filter it could
 * not understand.
 */

export interface JiraConnectorOptions {
  /** Built with this board's credential. Nothing in this package constructs one. */
  readonly client: JiraRestClient
}

export const createJiraConnector = (options: JiraConnectorOptions) => ({
  type: 'jira' as const,

  validate: (config: JiraIntegrationConfig) => validate(options.client, config),

  // `async`, so a configuration that will not parse arrives at the tick as a rejected promise
  // rather than as a synchronous throw from what every caller treats as an async call.
  discover: async (config: JiraIntegrationConfig, ctx: DiscoverContext) =>
    discover(options.client, resolveJiraConfig(config), ctx),

  resolveProfile: (item: CandidateItem, mappings: readonly IntegrationMapping[]) =>
    resolveProfile(item, mappings),

  assemblePromptParts: (item: CandidateItem, ctx: PromptContext) => assemblePromptParts(item, ctx),

  writeBack: async (config: JiraIntegrationConfig, item: CandidateItem, event: WriteBackEvent) =>
    writeBack(options.client, resolveJiraConfig(config), item, event),
})
