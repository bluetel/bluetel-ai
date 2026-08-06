import { describe, expect, it } from 'vitest'

import { columnOf, describeTable, indexOf, referencedTables } from './introspect'

import { computeLeases, iterations, users, workflows } from './index'

describe('describeTable', () => {
  it('reports the table name', () => {
    expect(describeTable(users).name).toBe('users')
  })

  it('reports column types as they will appear in the migration', () => {
    expect(columnOf(workflows, 'spend_used').type).toBe('numeric(12, 4)')
    expect(columnOf(users, 'email').type).toBe('citext')
  })

  it('reports notNull, primary key and defaults', () => {
    expect(columnOf(users, 'id').primaryKey).toBe(true)
    expect(columnOf(users, 'google_subject').notNull).toBe(true)
    expect(columnOf(users, 'slack_user_id').notNull).toBe(false)
    expect(columnOf(users, 'role').defaultValue).toBe('engineer')
  })

  it('serialises a partial index predicate to SQL, not to an opaque object', () => {
    const index = indexOf(computeLeases, 'compute_leases_live_key')
    expect(index.where).toBe('"compute_leases"."released_at" is null')
  })

  it('reports a full index as having no predicate', () => {
    expect(indexOf(workflows, 'workflows_owner_state_idx').where).toBeUndefined()
  })

  it('distinguishes unique from non-unique indexes', () => {
    expect(indexOf(computeLeases, 'compute_leases_live_key').unique).toBe(true)
    expect(indexOf(computeLeases, 'compute_leases_unreleased_idx').unique).toBe(false)
  })

  it('serialises check constraints', () => {
    expect(describeTable(iterations).checks).toStrictEqual([
      { name: 'iterations_ordinal_bounds', expression: '"iterations"."ordinal" between 1 and 3' },
    ])
  })

  it('resolves foreign keys to their target table and column', () => {
    expect(describeTable(iterations).foreignKeys).toStrictEqual([
      { columns: ['workflow_id'], foreignTable: 'workflows', foreignColumns: ['id'] },
    ])
  })

  it('deduplicates referenced tables', () => {
    expect(referencedTables(users)).toStrictEqual([])
    expect(referencedTables(computeLeases)).toStrictEqual(['workflows'])
  })
})

describe('the lookup helpers', () => {
  it('fail loudly and list what does exist, rather than returning undefined', () => {
    expect(() => columnOf(users, 'nope')).toThrow(/users has no column "nope".*email/s)
    expect(() => indexOf(users, 'nope')).toThrow(/users has no index "nope".*users_email_key/s)
  })
})
