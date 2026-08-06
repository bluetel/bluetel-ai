import { describe, expect, it } from 'vitest'

import {
  authAccounts,
  authSessions,
  authVerificationTokens,
  profileAccessGrants,
  roleChanges,
  users,
} from './identity'
import { columnOf, describeTable, indexOf, referencedTables } from './introspect'

describe('users', () => {
  it('joins to Slack identity on a case-insensitive email (R13)', () => {
    expect(columnOf(users, 'email').type).toBe('citext')
    expect(columnOf(users, 'email').notNull).toBe(true)
    expect(indexOf(users, 'users_email_key').unique).toBe(true)
  })

  it('keeps a stable IdP identifier separate from the email, which can change', () => {
    expect(columnOf(users, 'google_subject').notNull).toBe(true)
    expect(indexOf(users, 'users_google_subject_key').unique).toBe(true)
  })

  it('creates a new user as engineer, never as admin (FR-170, FR-174)', () => {
    expect(columnOf(users, 'role').defaultValue).toBe('engineer')
    expect(columnOf(users, 'role').notNull).toBe(true)
  })

  it('deactivates rather than deletes (FR-176)', () => {
    expect(columnOf(users, 'is_active').notNull).toBe(true)
    expect(columnOf(users, 'is_active').defaultValue).toBe(true)
    expect(describeTable(users).columns.map((column) => column.name)).not.toContain('deleted_at')
  })

  it('allows a null Slack id, because unnotifiable must not fail a run (FR-140)', () => {
    expect(columnOf(users, 'slack_user_id').notNull).toBe(false)
  })
})

describe('Auth.js adapter storage', () => {
  it('keeps the IdP profile name out of the name the panel renders', () => {
    expect(columnOf(users, 'name').notNull).toBe(false)
    expect(columnOf(users, 'display_name').notNull).toBe(true)
  })

  it('carries the remaining columns the adapter reads and writes', () => {
    expect(columnOf(users, 'email_verified').notNull).toBe(false)
    expect(columnOf(users, 'image').notNull).toBe(false)
  })

  it('hangs every adapter table off the platform users table, not a second identity', () => {
    expect(referencedTables(authAccounts)).toStrictEqual(['users'])
    expect(referencedTables(authSessions)).toStrictEqual(['users'])
    expect(referencedTables(authVerificationTokens)).toStrictEqual([])
  })

  it('stores sessions in the database so deactivation lands on the next request (FR-175)', () => {
    expect(columnOf(authSessions, 'session_token').primaryKey).toBe(true)
    expect(columnOf(authSessions, 'user_id').notNull).toBe(true)
    expect(columnOf(authSessions, 'expires').type).toBe('timestamp with time zone')
  })

  it('identifies a linked account by provider and provider account id', () => {
    const names = describeTable(authAccounts).columns.map((column) => column.name)
    expect(names).toContain('provider')
    expect(names).toContain('provider_account_id')
    expect(columnOf(authAccounts, 'provider').notNull).toBe(true)
    expect(columnOf(authAccounts, 'provider_account_id').notNull).toBe(true)
  })

  it('exposes the adapter property names the adapter addresses columns by', () => {
    // The adapter reads `account.refresh_token`, not `account.refreshToken`; a tidier property
    // name here compiles and then writes nothing at runtime.
    expect(Object.keys(authAccounts)).toEqual(
      expect.arrayContaining([
        'userId',
        'providerAccountId',
        'refresh_token',
        'access_token',
        'expires_at',
        'token_type',
        'id_token',
        'session_state',
      ]),
    )
    expect(Object.keys(authSessions)).toEqual(expect.arrayContaining(['sessionToken', 'userId']))
  })
})

describe('role_changes', () => {
  it('is append-only: it carries created_at and no updated_at', () => {
    const names = describeTable(roleChanges).columns.map((column) => column.name)
    expect(names).toContain('created_at')
    expect(names).not.toContain('updated_at')
  })

  it('always names a subject, and allows a null actor for the system bootstrap (FR-174)', () => {
    expect(columnOf(roleChanges, 'subject_user_id').notNull).toBe(true)
    expect(columnOf(roleChanges, 'actor_user_id').notNull).toBe(false)
  })

  it('points both actor and subject at users', () => {
    expect(referencedTables(roleChanges)).toStrictEqual(['users'])
  })
})

describe('profile_access_grants', () => {
  it('revokes by writing a timestamp, so the audit trail survives (FR-184)', () => {
    expect(columnOf(profileAccessGrants, 'revoked_at').notNull).toBe(false)
    expect(columnOf(profileAccessGrants, 'revoked_by_user_id').notNull).toBe(false)
    const names = describeTable(profileAccessGrants).columns.map((column) => column.name)
    expect(names).not.toContain('updated_at')
  })

  it('forbids two live grants for one pair with a partial unique index', () => {
    const index = indexOf(profileAccessGrants, 'profile_access_grants_live_key')
    expect(index.unique).toBe(true)
    expect(index.columns).toStrictEqual(['user_id', 'execution_profile_id'])
    expect(index.where).toBe('"profile_access_grants"."revoked_at" is null')
  })

  it('scopes the index to live grants, so revoked access can be granted again', () => {
    expect(indexOf(profileAccessGrants, 'profile_access_grants_live_key').where).toBeDefined()
  })

  it('records who granted as well as who was granted', () => {
    expect(columnOf(profileAccessGrants, 'granted_by_user_id').notNull).toBe(true)
    expect([...referencedTables(profileAccessGrants)].sort()).toStrictEqual([
      'execution_profiles',
      'users',
    ])
  })
})
