import { DrizzleAdapter } from '@auth/drizzle-adapter'
import type { SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import {
  authAccounts,
  authSessions,
  authVerificationTokens,
  users,
} from '@bluetel-ai/sisyphus-api/db'
import type { Adapter } from 'next-auth/adapters'

/**
 * The Auth.js storage adapter, pointed at the platform's own `users` table.
 *
 * Pointing it at `users` rather than letting it keep an identity of its own is what makes FR-175
 * work: the row the session resolves to is the row that carries `role` and `is_active`, so an
 * administrator's change to either is visible to the very next request. A separate Auth.js user
 * table would mean the session resolved a row on which those columns did not exist.
 */

/** The adapter's own description of the four tables it owns. */
type DrizzleAuthSchema = NonNullable<Parameters<typeof DrizzleAdapter<SisyphusDatabase>>[1]>

/**
 * `users.email` is `citext`, a Drizzle custom column type, so its `columnType` is not one of the
 * literal names the adapter's structural table type enumerates. The runtime shape is a text column
 * and the adapter only ever reads and compares it. The assertion is that mismatch and nothing
 * wider, which is why it is scoped to this one table rather than to the whole options object.
 */
const adapterUsersTable = users as unknown as DrizzleAuthSchema['usersTable']

export interface SisyphusAdapterOptions {
  readonly db: SisyphusDatabase
  /**
   * **Seam for T037** — auto-create the user as `engineer` on first successful sign-in (FR-170).
   *
   * The stock `createUser` cannot serve this table: `google_subject` and `display_name` are
   * `not null` with no default and Auth.js knows about neither, so the insert it builds fails.
   * T037 supplies a replacement here — reading the verified profile, inserting with
   * `role = 'engineer'`, and returning the created `AdapterUser`. It is injected rather than
   * written here so this task does not own a decision (what a new user is created as) that belongs
   * to the user-management slice.
   */
  readonly createUser?: Adapter['createUser']
}

export const createSisyphusAdapter = ({ db, createUser }: SisyphusAdapterOptions): Adapter => {
  const base = DrizzleAdapter(db, {
    usersTable: adapterUsersTable,
    accountsTable: authAccounts,
    sessionsTable: authSessions,
    verificationTokensTable: authVerificationTokens,
  })

  return createUser === undefined ? base : { ...base, createUser }
}
