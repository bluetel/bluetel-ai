import { describe, expect, it } from 'vitest'

import type { CandidateItem } from '../../contracts'

import {
  createFakeConnectorRegistry,
  createFakeIntegrationConnector,
  createFakePromptLayering,
} from './integration-connectors-fake'

const item = (overrides: Partial<CandidateItem> = {}): CandidateItem => ({
  externalId: 'FIX-1',
  title: 'Checkout totals are wrong',
  url: 'https://boards.invalid/browse/FIX-1',
  body: 'The basket adds VAT twice.',
  assigneeEmail: null,
  comments: [],
  attributes: {},
  ...overrides,
})

describe('createFakeIntegrationConnector', () => {
  it('records the configs it was asked to validate', async () => {
    const connector = createFakeIntegrationConnector()
    await connector.validate({ projectPrefix: 'FIX' })

    expect(connector.validatedConfigs).toEqual([{ projectPrefix: 'FIX' }])
  })

  it('reports the verdict it was seeded with, rather than always passing', async () => {
    const connector = createFakeIntegrationConnector({
      validation: { ok: false, checks: [{ name: 'connectivity', ok: false, detail: 'refused' }] },
    })

    expect((await connector.validate({})).ok).toBe(false)
  })

  it('expresses an unreachable board as a rejection', async () => {
    const connector = createFakeIntegrationConnector({ discoverError: new Error('unreachable') })

    await expect(connector.discover({}, {})).rejects.toThrow('unreachable')
  })

  it('resolves first-match by position and never guesses', () => {
    const connector = createFakeIntegrationConnector()

    expect(
      connector.resolveProfile(item({ attributes: { issueType: 'Story' } }), [
        {
          id: 'm1',
          position: 0,
          criteria: { issueType: 'Bug' },
          executionProfileId: 'p',
          isDefault: false,
        },
      ]),
    ).toEqual({ matched: false, reason: 'no_mapping_matched' })
  })

  it('excludes platform-authored comments from the parts (FR-161)', () => {
    const parts = connector().assemblePromptParts(
      item({
        comments: [
          {
            id: '1',
            authorIdentity: 'sisyphus',
            isPlatformAuthored: true,
            body: 'mine',
            createdAt: new Date(0),
          },
          {
            id: '2',
            authorIdentity: 'human',
            isPlatformAuthored: false,
            body: 'theirs',
            createdAt: new Date(0),
          },
        ],
      }),
      {},
    )

    expect(parts.comments).toEqual(['theirs'])
  })
})

const connector = () => createFakeIntegrationConnector()

describe('createFakeConnectorRegistry', () => {
  it('records every request, including the credential reference', async () => {
    const registry = createFakeConnectorRegistry(connector())

    await registry.connectorFor({
      type: 'jira',
      config: { projectPrefix: 'FIX' },
      credentialSecretArn: 'arn:fixture',
      baseUrl: 'https://boards.invalid',
    })

    expect(registry.requests[0].credentialSecretArn).toBe('arn:fixture')
  })

  it('produces nothing when built without a connector, like the refusing registry', async () => {
    const registry = createFakeConnectorRegistry()

    expect(
      await registry.connectorFor({
        type: 'jira',
        config: {},
        credentialSecretArn: 'arn:fixture',
        baseUrl: 'https://boards.invalid',
      }),
    ).toBeUndefined()
  })
})

describe('createFakePromptLayering', () => {
  it('records the layers it was handed, which is what the router tests assert on', () => {
    const layering = createFakePromptLayering()

    layering.assemble({
      preamble: 'Preamble.',
      intro: 'Intro.',
      parts: {
        title: 'A ticket',
        url: 'https://boards.invalid/browse/FIX-1',
        body: null,
        comments: [],
        truncatedComments: 2,
      },
    })

    expect(layering.inputs[0].preamble).toBe('Preamble.')
    expect(layering.inputs[0].intro).toBe('Intro.')
  })

  it('reports truncation from the parts rather than inventing it', () => {
    const layering = createFakePromptLayering()

    const result = layering.assemble({
      preamble: null,
      intro: 'Intro.',
      parts: {
        title: 'A ticket',
        url: 'https://boards.invalid/browse/FIX-1',
        body: null,
        comments: [],
        truncatedComments: 3,
      },
    })

    expect(result).toMatchObject({ truncated: true, truncatedComments: 3 })
  })
})
