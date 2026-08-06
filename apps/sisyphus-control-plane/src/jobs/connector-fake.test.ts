import type { IntegrationMapping } from '@bluetel-ai/sisyphus-api/contracts'
import { describe, expect, it } from 'vitest'

import { createFakeConnector, fakeCandidate, fakeConnectorFactory } from './connector-fake'

const mapping = (overrides: Partial<IntegrationMapping> = {}): IntegrationMapping => ({
  id: 'mapping-1',
  position: 0,
  criteria: {},
  executionProfileId: 'profile-1',
  isDefault: false,
  ...overrides,
})

describe('createFakeConnector', () => {
  it('records the discovery context, so a `since` assertion is possible', async () => {
    const connector = createFakeConnector()
    const since = new Date('2026-08-01T00:00:00Z')

    await connector.discover({}, { since })

    expect(connector.discoveries[0].since).toBe(since)
  })

  it('returns the items it was seeded with', async () => {
    const item = fakeCandidate({ externalId: 'FIX-9' })
    const connector = createFakeConnector({ items: [item] })

    expect(await connector.discover({}, {})).toEqual([item])
  })

  it('expresses an unreachable board as a rejection (FR-108)', async () => {
    const connector = createFakeConnector({ discoverError: new Error('board unreachable') })

    await expect(connector.discover({}, {})).rejects.toThrow('board unreachable')
  })

  it('resolves first-match by position, not by list order (FR-130)', () => {
    const connector = createFakeConnector()
    const resolution = connector.resolveProfile(
      fakeCandidate({ attributes: { issueType: 'Bug' } }),
      [
        mapping({
          id: 'second',
          position: 5,
          criteria: { issueType: 'Bug' },
          executionProfileId: 'b',
        }),
        mapping({
          id: 'first',
          position: 1,
          criteria: { issueType: 'Bug' },
          executionProfileId: 'a',
        }),
      ],
    )

    expect(resolution).toEqual({ matched: true, executionProfileId: 'a', mappingId: 'first' })
  })

  it('matches a multi-valued attribute by membership', () => {
    const connector = createFakeConnector()
    const resolution = connector.resolveProfile(
      fakeCandidate({ attributes: { components: ['checkout', 'billing'] } }),
      [mapping({ criteria: { components: 'billing' } })],
    )

    expect(resolution).toEqual({
      matched: true,
      executionProfileId: 'profile-1',
      mappingId: 'mapping-1',
    })
  })

  it('reports no match rather than guessing a profile (FR-130)', () => {
    const connector = createFakeConnector()

    expect(
      connector.resolveProfile(fakeCandidate(), [mapping({ criteria: { issueType: 'Bug' } })]),
    ).toEqual({ matched: false, reason: 'no_mapping_matched' })
  })

  it('falls through to a default mapping when one is configured', () => {
    const connector = createFakeConnector()

    expect(
      connector.resolveProfile(fakeCandidate(), [
        mapping({ id: 'catch-all', position: 9, isDefault: true, criteria: { issueType: 'Bug' } }),
      ]),
    ).toEqual({ matched: true, executionProfileId: 'profile-1', mappingId: 'catch-all' })
  })

  it('excludes platform-authored comments from the parts it assembles (FR-161)', () => {
    const connector = createFakeConnector()
    const parts = connector.assemblePromptParts(
      fakeCandidate({
        comments: [
          {
            id: '1',
            authorIdentity: 'sisyphus',
            isPlatformAuthored: true,
            body: 'picked up',
            createdAt: new Date(0),
          },
          {
            id: '2',
            authorIdentity: 'human',
            isPlatformAuthored: false,
            body: 'still broken',
            createdAt: new Date(0),
          },
        ],
      }),
      {},
    )

    expect(parts.comments).toEqual(['still broken'])
  })

  it('records every write-back with the item it was about', async () => {
    const connector = createFakeConnector()

    await connector.writeBack({}, fakeCandidate(), { kind: 'skipped', reason: 'ceiling_reached' })

    expect(connector.writeBacks).toEqual([
      { externalId: 'FIX-1', event: { kind: 'skipped', reason: 'ceiling_reached' } },
    ])
  })

  it('records nothing when the write-back throws, so a failed comment is not counted as one', async () => {
    const connector = createFakeConnector({
      writeBackError: new Error('jira rejected the comment'),
    })

    await expect(
      connector.writeBack({}, fakeCandidate(), { kind: 'skipped', reason: 'empty_item' }),
    ).rejects.toThrow()
    expect(connector.writeBacks).toEqual([])
  })
})

describe('fakeConnectorFactory', () => {
  it('returns the same connector however the registry builds it', () => {
    const connector = createFakeConnector()
    const factory = fakeConnectorFactory(connector)

    expect(factory({ config: {}, credential: 'a', baseUrl: 'https://x.invalid' })).toBe(connector)
  })
})

describe('fakeCandidate', () => {
  it('fills everything in, so a test states only what it is about', () => {
    expect(fakeCandidate()).toMatchObject({
      externalId: 'FIX-1',
      assigneeEmail: null,
      comments: [],
    })
  })
})
