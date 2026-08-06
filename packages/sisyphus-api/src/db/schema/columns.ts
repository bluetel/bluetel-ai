import { bigint, boolean, customType, numeric, timestamp, uuid } from 'drizzle-orm/pg-core'

import { uuidV7 } from '../uuid-v7'

/**
 * The column shapes every table in this schema is built from.
 *
 * Centralised so the data-model conventions are decided once rather than retyped per table: UUID
 * v7 keys, `timestamptz` in UTC, and `numeric(12,4)` for money — never floating point, because a
 * spend cap compared against a float is a cap that sometimes does not hold.
 */

/**
 * Case-insensitive text. `users.email` is the join key to Slack identity, and an address that
 * differs only in case is the same person; comparing `lower(email)` in every query instead would
 * make the uniqueness constraint a convention rather than a fact.
 *
 * Requires the `citext` extension, created by the first migration.
 */
export const citext = customType<{ data: string; driverData: string }>({
  dataType: () => 'citext',
})

/** Time-ordered UUID v7 primary key, generated in the application (see `uuid-v7.ts`). */
export const idColumn = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidV7())

/** A nullable/notNull-agnostic `timestamptz` column. UTC everywhere. */
export const timestampColumn = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' })

/** `created_at` — present on every table, set by the database. */
export const createdAtColumn = () => timestampColumn('created_at').notNull().defaultNow()

/** `updated_at` — present only on mutable tables; append-only tables deliberately have none. */
export const updatedAtColumn = () =>
  timestampColumn('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())

/** Money as `numeric(12,4)`, surfaced as a string so no rounding happens on the way through. */
export const moneyColumn = (name: string) => numeric(name, { precision: 12, scale: 4 })

/** Byte counts and log sequence numbers, which outgrow a 32-bit integer. */
export const bigIntColumn = (name: string) => bigint(name, { mode: 'number' })

/** A boolean flag that is off unless something explicitly turns it on. */
export const disabledByDefaultColumn = (name: string) => boolean(name).notNull().default(false)
