import { getTableName, is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

import * as db from './index'
import { SISYPHUS_SCHEMA_VERSION } from './index'

const exported: Record<string, unknown> = { ...db }

const tables = Object.values(exported).filter((value): value is PgTable => is(value, PgTable))

describe('SISYPHUS_SCHEMA_VERSION', () => {
  it('is a positive integer, so it can be compared against the recorded version', () => {
    expect(Number.isInteger(SISYPHUS_SCHEMA_VERSION)).toBe(true)
    expect(SISYPHUS_SCHEMA_VERSION).toBeGreaterThanOrEqual(1)
  })
})

describe('the db barrel', () => {
  it('exposes the client factory, so consumers never import the driver themselves', () => {
    expect(typeof db.createDatabaseClient).toBe('function')
    expect(typeof db.getDatabaseClient).toBe('function')
    expect(typeof db.resetDatabaseClient).toBe('function')
  })

  it('does NOT expose the migration runner', async () => {
    // The runner locates its SQL with `new URL('.', import.meta.url)`, which a bundler cannot
    // resolve statically. Re-exporting it here drags migration tooling into every consumer that
    // only wanted a table definition — which is exactly how the panel's build broke once. It lives
    // behind `./db/migrations` instead; the assertion below is the guard against it creeping back.
    expect(db).not.toHaveProperty('runMigrations')
    expect(db).not.toHaveProperty('assertForwardOnly')

    const migrations = await import('./migrations')
    expect(typeof migrations.runMigrations).toBe('function')
    expect(typeof migrations.assertForwardOnly).toBe('function')
  })

  it('re-exports every table in the data model', () => {
    const expected = [
      'agentCredentials',
      'artifacts',
      // Auth.js adapter storage. Listed here for the same reason as everything else: the barrel is
      // what drizzle-kit generates migrations from, so a table missing from it does not exist.
      'authAccounts',
      'authSessions',
      'authVerificationTokens',
      'bootstrapPhases',
      'computeLeases',
      'configurationAudit',
      'corrections',
      'credentialGroups',
      'credentialLeases',
      'executionProfiles',
      'executionProfileVersions',
      'externalActions',
      'integrationMappings',
      'integrationRuns',
      'integrations',
      'iterations',
      'keepAliveRuns',
      'logSegments',
      'notificationPreferences',
      'notifications',
      'profileAccessGrants',
      'profileCredentialGroups',
      'profileOverrides',
      'reviewFindings',
      'roleChanges',
      'scopedCredentials',
      'sessionSnapshots',
      'setupBundles',
      'setupBundleVersions',
      'skillReferences',
      'supervisionCommands',
      'ticketClaims',
      'users',
      'validationCredentials',
      'validationRuns',
      'workflowEntries',
      'workflowEvents',
      'workflowWatchers',
      'workflows',
      'workspaceEntries',
      'workspaces',
      'workspaceVersions',
    ]
    for (const name of expected) {
      expect(Object.keys(db)).toContain(name)
    }
    expect(tables.length).toBe(expected.length)
  })

  it('names every table in snake_case, matching the data model', () => {
    for (const table of tables) {
      expect(getTableName(table)).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  it('gives every table a distinct name', () => {
    const names = tables.map((table) => getTableName(table))
    expect(new Set(names).size).toBe(names.length)
  })
})
