import { describe, expect, it } from 'vitest'

import {
  createNotifyFixtures,
  readTestDatabaseUrl,
  scratchDatabaseName,
  TEST_DATABASE_URL_VARIABLE,
  withDatabaseName,
} from './notify-fixtures'

/**
 * The fixture's own guard rails, tested without a database.
 *
 * The skip decision is the one worth asserting: it is what keeps `vitest run` green on a machine
 * with no Postgres, and a regression in it turns every live suite in this directory into a
 * connection error rather than a skip.
 */

describe('readTestDatabaseUrl', () => {
  it('reads the configured variable', () => {
    expect(readTestDatabaseUrl({ [TEST_DATABASE_URL_VARIABLE]: 'postgres://host/db' })).toBe(
      'postgres://host/db',
    )
  })

  it('treats absent, empty and whitespace-only as absent', () => {
    // An empty string exported in CI is a misconfiguration, and connecting to it fails with an
    // error about the URL rather than one saying the database was not configured.
    expect(readTestDatabaseUrl({})).toBeUndefined()
    expect(readTestDatabaseUrl({ [TEST_DATABASE_URL_VARIABLE]: '' })).toBeUndefined()
    expect(readTestDatabaseUrl({ [TEST_DATABASE_URL_VARIABLE]: '   ' })).toBeUndefined()
  })
})

describe('withDatabaseName', () => {
  it('points the same server at a different database', () => {
    expect(withDatabaseName('postgres://user:pass@host:5432/main', 'scratch')).toContain('/scratch')
  })
})

describe('scratchDatabaseName', () => {
  it('produces an unquoted identifier from an arbitrary suffix', () => {
    expect(scratchDatabaseName('a1-b2_C3')).toBe('sisyphus_notify_a1b23')
    expect(scratchDatabaseName('abc')).toMatch(/^[a-z0-9_]+$/)
  })
})

describe('the scope refuses to be used before it is open', () => {
  it('fails with a message naming the mistake rather than a null dereference', async () => {
    const fixture = createNotifyFixtures('postgres://user:pass@host:5432/main')

    await expect(fixture.readNotifications()).rejects.toThrow(
      'The fixture scope was used before open() or after close().',
    )
  })
})
