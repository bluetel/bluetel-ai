import { getTableName } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core'

/**
 * Read a table's shape back out of Drizzle's own metadata.
 *
 * This is how the schema is tested. Asserting over metadata rather than over a live database means
 * "does `compute_leases` still carry the partial unique index that makes FR-078 hold" is answered
 * by `vitest run` on a laptop with no Postgres — and answered against the *definition* the
 * migration is generated from, not against whatever happens to be in a developer's database.
 */

const dialect = new PgDialect()

export interface ColumnShape {
  readonly name: string
  /** The SQL type as it will appear in the migration, e.g. `numeric(12, 4)`. */
  readonly type: string
  readonly notNull: boolean
  readonly primaryKey: boolean
  readonly hasDefault: boolean
  /** A literal default, when there is one. SQL and function defaults report `undefined`. */
  readonly defaultValue: unknown
}

export interface IndexShape {
  readonly name: string
  readonly unique: boolean
  readonly columns: readonly string[]
  /** The partial-index predicate as SQL, or `undefined` for a full index. */
  readonly where: string | undefined
}

export interface ForeignKeyShape {
  readonly columns: readonly string[]
  readonly foreignTable: string
  readonly foreignColumns: readonly string[]
}

export interface CheckShape {
  readonly name: string
  readonly expression: string
}

export interface TableShape {
  readonly name: string
  readonly columns: readonly ColumnShape[]
  readonly indexes: readonly IndexShape[]
  readonly foreignKeys: readonly ForeignKeyShape[]
  readonly checks: readonly CheckShape[]
}

/** Describe a table completely enough to assert every constraint the data model requires. */
export const describeTable = (table: PgTable): TableShape => {
  const config = getTableConfig(table)
  return {
    name: getTableName(table),
    columns: config.columns.map((column) => ({
      name: column.name,
      type: column.getSQLType(),
      notNull: column.notNull,
      primaryKey: column.primary,
      hasDefault: column.hasDefault,
      defaultValue: column.default,
    })),
    indexes: config.indexes.map((index) => ({
      // Every index in this schema is explicitly named; `(unnamed)` would mean one was not.
      name: index.config.name ?? '(unnamed)',
      unique: index.config.unique,
      columns: index.config.columns.map((column) =>
        'name' in column ? (column.name ?? '(expression)') : '(expression)',
      ),
      where:
        index.config.where === undefined ? undefined : dialect.sqlToQuery(index.config.where).sql,
    })),
    foreignKeys: config.foreignKeys.map((foreignKey) => {
      const reference = foreignKey.reference()
      return {
        columns: reference.columns.map((column) => column.name),
        foreignTable: getTableName(reference.foreignTable),
        foreignColumns: reference.foreignColumns.map((column) => column.name),
      }
    }),
    checks: config.checks.map((check) => ({
      name: check.name,
      expression: dialect.sqlToQuery(check.value).sql,
    })),
  }
}

/** Find one column by its database name, failing loudly rather than returning `undefined`. */
export const columnOf = (table: PgTable, name: string): ColumnShape => {
  const shape = describeTable(table)
  const column = shape.columns.find((candidate) => candidate.name === name)
  if (column === undefined) {
    throw new Error(
      `${shape.name} has no column "${name}"; it has ${shape.columns.map((c) => c.name).join(', ')}`,
    )
  }
  return column
}

/** Find one index by name, failing loudly rather than returning `undefined`. */
export const indexOf = (table: PgTable, name: string): IndexShape => {
  const shape = describeTable(table)
  const index = shape.indexes.find((candidate) => candidate.name === name)
  if (index === undefined) {
    throw new Error(
      `${shape.name} has no index "${name}"; it has ${shape.indexes.map((i) => i.name).join(', ')}`,
    )
  }
  return index
}

/** The tables a table points at, deduplicated. */
export const referencedTables = (table: PgTable): readonly string[] => [
  ...new Set(describeTable(table).foreignKeys.map((foreignKey) => foreignKey.foreignTable)),
]
