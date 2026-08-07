import { getTableConfig, pgTable } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

import {
  bigIntColumn,
  citext,
  createdAtColumn,
  disabledByDefaultColumn,
  idColumn,
  moneyColumn,
  timestampColumn,
  updatedAtColumn,
} from './columns'

const probe = pgTable('columns_probe', {
  id: idColumn(),
  email: citext('email').notNull(),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
  endedAt: timestampColumn('ended_at'),
  spend: moneyColumn('spend_used'),
  size: bigIntColumn('size_bytes'),
  enabled: disabledByDefaultColumn('enabled'),
})

const columnsByName = new Map(getTableConfig(probe).columns.map((column) => [column.name, column]))

const columnNamed = (name: string) => {
  const column = columnsByName.get(name)
  if (column === undefined) throw new Error(`no column named ${name}`)
  return column
}

describe('column helpers', () => {
  it('makes id a uuid primary key with a v7 default generated in the application', () => {
    const id = columnNamed('id')
    expect(id.getSQLType()).toBe('uuid')
    expect(id.primary).toBe(true)
    expect(id.notNull).toBe(true)
    const generated: unknown = id.defaultFn?.()
    expect(generated).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it('gives distinct ids on successive calls', () => {
    const id = columnNamed('id')
    expect(id.defaultFn?.()).not.toBe(id.defaultFn?.())
  })

  it('emits citext, so an address differing only in case is the same address', () => {
    expect(columnNamed('email').getSQLType()).toBe('citext')
  })

  it('keeps every timestamp in UTC with a zone', () => {
    for (const name of ['created_at', 'updated_at', 'ended_at']) {
      expect(columnNamed(name).getSQLType()).toBe('timestamp with time zone')
    }
  })

  it('defaults created_at and updated_at at the database, not the caller', () => {
    expect(columnNamed('created_at').hasDefault).toBe(true)
    expect(columnNamed('updated_at').hasDefault).toBe(true)
  })

  it('leaves an explicitly-named timestamp nullable so "has not happened yet" is representable', () => {
    expect(columnNamed('ended_at').notNull).toBe(false)
  })

  it('stores money as numeric(12,4) and never as a float', () => {
    const spend = columnNamed('spend_used')
    expect(spend.getSQLType()).toBe('numeric(12, 4)')
    expect(spend.getSQLType()).not.toContain('double')
  })

  it('uses bigint for counters that outgrow 32 bits', () => {
    expect(columnNamed('size_bytes').getSQLType()).toBe('bigint')
  })

  it('makes an opt-in flag notNull and false by default', () => {
    const enabled = columnNamed('enabled')
    expect(enabled.getSQLType()).toBe('boolean')
    expect(enabled.notNull).toBe(true)
    expect(enabled.default).toBe(false)
  })
})
