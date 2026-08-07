import { randomUUID } from 'node:crypto'

import type { DatabaseClient, SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import { createDatabaseClient, roleChanges, users } from '@bluetel-ai/sisyphus-api/db'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  BOOTSTRAP_ADMINS_JOB_NAME,
  BOOTSTRAP_GOOGLE_SUBJECT_PREFIX,
  BOOTSTRAP_ROLE_CHANGE_REASON,
  normaliseBootstrapEmails,
  reconcileBootstrapAdmins,
  runBootstrapAdmins,
} from './bootstrap-admins'

/** A handle that fails loudly if anything touches it. Used where no query should be issued. */
const untouchableDatabase = (): SisyphusDatabase =>
  new Proxy(
    {},
    {
      get: () => {
        throw new Error('the reconcile must reject an empty list before opening a transaction')
      },
    },
  ) as SisyphusDatabase

describe('normaliseBootstrapEmails', () => {
  it('lower-cases and trims, because an address is one address', () => {
    expect(normaliseBootstrapEmails([' Ada@Example.COM '])).toStrictEqual(['ada@example.com'])
  })

  it('de-duplicates across spellings, so one promotion writes one role change', () => {
    expect(normaliseBootstrapEmails(['ada@example.com', 'ADA@example.com'])).toStrictEqual([
      'ada@example.com',
    ])
  })

  it('drops blank entries left by a trailing comma', () => {
    expect(normaliseBootstrapEmails(['ada@example.com', '   ', ''])).toStrictEqual([
      'ada@example.com',
    ])
  })

  it('preserves the configured order of the addresses it keeps', () => {
    expect(normaliseBootstrapEmails(['b@example.com', 'a@example.com'])).toStrictEqual([
      'b@example.com',
      'a@example.com',
    ])
  })
})

describe('reconcileBootstrapAdmins', () => {
  it('refuses an empty list rather than reporting a successful no-op', async () => {
    // An empty list means the deploy established no admin at all, which is the deadlock FR-174
    // exists to prevent — reporting success would hide it until someone tried to configure
    // something.
    await expect(
      reconcileBootstrapAdmins({ db: untouchableDatabase(), emails: ['  ', ''] }),
    ).rejects.toThrow(/no admin/i)
  })

  it('surfaces that failure through the job envelope rather than throwing', async () => {
    const outcome = await runBootstrapAdmins({ db: untouchableDatabase(), emails: [] })

    expect(outcome.ok).toBe(false)
    expect(outcome.jobName).toBe(BOOTSTRAP_ADMINS_JOB_NAME)
  })
})

const liveDatabaseUrl = process.env['SISYPHUS_TEST_DATABASE_URL']

/**
 * The reconcile against a real Postgres. Skipped — not failed — without
 * `SISYPHUS_TEST_DATABASE_URL`, so a plain `vitest run` stays green.
 */
