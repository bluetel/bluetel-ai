import { describe, expect, it } from 'vitest'

import { buildFixtureIdentifiers, SPIKE_TAG_PREFIX } from './spike-fixture'

/**
 * The seeding functions themselves need a live database and are exercised by the gated live suite
 * in `spike-log-stream.test.ts`. What is worth asserting without one is that the identifiers are
 * unique and tagged — an untagged or colliding fixture is how a spike leaves rows behind.
 */
describe('buildFixtureIdentifiers', () => {
  it('tags every run so stray rows are identifiable', () => {
    expect(buildFixtureIdentifiers().tag.startsWith(`${SPIKE_TAG_PREFIX}-`)).toBe(true)
  })

  it('produces distinct identifiers within one fixture', () => {
    const identifiers = buildFixtureIdentifiers()
    const ids = [
      identifiers.userId,
      identifiers.setupBundleId,
      identifiers.setupBundleVersionId,
      identifiers.workspaceId,
      identifiers.workspaceVersionId,
    ]
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('produces distinct identifiers across runs, so two scenarios cannot collide', () => {
    expect(buildFixtureIdentifiers().userId).not.toBe(buildFixtureIdentifiers().userId)
  })
})
