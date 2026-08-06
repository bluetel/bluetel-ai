import { describe, expect, it } from 'vitest'

import { integrationScratchDatabaseName, integrationTestDatabaseUrl } from './integration-fixtures'
import { TEST_DATABASE_URL_VARIABLE } from './workflow-fixtures'

/**
 * The pure parts of the integration harness — the parts that decide whether the live suites run,
 * and which therefore have to work on a machine with no database.
 */
describe('the integration fixture harness', () => {
  it('produces an unquotable database name from any suffix', () => {
    expect(integrationScratchDatabaseName('a1b2-C3!')).toBe('sisyphus_integration_a1b23')
    expect(integrationScratchDatabaseName('deadbeef')).toMatch(/^[a-z0-9_]+$/)
  })

  it('reads the same variable the rest of the live suites do, so one export runs them all', () => {
    const configured = process.env[TEST_DATABASE_URL_VARIABLE]?.trim()

    expect(integrationTestDatabaseUrl()).toBe(
      configured === undefined || configured === '' ? undefined : configured,
    )
  })
})
