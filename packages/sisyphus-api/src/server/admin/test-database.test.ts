import { describe, expect, it } from 'vitest'

import {
  CI_VARIABLE,
  createGate,
  MISSING_TEST_DATABASE_MESSAGE,
  readTestDatabaseUrl,
  TEST_DATABASE_URL_VARIABLE,
} from './test-database'

/**
 * The skip gate is the part of the harness that is worth its own test: everything else in
 * `./test-database.ts` needs a database to mean anything, but this decides whether the live suites
 * run at all. Getting it wrong makes `vitest run` fail on every machine without Postgres — or,
 * worse in the other direction, makes the live suites silently skip in CI where they are the whole
 * point.
 *
 * Three cases, and all three matter (FR-204, SC-064):
 *
 * | `SISYPHUS_TEST_DATABASE_URL` | `CI` | outcome |
 * | ---------------------------- | ---- | ------- |
 * | present                      | any  | run     |
 * | absent                       | no   | skip    |
 * | absent                       | yes  | **fail**|
 */
describe('readTestDatabaseUrl', () => {
  it('reads the documented variable', () => {
    expect(TEST_DATABASE_URL_VARIABLE).toBe('SISYPHUS_TEST_DATABASE_URL')
    expect(CI_VARIABLE).toBe('CI')
    expect(
      readTestDatabaseUrl({ SISYPHUS_TEST_DATABASE_URL: 'postgres://user@host:5432/db' }),
    ).toBe('postgres://user@host:5432/db')
  })

  it('runs the suite when the variable is present, in CI as much as anywhere else', () => {
    expect(readTestDatabaseUrl({ SISYPHUS_TEST_DATABASE_URL: 'postgres://x/y', CI: 'true' })).toBe(
      'postgres://x/y',
    )
  })

  it('reports an absent variable as undefined so the suite can skip off CI', () => {
    expect(readTestDatabaseUrl({})).toBeUndefined()
  })

  it('treats a blank value as absent rather than connecting to nothing', () => {
    // A variable exported as '' is a misconfiguration. Connecting would fail with an error about
    // the URL instead of the message that says the database was never configured.
    expect(readTestDatabaseUrl({ SISYPHUS_TEST_DATABASE_URL: '' })).toBeUndefined()
    expect(readTestDatabaseUrl({ SISYPHUS_TEST_DATABASE_URL: '   ' })).toBeUndefined()
  })

  it('trims, so a trailing newline from a shell pipeline does not reach the driver', () => {
    expect(readTestDatabaseUrl({ SISYPHUS_TEST_DATABASE_URL: ' postgres://x/y\n' })).toBe(
      'postgres://x/y',
    )
  })

  it('fails rather than skips when the variable is absent in CI', () => {
    // The whole point of FR-204: a database-backed test must not pass by not running. Throwing
    // here happens at the importing suite's module scope, so vitest reports the file as failed
    // rather than as a directory of skipped tests nobody reads.
    expect(() => readTestDatabaseUrl({ CI: 'true' })).toThrow(MISSING_TEST_DATABASE_MESSAGE)
    expect(() => readTestDatabaseUrl({ CI: '1' })).toThrow(/is not set/)
    expect(() => readTestDatabaseUrl({ CI: 'true', SISYPHUS_TEST_DATABASE_URL: '  ' })).toThrow(
      /is not set/,
    )
  })

  it('names both variables and where to fix it, so the failure is actionable', () => {
    expect(MISSING_TEST_DATABASE_MESSAGE).toContain(TEST_DATABASE_URL_VARIABLE)
    expect(MISSING_TEST_DATABASE_MESSAGE).toContain('.github/workflows/ci.yml')
  })

  it('does not read CI=false or CI=0 as CI, which some shells export unconditionally', () => {
    expect(readTestDatabaseUrl({ CI: 'false' })).toBeUndefined()
    expect(readTestDatabaseUrl({ CI: 'FALSE' })).toBeUndefined()
    expect(readTestDatabaseUrl({ CI: '0' })).toBeUndefined()
    expect(readTestDatabaseUrl({ CI: '' })).toBeUndefined()
    expect(readTestDatabaseUrl({ CI: '   ' })).toBeUndefined()
  })
})

/**
 * The gate the concurrency suites hold a transaction open with. Small, but a broken one would not
 * fail loudly: a gate that resolved immediately would turn every "the edit landed mid-run" test
 * into the sequential test it exists to replace, and it would still be green.
 */
describe('createGate', () => {
  it('stays unresolved until it is opened', async () => {
    const gate = createGate()
    let opened = false
    void gate.opened.then(() => {
      opened = true
    })

    await Promise.resolve()
    expect(opened).toBe(false)

    gate.open()
    await gate.opened
    expect(opened).toBe(true)
  })

  it('stays open once opened, however many times it is called', async () => {
    const gate = createGate()
    gate.open()
    gate.open()

    await expect(gate.opened).resolves.toBeUndefined()
  })
})
