import { sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { boolean, integer, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

import { DEFAULT_USER_ROLE } from '../../enums'

import { citext, createdAtColumn, idColumn, timestampColumn, updatedAtColumn } from './columns'
import { roleChangeEnum, userRoleEnum } from './enums'
import { executionProfiles } from './profile'

/**
 * Identity and access — who exists, what they may do, and how that changed.
 *
 * `profile_access_grants` is the input to every scoped query in the platform: FR-190 forbids
 * disclosing a workflow outside the requester's scope *including its existence*, so the visible
 * profile set is resolved once per request from this table rather than checked per resolver.
 */

/**
 * Auto-created on first successful sign-in with role `engineer` (FR-170).
 *
 * Deactivation is never deletion (FR-176): history references these rows, and a run whose owner
 * has been deactivated is flagged for reassignment rather than orphaned.
 */
export const users = pgTable(
  'users',
  {
    id: idColumn(),
    /** The join key to Slack identity (R13); case-insensitive because an address is one address. */
    email: citext('email').notNull(),
    /** Stable IdP identifier. Email can change; this cannot. */
    googleSubject: text('google_subject').notNull(),
    displayName: text('display_name').notNull(),
    role: userRoleEnum('role').notNull().default(DEFAULT_USER_ROLE),
    /** Deactivation, not deletion (FR-176). */
    isActive: boolean('is_active').notNull().default(true),
    /** Cached resolution; null means unnotifiable, which is surfaced and never fails a run (FR-140). */
    slackUserId: text('slack_user_id'),
    lastSignInAt: timestampColumn('last_sign_in_at'),
    /**
     * The three columns Auth.js's Drizzle adapter reads and writes on a user row. They are the
     * adapter's contract, not the platform's: `display_name` stays the name the panel renders and
     * the notifications quote, while `name` is whatever Google last returned. Keeping them
     * separate means an IdP profile rename cannot silently rewrite the name attached to a year of
     * run history, which is what a single shared column would do.
     *
     * All three are nullable because the adapter treats them as optional, and because
     * `email_verified` is meaningless for a provider whose `hd` claim is what we actually trust.
     */
    name: text('name'),
    emailVerified: timestampColumn('email_verified'),
    image: text('image'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('users_email_key').on(table.email),
    uniqueIndex('users_google_subject_key').on(table.googleSubject),
  ],
)

/**
 * Append-only role and activation audit (FR-177). Never edited or deleted.
 *
 * `actorUserId` is null for the deploy-time bootstrap reconcile — the `system` actor that breaks
 * the first-admin deadlock (FR-174). A bootstrap grant is therefore as auditable as a human-issued
 * one, and "who made this person an admin" always has an answer.
 */
export const roleChanges = pgTable('role_changes', {
  id: idColumn(),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  subjectUserId: uuid('subject_user_id')
    .notNull()
    .references(() => users.id),
  change: roleChangeEnum('change').notNull(),
  reason: text('reason'),
  createdAt: createdAtColumn(),
})

/**
 * Append-only grants of access to an execution profile — the unit of access control (FR-121,
 * FR-179).
 *
 * A grant is live when `revoked_at is null`. Revocation writes `revoked_at` rather than deleting,
 * so the audit trail survives (FR-184), and the partial unique index below is what stops two live
 * grants existing for the same pair. Without the predicate the index would forbid ever
 * re-granting access that had been revoked.
 */
export const profileAccessGrants = pgTable(
  'profile_access_grants',
  {
    id: idColumn(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    executionProfileId: uuid('execution_profile_id')
      .notNull()
      .references((): AnyPgColumn => executionProfiles.id),
    grantedByUserId: uuid('granted_by_user_id')
      .notNull()
      .references(() => users.id),
    grantedAt: timestampColumn('granted_at').notNull().defaultNow(),
    revokedAt: timestampColumn('revoked_at'),
    revokedByUserId: uuid('revoked_by_user_id').references(() => users.id),
  },
  (table) => [
    uniqueIndex('profile_access_grants_live_key')
      .on(table.userId, table.executionProfileId)
      .where(sql`${table.revokedAt} is null`),
  ],
)

/**
 * Auth.js adapter storage — the three tables `@auth/drizzle-adapter` owns, mapped onto the
 * platform's own `users` table rather than a second identity of its own.
 *
 * They live here, beside `users`, because they are part of identity: pointing the adapter at a
 * separate user table would give the platform two answers to "who is this", and the role and
 * activation columns would sit on the row the session does *not* resolve to.
 *
 * Property names are the adapter's (`sessionToken`, `providerAccountId`, `refresh_token`), because
 * the adapter addresses columns by property. The database names underneath them stay snake_case
 * like the rest of the schema.
 */

/**
 * One row per linked provider identity. `on delete cascade` is the adapter's contract for
 * unlinking; it does not conflict with FR-176, which forbids deleting *users*, not credentials.
 */
export const authAccounts = pgTable(
  'auth_accounts',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (table) => [primaryKey({ columns: [table.provider, table.providerAccountId] })],
)

/**
 * Database-backed sessions (FR-175, R9).
 *
 * Every authenticated request resolves this row and re-reads the user it points at, so a role
 * change or a deactivation takes effect on the **next request**. The alternative — a JWT session —
 * would leave a deactivated user working until their token expired, because nothing would consult
 * the database between sign-in and expiry.
 */
export const authSessions = pgTable('auth_sessions', {
  sessionToken: text('session_token').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expires: timestampColumn('expires').notNull(),
})

/**
 * Required by the adapter's interface, and deliberately unused: the panel has exactly one provider
 * and it is Google (FR-011). The table exists so the adapter is whole; an email-link sign-in would
 * be a second, unverified route past the `hd` domain check.
 */
export const authVerificationTokens = pgTable(
  'auth_verification_tokens',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestampColumn('expires').notNull(),
  },
  (table) => [primaryKey({ columns: [table.identifier, table.token] })],
)

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type RoleChange = typeof roleChanges.$inferSelect
export type NewRoleChange = typeof roleChanges.$inferInsert
export type ProfileAccessGrant = typeof profileAccessGrants.$inferSelect
export type NewProfileAccessGrant = typeof profileAccessGrants.$inferInsert
export type AuthAccount = typeof authAccounts.$inferSelect
export type NewAuthAccount = typeof authAccounts.$inferInsert
export type AuthSession = typeof authSessions.$inferSelect
export type NewAuthSession = typeof authSessions.$inferInsert
export type AuthVerificationToken = typeof authVerificationTokens.$inferSelect
export type NewAuthVerificationToken = typeof authVerificationTokens.$inferInsert
