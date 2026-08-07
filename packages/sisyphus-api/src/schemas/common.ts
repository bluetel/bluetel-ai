import { z } from 'zod'

/**
 * The primitives every domain schema is built from.
 *
 * These are shared rather than restated per file so that "what is a valid cursor" and "what is a
 * money amount" are decided once. The panel imports the same schemas the resolvers validate with
 * (`./client`), so a rule tightened here tightens on both sides at once and the form cannot drift
 * out of agreement with the server (FR-008).
 */

/** A v7 identifier. Every primary key in the schema is one. */
export const uuidInput = z.string().uuid()

/** Text that must actually contain something. Trimmed first, so `'   '` is rejected. */
export const nonEmptyText = z.string().trim().min(1)

/**
 * Money as a decimal string, matching the `numeric(12,4)` columns.
 *
 * A string rather than a number all the way through: a spend cap compared against a float is a cap
 * that sometimes does not hold, and JSON has no decimal type to hand it over in.
 */
export const moneyAmount = z.string().regex(/^\d+(\.\d{1,4})?$/, 'Expected a decimal amount.')

/** A page size, bounded so a caller cannot ask for the whole table. */
export const pageLimit = z.number().int().min(1).max(100).default(50)

/**
 * Keyset pagination. The cursor is the id of the last row seen, not an offset — an offset
 * re-reads rows that a concurrent insert has shifted, which on a newest-first list is every page.
 */
export const cursorPagination = z.object({
  cursor: uuidInput.optional(),
  limit: pageLimit,
})

/**
 * A half-open time window. Both ends optional, so "since Monday" and "everything" are the same
 * shape. `Date` survives the wire because the transformer is `superjson`.
 */
export const dateRange = z.object({
  from: z.date().optional(),
  to: z.date().optional(),
})

/** A boolean toggle, used by every `setEnabled` mutation. */
export const enabledFlag = z.object({ enabled: z.boolean() })

export type UuidInput = z.infer<typeof uuidInput>
export type CursorPagination = z.infer<typeof cursorPagination>
export type DateRange = z.infer<typeof dateRange>
