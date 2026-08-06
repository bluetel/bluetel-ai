import { describe, expect, it } from 'vitest'

import {
  readTestDatabaseUrl,
  scratchDatabaseName,
  TEST_DATABASE_URL_VARIABLE,
  withDatabaseName,
} from './workflow-fixtures'

/**
 * The pure parts of the harness, which are the parts that decide whether the live suites run at
 * all — and which therefore have to work on a machine with no database.
 */

describe('the live-database harness', () => {
  it('reads the configured connection string', () => {
    expect(readTestDatabaseUrl({ [TEST_DATABASE_URL_VARIABLE]: ' postgres://x/y ' })).toBe(
      'postgres://x/y',
    )
  })

  it('treats absent and blank alike, so a suite skips rather than failing to connect', () => {
    expect(readTestDatabaseUrl({})).toBeUndefined()
    expect(readTestDatabaseUrl({ [TEST_DATABASE_URL_VARIABLE]: '   ' })).toBeUndefined()
  })

  it('redirects a connection string at a scratch database, keeping credentials and port', () => {
    expect(
      withDatabaseName('postgres://sisyphus:sisyphus@localhost:55432/sisyphus_test', 'scratch_1'),
    ).toBe('postgres://sisyphus:sisyphus@localhost:55432/scratch_1')
  })

  it('produces an unquotable database name from any suffix', () => {
    expect(scratchDatabaseName('a1b2-C3!')).toBe('sisyphus_control_plane_a1b23')
    expect(scratchDatabaseName('deadbeef')).toMatch(/^[a-z0-9_]+$/)
  })
})
