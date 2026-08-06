import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { DatabaseClient, SisyphusDatabase } from '../../db'
import {
  createDatabaseClient,
  executionProfiles,
  profileAccessGrants,
  users,
  workflowWatchers,
  workflows,
} from '../../db'

import {
  executionProfileExists,
  findLiveGrant,
  insertGrant,
  listGrantsForProfile,
  listGrantsForUser,
  liveGrantWhere,
  markGrantRevoked,
  readUserRole,
  watchesLeftBehindWhere,
} from './grant-store'

const USER_A = '11111111-1111-7111-8111-111111111111'
const PROFILE_A = '55555555-5555-7555-8555-555555555555'

const target = { userId: USER_A, executionProfileId: PROFILE_A }

/**
 * The predicates, inspected as SQL. `toSQL()` compiles without executing, so these run everywhere
 * and do not need a database.
 */
describe('grant predicates', () => {
  let client: DatabaseClient

  beforeAll(() => {
    client = createDatabaseClient({ connectionString: 'postgres://compile-only@127.0.0.1:1/none' })
  })

  afterAll(async () => {
    await client.close()
  })

  it('matches a live grant only while revoked_at is null', () => {
    const compiled = client.db
      .select()
      .from(profileAccessGrants)
      .where(liveGrantWhere(target))
      .toSQL().sql

    expect(compiled).toContain('"user_id" =')
    expect(compiled).toContain('"execution_profile_id" =')
    expect(compiled).toMatch(/"revoked_at" is null/i)
  })

  it('leaves watches on workflows the user owns or initiated out of the cascade (FR-189)', () => {
    const compiled = client.db
      .select({ id: workflowWatchers.id })
      .from(workflowWatchers)
      .innerJoin(workflows, eq(workflows.id, workflowWatchers.workflowId))
      .where(watchesLeftBehindWhere(target))
      .toSQL().sql

    expect(compiled).toContain('"owner_user_id" <>')
    expect(compiled).toContain('"initiated_by_user_id" <>')
  })

  it('treats a null initiator as "not this user" rather than as unknown', () => {
    // Without the explicit null branch the comparison evaluates to null, the row falls out of the
    // delete set, and every integration-started workflow keeps a watch it should have lost.
    const compiled = client.db
      .select({ id: workflowWatchers.id })
      .from(workflowWatchers)
      .innerJoin(workflows, eq(workflows.id, workflowWatchers.workflowId))
      .where(watchesLeftBehindWhere(target))
      .toSQL().sql

    expect(compiled).toMatch(/"initiated_by_user_id" is null/i)
  })
})

const liveDatabaseUrl = process.env['SISYPHUS_TEST_DATABASE_URL']

/**
 * The store against a real Postgres — in particular the partial unique index, which is the reason
 * revocation is an update rather than a delete. Skipped, not failed, when the variable is absent.
 */
