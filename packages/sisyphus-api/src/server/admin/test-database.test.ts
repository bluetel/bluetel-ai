import { describe, expect, it } from 'vitest'

import { readTestDatabaseUrl, TEST_DATABASE_URL_VARIABLE } from './test-database'

/**
 * The skip gate is the part of the harness that is worth its own test: everything else in
 * `./test-database.ts` needs a database to mean anything, but this decides whether the live suites
 * run at all. Getting it wrong makes `vitest run` fail on every machine without Postgres — or,
 * worse in the other direction, makes the live suites silently skip in CI where they are the whole
 * point.
 */
describe('readTestDatabaseUrl', () => {
  it('reads the documented variable', () => {
    expect(TEST_DATABASE_URL_VARIABLE).toBe('SISYPHUS_TEST_DATABASE_URL')
    expect(
      readTestDatabaseUrl({ SISYPHUS_TEST_DATABASE_URL: 'postgres://user@host:5432/db' }),
    ).toBe('postgres://user@host:5432/db')
  })

  it('reports an absent variable as undefined so the suite can skip', () => {
    expect(readTestDatabaseUrl({})).toBeUndefined()
  })

  it('treats a blank value as absent rather than connecting to nothing', () => {
    // A variable exported as '' in CI is a misconfiguration. Connecting would fail with an error
    // about the URL instead of the message that says the database was never configured.
    expect(readTestDatabaseUrl({ SISYPHUS_TEST_DATABASE_URL: '' })).toBeUndefined()
    expect(readTestDatabaseUrl({ SISYPHUS_TEST_DATABASE_URL: '   ' })).toBeUndefined()
  })

  it('trims, so a trailing newline from a shell pipeline does not reach the driver', () => {
    expect(readTestDatabaseUrl({ SISYPHUS_TEST_DATABASE_URL: ' postgres://x/y\n' })).toBe(
      'postgres://x/y',
    )
  })
})
