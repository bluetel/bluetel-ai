import type {
  CandidateItem,
  IntegrationConnector,
  IntegrationMapping,
  MappingResolution,
  PromptParts,
  ValidationResult,
} from '../../contracts'

import type {
  ConnectorRequest,
  IntegrationConnectorRegistry,
  PromptLayering,
  PromptLayeringInput,
} from './integration-connectors'

/**
 * Recording fakes for the two outbound seams, so no test in this package makes a network call.
 *
 * Shipped beside the ports for the same reason `reachability-fake.ts` is: every suite that needs
 * one takes this rather than inventing a stub apiece, and the record — which configs were asked
 * for, whether the credential ARN ever reached the connector — is most of what is worth asserting.
 */

export interface FakeConnectorOptions {
  readonly type?: IntegrationConnector<unknown>['type']
  readonly validation?: ValidationResult
  readonly items?: readonly CandidateItem[]
  readonly discoverError?: Error
}

export interface FakeIntegrationConnector extends IntegrationConnector<unknown> {
  readonly validatedConfigs: readonly unknown[]
}

const firstMatch = (
  item: CandidateItem,
  mappings: readonly IntegrationMapping[],
): MappingResolution => {
  const ordered = [...mappings].sort((left, right) => left.position - right.position)

  for (const mapping of ordered) {
    const matched = Object.entries(mapping.criteria).every(
      ([key, value]) => item.attributes[key] === String(value),
    )

    if (matched || mapping.isDefault) {
      return {
        matched: true,
        executionProfileId: mapping.executionProfileId,
        mappingId: mapping.id,
      }
    }
  }

  return { matched: false, reason: 'no_mapping_matched' }
}

export const createFakeIntegrationConnector = (
  options: FakeConnectorOptions = {},
): FakeIntegrationConnector => {
  const validatedConfigs: unknown[] = []

  return {
    type: options.type ?? 'jira',
    validatedConfigs,

    validate: (config) => {
      validatedConfigs.push(config)
      return Promise.resolve(options.validation ?? { ok: true, checks: [] })
    },

    discover: () =>
      options.discoverError === undefined
        ? Promise.resolve(options.items ?? [])
        : Promise.reject(options.discoverError),

    resolveProfile: (item, mappings) => firstMatch(item, mappings),

    assemblePromptParts: (item): PromptParts => ({
      title: item.title,
      url: item.url,
      body: item.body,
      comments: item.comments
        .filter((comment) => !comment.isPlatformAuthored)
        .map((comment) => comment.body),
      truncatedComments: 0,
    }),

    writeBack: (_config, item, event) =>
      Promise.resolve({
        key: `${item.externalId}:${event.kind}`,
        disposition: 'performed',
        reference: 'fake-comment',
      }),
  }
}

export interface FakeConnectorRegistry extends IntegrationConnectorRegistry {
  /** Every request, so a test can assert the credential ARN was passed and the config was not it. */
  readonly requests: readonly ConnectorRequest[]
}

export const createFakeConnectorRegistry = (
  connector?: IntegrationConnector<unknown>,
): FakeConnectorRegistry => {
  const requests: ConnectorRequest[] = []

  return {
    requests,
    connectorFor: (request) => {
      requests.push(request)
      return Promise.resolve(connector)
    },
  }
}

export interface FakePromptLayering extends PromptLayering {
  readonly inputs: readonly PromptLayeringInput[]
}

/**
 * A layering fake that renders the three layers in FR-159's order and nothing else.
 *
 * It is not a second implementation of assembly — the ordering, delimiting, bounding and redaction
 * are asserted where they live, in the control plane. What this exists for is to let the router's
 * tests assert that the **right layers** reached the assembler: the resolved profile's preamble,
 * the integration's intro, and the ticket the caller asked about.
 */
export const createFakePromptLayering = (): FakePromptLayering => {
  const inputs: PromptLayeringInput[] = []

  return {
    inputs,
    assemble: (input) => {
      inputs.push(input)
      return {
        prompt: [input.preamble ?? '', input.intro, input.parts.title, input.parts.url]
          .filter((layer) => layer.length > 0)
          .join('\n\n'),
        truncated: input.parts.truncatedComments > 0,
        truncatedComments: input.parts.truncatedComments,
      }
    },
  }
}
