import { describe, expect, it } from 'vitest'

import {
  createGate,
  readTestDatabaseUrl,
  scratchDatabaseName,
  TEST_DATABASE_URL_VARIABLE,
  withDatabaseName,
} from './pool-fixtures'

/**
 * The pure parts of the harness — which are the parts that decide whether the live suites run at
 * all, and which therefore have to work on a machine with no database.
 *
 * There is nothing here about credentials. That is the point: if this file needed a Postgres to
 * prove the skip decision is right, the skip decision could not be trusted on a laptop where the
 * skip is what happens.
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
    expect(scratchDatabaseName('a1b2-C3!')).toBe('sisyphus_credential_pool_a1b23')
    expect(scratchDatabaseName('deadbeef')).toMatch(/^[a-z0-9_]+$/)
  })

  it('names a database nothing else in the workspace would collide with', () => {
    // Three fixture harnesses now create scratch databases on the same server, and two suites that
    // agreed on a name would drop each other's database mid-run — a failure that would present as
    // an unrelated query erroring on a missing table.
    expect(scratchDatabaseName('abc')).not.toMatch(/^sisyphus_users_|^sisyphus_control_plane_/)
  })
})

describe('the gate', () => {
  it('stays closed until it is opened', async () => {
    const gate = createGate()
    let settled = false
    const waiting = gate.opened.then(() => {
      settled = true
    })

    // A microtask turn is enough for an already-resolved promise to have settled; this one has not
    // been opened, so it must not have.
    await Promise.resolve()
    expect(settled).toBe(false)

    gate.open()
    await waiting
    expect(settled).toBe(true)
  })

  it('is idempotent, so a test that releases twice does not throw in a finally', async () => {
    const gate = createGate()
    gate.open()
    gate.open()
    await expect(gate.opened).resolves.toBeUndefined()
  })
})