describe.skipIf(liveDatabaseUrl === undefined || liveDatabaseUrl === '')(
  'grant store against a live database',
  () => {
    const suffix = randomUUID().slice(0, 8)
    let client: DatabaseClient
    let db: SisyphusDatabase

    const ids = { admin: '', engineer: '', profileOne: '', profileTwo: '' }

    const addUser = async (label: string): Promise<string> => {
      const [row] = await db
        .insert(users)
        .values({
          email: `store-${label}-${suffix}@sisyphus.test`,
          googleSubject: `google-store-${label}-${suffix}`,
          displayName: `${label} ${suffix}`,
        })
        .returning({ id: users.id })
      return row.id
    }

    const addProfile = async (label: string): Promise<string> => {
      const [row] = await db
        .insert(executionProfiles)
        .values({ name: `store-${label}-${suffix}` })
        .returning({ id: executionProfiles.id })
      return row.id
    }

    beforeAll(async () => {
      client = createDatabaseClient({ connectionString: liveDatabaseUrl ?? '' })
      db = client.db

      ids.admin = await addUser('admin')
      ids.engineer = await addUser('engineer')
      await db.update(users).set({ role: 'admin' }).where(eq(users.id, ids.admin))

      ids.profileOne = await addProfile('one')
      ids.profileTwo = await addProfile('two')
    }, 30_000)

    afterAll(async () => {
      // Shared database: remove exactly what was seeded, in foreign-key order.
      for (const profileId of [ids.profileOne, ids.profileTwo]) {
        await db
          .delete(profileAccessGrants)
          .where(eq(profileAccessGrants.executionProfileId, profileId))
        await db.delete(executionProfiles).where(eq(executionProfiles.id, profileId))
      }
      for (const userId of [ids.admin, ids.engineer]) {
        await db.delete(users).where(eq(users.id, userId))
      }
      await client.close()
    }, 30_000)

    it('reads a role, and reports a user that does not exist as undefined', async () => {
      await expect(readUserRole(db, ids.admin)).resolves.toBe('admin')
      await expect(readUserRole(db, ids.engineer)).resolves.toBe('engineer')
      await expect(readUserRole(db, randomUUID())).resolves.toBeUndefined()
    })

    it('reports whether a profile exists', async () => {
      await expect(executionProfileExists(db, ids.profileOne)).resolves.toBe(true)
      await expect(executionProfileExists(db, randomUUID())).resolves.toBe(false)
    })

    it('finds a live grant and stops finding it once revoked', async () => {
      const issued = await insertGrant(db, {
        userId: ids.engineer,
        executionProfileId: ids.profileOne,
        grantedByUserId: ids.admin,
      })

      await expect(
        findLiveGrant(db, { userId: ids.engineer, executionProfileId: ids.profileOne }),
      ).resolves.toMatchObject({ id: issued.id })

      const revoked = await markGrantRevoked(db, {
        grantId: issued.id,
        revokedByUserId: ids.admin,
        revokedAt: new Date(),
      })

      expect(revoked.revokedAt).toBeInstanceOf(Date)
      expect(revoked.revokedByUserId).toBe(ids.admin)
      await expect(
        findLiveGrant(db, { userId: ids.engineer, executionProfileId: ids.profileOne }),
      ).resolves.toBeUndefined()
    })

    it('re-grants after revocation without tripping the partial unique index', async () => {
      // The whole reason revocation writes a timestamp instead of deleting the row: an index
      // without the `WHERE revoked_at IS NULL` predicate would forbid this outright.
      const reissued = await insertGrant(db, {
        userId: ids.engineer,
        executionProfileId: ids.profileOne,
        grantedByUserId: ids.admin,
      })

      expect(reissued.revokedAt).toBeNull()

      const history = await db
        .select({ id: profileAccessGrants.id })
        .from(profileAccessGrants)
        .where(eq(profileAccessGrants.executionProfileId, ids.profileOne))

      // Both rows survive: the revoked one is the audit trail (FR-184).
      expect(history).toHaveLength(2)
    })

    it('refuses a second live grant for the same pair', async () => {
      await expect(
        insertGrant(db, {
          userId: ids.engineer,
          executionProfileId: ids.profileOne,
          grantedByUserId: ids.admin,
        }),
      ).rejects.toThrow()
    })

    it('lists a profile’s live grants, and its history when asked', async () => {
      const live = await listGrantsForProfile(db, {
        executionProfileId: ids.profileOne,
        includeRevoked: false,
        limit: 50,
      })

      expect(live.items).toHaveLength(1)
      expect(live.items[0]?.userId).toBe(ids.engineer)
      expect(live.items[0]?.email).toBe(`store-engineer-${suffix}@sisyphus.test`)
      expect(live.nextCursor).toBeUndefined()

      const all = await listGrantsForProfile(db, {
        executionProfileId: ids.profileOne,
        includeRevoked: true,
        limit: 50,
      })

      expect(all.items).toHaveLength(2)
    })

    it('pages by keyset, newest first', async () => {
      const first = await listGrantsForProfile(db, {
        executionProfileId: ids.profileOne,
        includeRevoked: true,
        limit: 1,
      })

      expect(first.items).toHaveLength(1)
      expect(first.nextCursor).toBe(first.items[0]?.id)

      const second = await listGrantsForProfile(db, {
        executionProfileId: ids.profileOne,
        includeRevoked: true,
        limit: 1,
        cursor: first.nextCursor,
      })

      expect(second.items).toHaveLength(1)
      expect(second.items[0]?.id).not.toBe(first.items[0]?.id)
      expect(second.nextCursor).toBeUndefined()
    })

    it('lists what a user holds, naming the profile', async () => {
      await insertGrant(db, {
        userId: ids.engineer,
        executionProfileId: ids.profileTwo,
        grantedByUserId: ids.admin,
      })

      const held = await listGrantsForUser(db, {
        userId: ids.engineer,
        includeRevoked: false,
        limit: 50,
      })

      expect(held.items.map((row) => row.profileName).sort()).toStrictEqual([
        `store-one-${suffix}`,
        `store-two-${suffix}`,
      ])
    })
  },
)
