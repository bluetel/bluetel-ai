import { getTableName, is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

import { describeTable } from './introspect'

import * as schema from './index'

const exported: Record<string, unknown> = { ...schema }

const tables = Object.values(exported).filter((value): value is PgTable => is(value, PgTable))

/** Tables the data model marks append-only: never mutated, so never carrying `updated_at`. */
const APPEND_ONLY = [
  'keep_alive_runs',
  'workflow_events',
  'corrections',
  'external_actions',
  'log_segments',
  'role_changes',
  'configuration_audit',
  'notifications',
  'integration_runs',
  'profile_access_grants',
]

/**
 * Auth.js's adapter storage. These three tables are the adapter's shape, not the platform's: it
 * addresses `sessions` by an opaque token and `accounts` by `(provider, provider_account_id)`, and
 * it neither writes nor reads a creation time. Bending them to the platform's conventions would
 * mean forking the adapter, so the conventions carve them out here instead — deliberately by an
 * explicit list, so a *new* platform table cannot slip past the same checks by accident.
 */
const AUTH_ADAPTER = ['auth_accounts', 'auth_sessions', 'auth_verification_tokens']

const platformTables = tables.filter((table) => !AUTH_ADAPTER.includes(getTableName(table)))

describe('the schema barrel', () => {
  it('exposes every aggregate, which is what drizzle-kit generates migrations from', () => {
    expect(tables.length).toBeGreaterThanOrEqual(35)
  })

  it('carries the credential pool, without which drizzle-kit would not generate its tables', () => {
    // Not a tidy-up: `drizzle.config.ts` points drizzle-kit at this file and nothing else, so a
    // table absent from here has no migration, and the five tables below would exist only in
    // TypeScript. Named individually rather than counted, because a count passes when the wrong
    // five are present.
    const names = tables.map((table) => getTableName(table))
    for (const name of [
      'credential_groups',
      'agent_credentials',
      'credential_leases',
      'profile_credential_groups',
      'keep_alive_runs',
    ]) {
      expect(names).toContain(name)
    }
  })

  it('carries the Auth.js adapter tables, without which sessions have nowhere to live', () => {
    const names = tables.map((table) => getTableName(table))
    for (const name of AUTH_ADAPTER) expect(names).toContain(name)
  })

  it('gives every platform table a uuid primary key named id', () => {
    for (const table of platformTables) {
      const primaries = describeTable(table).columns.filter((column) => column.primaryKey)
      expect(primaries.map((column) => column.name)).toStrictEqual(['id'])
      expect(primaries[0]?.type).toBe('uuid')
    }
  })

  it('generates every primary key in the application, so an id is known before the insert', () => {
    for (const table of platformTables) {
      expect(describeTable(table).columns.find((column) => column.primaryKey)?.hasDefault).toBe(
        true,
      )
    }
  })

  it('gives every platform table a created_at', () => {
    for (const table of platformTables) {
      const names = describeTable(table).columns.map((column) => column.name)
      const hasCreationTime = [
        'created_at',
        'requested_at',
        'started_at',
        'granted_at',
        'issued_at',
        'claimed_at',
        'recorded_at',
        // A lease is created by being acquired, and a keep-alive row by being run; both name the
        // event rather than the write, the same way `compute_leases.requested_at` does.
        'acquired_at',
        'ran_at',
      ].some((candidate) => names.includes(candidate))
      expect(hasCreationTime, `${getTableName(table)} records no creation time`).toBe(true)
    }
  })

  it('keeps every append-only table free of updated_at', () => {
    for (const table of tables) {
      if (!APPEND_ONLY.includes(getTableName(table))) continue
      expect(
        describeTable(table).columns.map((column) => column.name),
        `${getTableName(table)} is append-only`,
      ).not.toContain('updated_at')
    }
  })

  it('keeps every timestamp zone-aware, so nothing is stored in local time', () => {
    for (const table of tables) {
      for (const column of describeTable(table).columns) {
        if (!column.type.startsWith('timestamp')) continue
        expect(column.type, `${getTableName(table)}.${column.name}`).toBe(
          'timestamp with time zone',
        )
      }
    }
  })

  it('stores money as numeric(12, 4) everywhere it appears', () => {
    for (const table of tables) {
      for (const column of describeTable(table).columns) {
        if (!/^(spend_cap|spend_used|compute_cost_basis)$/.test(column.name)) continue
        expect(column.type, `${getTableName(table)}.${column.name}`).toBe('numeric(12, 4)')
      }
    }
  })

  it('never stores a payload in Postgres — only keys and digests', () => {
    for (const table of tables) {
      const names = describeTable(table).columns.map((column) => column.name)
      for (const forbidden of ['content', 'payload', 'archive', 'blob']) {
        expect(names, getTableName(table)).not.toContain(forbidden)
      }
    }
  })

  it('gives every index a distinct name across the whole schema', () => {
    const names = tables.flatMap((table) => describeTable(table).indexes.map((index) => index.name))
    expect(new Set(names).size).toBe(names.length)
  })

  it('points every foreign key at a table that is in the barrel', () => {
    const known = new Set(tables.map((table) => getTableName(table)))
    for (const table of tables) {
      for (const foreignKey of describeTable(table).foreignKeys) {
        expect(known, `${getTableName(table)} -> ${foreignKey.foreignTable}`).toContain(
          foreignKey.foreignTable,
        )
      }
    }
  })
})
