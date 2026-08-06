import type {
  CandidateItem,
  DiscoverContext,
  ExternalActionResult,
  IntegrationConnector,
  IntegrationMapping,
  MappingResolution,
  PromptParts,
  ValidationResult,
  WriteBackEvent,
} from '@bluetel-ai/sisyphus-api/contracts'

import type { ConnectorFactory } from './connector-registry'

/**
 * A recording connector, for the control plane's own tests.
 *
 * It implements {@link IntegrationConnector} and knows nothing about any board — which is the point.
 * Every assertion the tick, the health tracker and the schedule sync make is about *control-plane*
 * behaviour: that the claim and the workflow land in one transaction, that a ceiling defers rather
 * than drops, that a skip is commented on exactly once. Driving those against a Jira connector
 * would make them tests of Jira, and would put the control plane one import away from a package
 * FR-192 says it must never name.
 *
 * The Jira package ships its own fake for its own tests (`createFakeJiraClient`); this is the
 * complementary one, on the other side of the contract.
 *
 * Not exported from `src/jobs/index.ts`: it is test support, and a barrel entry would put a fake
 * connector one import away from a job.
 */

export interface FakeConnectorOptions {
  readonly type?: IntegrationConnector<unknown>['type']
  readonly items?: readonly CandidateItem[]
  /** Thrown by `discover`, which is how an unreachable board is expressed (FR-108). */
  readonly discoverError?: Error
  /** Thrown by `writeBack`, so a comment failure can be shown not to lose the run. */
  readonly writeBackError?: Error
  readonly validation?: ValidationResult
  /** Overrides first-match resolution, for the no-mapping case. */
  readonly resolution?: (item: CandidateItem) => MappingResolution
  readonly parts?: (item: CandidateItem) => PromptParts
}

export interface RecordedWriteBack {
  readonly externalId: string
  readonly event: WriteBackEvent
}

export interface FakeConnector extends IntegrationConnector<unknown> {
  readonly discoveries: readonly DiscoverContext[]
  readonly writeBacks: readonly RecordedWriteBack[]
  readonly configs: readonly unknown[]
}

/** Deterministic first-match over `position`, mirroring what a real connector must do (FR-130). */
const firstMatch = (
  item: CandidateItem,
  mappings: readonly IntegrationMapping[],
): MappingResolution => {
  const ordered = [...mappings].sort((left, right) => left.position - right.position)

  for (const mapping of ordered) {
    const matched = Object.entries(mapping.criteria).every(([key, value]) => {
      const attribute = item.attributes[key]
      if (Array.isArray(attribute)) {
        return attribute.includes(String(value))
      }
      return attribute === String(value)
    })

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

export const createFakeConnector = (options: FakeConnectorOptions = {}): FakeConnector => {
  const discoveries: DiscoverContext[] = []
  const writeBacks: RecordedWriteBack[] = []
  const configs: unknown[] = []

  return {
    type: options.type ?? 'jira',
    discoveries,
    writeBacks,
    configs,

    validate: (config) => {
      configs.push(config)
      return Promise.resolve(options.validation ?? { ok: true, checks: [] })
    },

    discover: (config, ctx) => {
      configs.push(config)
      discoveries.push(ctx)
      if (options.discoverError) {
        return Promise.reject(options.discoverError)
      }
      return Promise.resolve(options.items ?? [])
    },

    resolveProfile: (item, mappings) =>
      options.resolution === undefined ? firstMatch(item, mappings) : options.resolution(item),

    assemblePromptParts: (item: CandidateItem): PromptParts =>
      options.parts === undefined
        ? {
            title: item.title,
            url: item.url,
            body: item.body,
            comments: item.comments
              .filter((comment) => !comment.isPlatformAuthored)
              .map((comment) => comment.body),
            truncatedComments: 0,
          }
        : options.parts(item),

    writeBack: (config, item, event): Promise<ExternalActionResult> => {
      configs.push(config)
      if (options.writeBackError) {
        return Promise.reject(options.writeBackError)
      }
      writeBacks.push({ externalId: item.externalId, event })
      return Promise.resolve({
        key: `${item.externalId}:${event.kind}`,
        disposition: 'performed',
        reference: `comment-${String(writeBacks.length)}`,
      })
    },
  }
}

/** The fake, as a registry entry. */
export const fakeConnectorFactory =
  (connector: IntegrationConnector<unknown>): ConnectorFactory =>
  () =>
    connector

/** A candidate item with everything filled in, so a test only states what it is about. */
export const fakeCandidate = (overrides: Partial<CandidateItem> = {}): CandidateItem => ({
  externalId: 'FIX-1',
  title: 'Checkout totals are wrong for multi-currency baskets',
  url: 'https://example.invalid/browse/FIX-1',
  body: 'The basket adds VAT twice when the currency is not GBP.',
  assigneeEmail: null,
  comments: [],
  attributes: {},
  ...overrides,
})