describe.skipIf(liveDatabaseUrl === undefined || liveDatabaseUrl === '')(
  'bootstrap-admin reconcile against a live database',
  () => {
    const suffix = randomUUID().slice(0, 8)
    let client: DatabaseClient
    let db: SisyphusDatabase

    /** Never signed in — the reconcile has to create this one. */
    const newcomer = `bootstrap-newcomer-${suffix}@sisyphus.test`
    /** Exists already as an engineer — the reconcile has to promote them. */
    const incumbent = `bootstrap-incumbent-${suffix}@sisyphus.test`
    /** Configured once, then dropped from the list — must not be demoted. */
    const dropped = `bootstrap-dropped-${suffix}@sisyphus.test`

    const seededEmails = [newcomer, incumbent, dropped]

    interface SeededUser {
      readonly id: string
      readonly role: 'admin' | 'engineer'
      readonly isActive: boolean
    }

    const readUser = async (email: string): Promise<SeededUser | undefined> => {
      const rows = await db
        .select({ id: users.id, role: users.role, isActive: users.isActive })
        .from(users)
        .where(eq(users.email, email))
        .limit(1)
      return rows[0]
    }

    const roleChangesFor = async (userId: string) =>
      db.select().from(roleChanges).where(eq(roleChanges.subjectUserId, userId))

    beforeAll(async () => {
      client = createDatabaseClient({ connectionString: liveDatabaseUrl ?? '' })
      db = client.db

      await db.insert(users).values({
        email: incumbent,
        googleSubject: `google-bootstrap-incumbent-${suffix}`,
        displayName: `Incumbent ${suffix}`,
      })
    }, 30_000)

    afterAll(async () => {
      // Shared database: remove exactly what this file seeded, in foreign-key order.
      const seeded = await db
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.email, seededEmails))
      const seededIds = seeded.map((row) => row.id)

      if (seededIds.length > 0) {
        await db.delete(roleChanges).where(inArray(roleChanges.subjectUserId, seededIds))
        await db.delete(users).where(inArray(users.id, seededIds))
      }
      await client.close()
    }, 30_000)

    it('creates a pre-authorised admin for an address that has never signed in (FR-174)', async () => {
      const result = await reconcileBootstrapAdmins({ db, emails: [newcomer] })

      expect(result.created).toBe(1)
      expect(result.promoted).toBe(1)

      const created = await readUser(newcomer)
      expect(created).toMatchObject({ role: 'admin', isActive: true })

      const subject = await db
        .select({ googleSubject: users.googleSubject, displayName: users.displayName })
        .from(users)
        .where(eq(users.email, newcomer))
      expect(subject[0]?.googleSubject).toBe(`${BOOTSTRAP_GOOGLE_SUBJECT_PREFIX}${newcomer}`)
    })

    it('attributes the promotion to the system actor — a null actor, not a sentinel user', async () => {
      const created = await readUser(newcomer)
      const changes = await roleChangesFor(created?.id ?? '')

      expect(changes).toHaveLength(1)
      expect(changes[0]).toMatchObject({
        actorUserId: null,
        change: 'grant_admin',
        reason: BOOTSTRAP_ROLE_CHANGE_REASON,
      })
    })

    it('promotes a user who already exists as an engineer', async () => {
      const before = await readUser(incumbent)
      expect(before?.role).toBe('engineer')

      const result = await reconcileBootstrapAdmins({ db, emails: [incumbent] })

      expect(result).toMatchObject({ created: 0, promoted: 1, reactivated: 0 })
      await expect(readUser(incumbent)).resolves.toMatchObject({ role: 'admin', isActive: true })
    })

    it('is a no-op on a second run — the reconcile is idempotent, not a one-shot migration', async () => {
      const newcomerId = (await readUser(newcomer))?.id ?? ''
      const incumbentId = (await readUser(incumbent))?.id ?? ''
      const changesBefore =
        (await roleChangesFor(newcomerId)).length + (await roleChangesFor(incumbentId)).length

      const result = await reconcileBootstrapAdmins({ db, emails: [newcomer, incumbent] })

      expect(result).toMatchObject({ created: 0, promoted: 0, reactivated: 0, unchanged: 2 })
      // Nothing changed, so nothing is recorded: a reconcile that appended a role change per
      // deploy would bury the real promotions in noise.
      const changesAfter =
        (await roleChangesFor(newcomerId)).length + (await roleChangesFor(incumbentId)).length
      expect(changesAfter).toBe(changesBefore)

      // And the user ids are stable — a re-run must not create a second row for the same address.
      expect((await readUser(newcomer))?.id).toBe(newcomerId)
    })

    it('restores an admin who was demoted and deactivated — recovery is a redeploy (FR-173)', async () => {
      const userId = (await readUser(incumbent))?.id ?? ''
      await db.update(users).set({ role: 'engineer', isActive: false }).where(eq(users.id, userId))

      const result = await reconcileBootstrapAdmins({ db, emails: [incumbent] })

      expect(result).toMatchObject({ created: 0, promoted: 1, reactivated: 1 })
      await expect(readUser(incumbent)).resolves.toMatchObject({ role: 'admin', isActive: true })

      // Promotion and reactivation are separate events and are recorded separately.
      const changes = await db
        .select({ id: roleChanges.id })
        .from(roleChanges)
        .where(and(eq(roleChanges.subjectUserId, userId), eq(roleChanges.change, 'activate')))
      expect(changes).toHaveLength(1)
    })

    it('does not demote an address that was removed from the list', async () => {
      await reconcileBootstrapAdmins({ db, emails: [dropped] })
      await expect(readUser(dropped)).resolves.toMatchObject({ role: 'admin' })

      // Revocation stays an explicit, attributed action; dropping the address is not one.
      await reconcileBootstrapAdmins({ db, emails: [newcomer] })

      await expect(readUser(dropped)).resolves.toMatchObject({ role: 'admin', isActive: true })
    })

    it('matches an existing row case-insensitively rather than creating a second identity', async () => {
      const existingId = (await readUser(incumbent))?.id

      const result = await reconcileBootstrapAdmins({ db, emails: [incumbent.toUpperCase()] })

      expect(result.created).toBe(0)
      expect(result.admins.map((outcome) => outcome.userId)).toStrictEqual([existingId])
    })

    it('reports the outcome through the job envelope', async () => {
      const outcome = await runBootstrapAdmins({ db, emails: [newcomer] })

      expect(outcome.ok).toBe(true)
      expect(outcome.jobName).toBe(BOOTSTRAP_ADMINS_JOB_NAME)
      expect(outcome.ok && outcome.value.unchanged).toBe(1)
    })
  },
)
