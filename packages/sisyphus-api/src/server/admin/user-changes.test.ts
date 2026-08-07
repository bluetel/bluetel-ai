import { randomUUID } from 'node:crypto'

import { TRPCError } from '@trpc/server'
import { and, count, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { configurationAudit, roleChanges, users, workflows } from '../../db'

import { createUserFixtures, readTestDatabaseUrl } from './test-database'
import { setUserActive, setUserRole } from './user-changes'

/**
 * These run against a live database or not at all.
 *
 * Every one of them is about what a *transaction* did — a row written, a row deliberately not
 * written, a change refused because of a count taken under a lock. A mocked Drizzle handle would
 * assert that the code called the methods it was written to call, which is a restatement of the
 * implementation rather than a test of it.
 */
const connectionString = readTestDatabaseUrl()
const describeWithDatabase = connectionString === undefined ? describe.skip : describe

describeWithDatabase('the admin writes against a live database', () => {
  const fixtures = createUserFixtures(connectionString ?? '')

  beforeAll(() => fixtures.open(), 60_000)
  afterEach(async () => {
    await fixtures.removeAll()
    const rows = await fixtures.db().select().from(users)
    console.log(
      'AFTER-EACH leftovers:',
      rows.map((r) => `${r.email}/${r.role}/${String(r.isActive)}`),
    )
  })
  afterAll(() => fixtures.close())

  /**
   * Active admins **in the whole database**, because that is what the invariant counts. The
   * tests that turn on there being exactly one assert this first, so a database left polluted by
   * another run fails with a clear number rather than with a confusing refusal that never came.
   */
  const countActiveAdmins = async (): Promise<number> => {
    const rows = await fixtures
      .db()
      .select({ value: count() })
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.isActive, true)))
    return rows[0]?.value ?? 0
  }

  const historyFor = async (userId: string) =>
    fixtures.db().select().from(roleChanges).where(eq(roleChanges.subjectUserId, userId))

  const auditFor = async (userId: string) =>
    fixtures.db().select().from(configurationAudit).where(eq(configurationAudit.entityId, userId))

  describe('setUserRole', () => {
    it('grants the admin role and records it against the acting admin (FR-172, FR-177)', async () => {
      const actor = await fixtures.seedUser({ label: 'actor', role: 'admin' })
      const subject = await fixtures.seedUser({ label: 'subject', role: 'engineer' })

      const result = await fixtures
        .db()
        .transaction((writer) =>
          setUserRole({ writer, actorUserId: actor.id, userId: subject.id, role: 'admin' }),
        )

      expect(result).toMatchObject({ changed: true, user: { role: 'admin' } })
      expect(await historyFor(subject.id)).toMatchObject([
        { actorUserId: actor.id, subjectUserId: subject.id, change: 'grant_admin' },
      ])
      expect(await auditFor(subject.id)).toMatchObject([
        {
          actorUserId: actor.id,
          entityType: 'user',
          action: 'role_changed',
          detail: { from: 'engineer', to: 'admin' },
        },
      ])
    })

    it('records a revocation as its own kind of event', async () => {
      const actor = await fixtures.seedUser({ label: 'actor', role: 'admin' })
      const subject = await fixtures.seedUser({ label: 'subject', role: 'admin' })

      await fixtures.db().transaction((writer) =>
        setUserRole({
          writer,
          actorUserId: actor.id,
          userId: subject.id,
          role: 'engineer',
          reason: 'Moved off the client account.',
        }),
      )

      expect(await historyFor(subject.id)).toMatchObject([
        { change: 'revoke_admin', reason: 'Moved off the client account.' },
      ])
    })

    it('writes no history for a request that changes nothing', async () => {
      // "Granted admin" in the history of someone who was already an admin is a false entry, and
      // FR-177's history is only useful if every row in it is an event that happened.
      const actor = await fixtures.seedUser({ label: 'actor', role: 'admin' })
      const subject = await fixtures.seedUser({ label: 'subject', role: 'engineer' })

      const result = await fixtures
        .db()
        .transaction((writer) =>
          setUserRole({ writer, actorUserId: actor.id, userId: subject.id, role: 'engineer' }),
        )

      expect(result.changed).toBe(false)
      expect(await historyFor(subject.id)).toStrictEqual([])
      expect(await auditFor(subject.id)).toStrictEqual([])
    })

    it('refuses to demote the last active admin (FR-173)', async () => {
      const only = await fixtures.seedUser({ label: 'only-admin', role: 'admin' })
      expect(await countActiveAdmins()).toBe(1)

      await expect(
        fixtures
          .db()
          .transaction((writer) =>
            setUserRole({ writer, actorUserId: only.id, userId: only.id, role: 'engineer' }),
          ),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })

      const after = await fixtures.db().select().from(users).where(eq(users.id, only.id))
      expect(after[0]?.role).toBe('admin')
      // The refusal rolled the whole transaction back, history included.
      expect(await historyFor(only.id)).toStrictEqual([])
    })

    it('permits the same demotion once a second admin exists', async () => {
      const first = await fixtures.seedUser({ label: 'first-admin', role: 'admin' })
      const second = await fixtures.seedUser({ label: 'second-admin', role: 'admin' })
      expect(await countActiveAdmins()).toBe(2)

      await fixtures
        .db()
        .transaction((writer) =>
          setUserRole({ writer, actorUserId: second.id, userId: first.id, role: 'engineer' }),
        )

      expect(await countActiveAdmins()).toBe(1)
    })

    it('reports an unknown user as absent (FR-190)', async () => {
      const actor = await fixtures.seedUser({ label: 'actor', role: 'admin' })

      await expect(
        fixtures.db().transaction((writer) =>
          setUserRole({
            writer,
            actorUserId: actor.id,
            userId: randomUUID(),
            role: 'admin',
          }),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })
  })

  describe('setUserActive', () => {
    it('deactivates without deleting anything the user is attached to (FR-176)', async () => {
      const actor = await fixtures.seedUser({ label: 'actor', role: 'admin' })
      const leaver = await fixtures.seedUser({ label: 'leaver', role: 'engineer' })
      const running = await fixtures.seedWorkflow({ ownerUserId: leaver.id, state: 'running' })

      const result = await fixtures
        .db()
        .transaction((writer) =>
          setUserActive({ writer, actorUserId: actor.id, userId: leaver.id, isActive: false }),
        )

      expect(result).toMatchObject({ changed: true, user: { isActive: false } })

      const row = await fixtures.db().select().from(users).where(eq(users.id, leaver.id))
      // Still there, still themselves. Deactivation is a flag, never a delete or an anonymisation.
      expect(row[0]).toMatchObject({ id: leaver.id, email: leaver.email, isActive: false })

      const run = await fixtures.db().select().from(workflows).where(eq(workflows.id, running))
      expect(run[0]).toMatchObject({
        needsReassignment: true,
        // Untouched: the run keeps going and keeps its owner. What it needs is a new *accountable*
        // human, which is a decision for an admin — not a reason to kill work in flight.
        state: 'running',
        ownerUserId: leaver.id,
      })
    })

    it('flags only the runs still in flight', async () => {
      const actor = await fixtures.seedUser({ label: 'actor', role: 'admin' })
      const leaver = await fixtures.seedUser({ label: 'leaver' })
      const finished = await fixtures.seedWorkflow({ ownerUserId: leaver.id, state: 'succeeded' })
      await fixtures.seedWorkflow({ ownerUserId: leaver.id, state: 'paused' })

      const result = await fixtures
        .db()
        .transaction((writer) =>
          setUserActive({ writer, actorUserId: actor.id, userId: leaver.id, isActive: false }),
        )

      expect(result.workflowsFlaggedForReassignment).toBe(1)
      const done = await fixtures.db().select().from(workflows).where(eq(workflows.id, finished))
      expect(done[0]?.needsReassignment).toBe(false)
    })

    it('records the deactivation with the acting admin (FR-177)', async () => {
      const actor = await fixtures.seedUser({ label: 'actor', role: 'admin' })
      const leaver = await fixtures.seedUser({ label: 'leaver' })

      await fixtures.db().transaction((writer) =>
        setUserActive({
          writer,
          actorUserId: actor.id,
          userId: leaver.id,
          isActive: false,
          reason: 'Left the company.',
        }),
      )

      expect(await historyFor(leaver.id)).toMatchObject([
        { actorUserId: actor.id, change: 'deactivate', reason: 'Left the company.' },
      ])
      expect(await auditFor(leaver.id)).toMatchObject([
        { actorUserId: actor.id, entityType: 'user', action: 'deactivated' },
      ])
    })

    it('clears the reassignment flag when the user comes back', async () => {
      const actor = await fixtures.seedUser({ label: 'actor', role: 'admin' })
      const leaver = await fixtures.seedUser({ label: 'leaver' })
      const running = await fixtures.seedWorkflow({ ownerUserId: leaver.id, state: 'running' })

      await fixtures
        .db()
        .transaction((writer) =>
          setUserActive({ writer, actorUserId: actor.id, userId: leaver.id, isActive: false }),
        )
      const result = await fixtures
        .db()
        .transaction((writer) =>
          setUserActive({ writer, actorUserId: actor.id, userId: leaver.id, isActive: true }),
        )

      expect(result.workflowsFlaggedForReassignment).toBe(1)
      const run = await fixtures.db().select().from(workflows).where(eq(workflows.id, running))
      expect(run[0]?.needsReassignment).toBe(false)
    })

    it('refuses to deactivate the last active admin, including themselves (FR-173)', async () => {
      const only = await fixtures.seedUser({ label: 'only-admin', role: 'admin' })
      expect(await countActiveAdmins()).toBe(1)

      await expect(
        fixtures
          .db()
          .transaction((writer) =>
            setUserActive({ writer, actorUserId: only.id, userId: only.id, isActive: false }),
          ),
      ).rejects.toBeInstanceOf(TRPCError)

      expect(await countActiveAdmins()).toBe(1)
    })

    it('reactivates the only admin even from a state of zero active admins', async () => {
      // The recovery path out of FR-173's failure mode must not itself be refused for leaving the
      // platform with none.
      const actor = await fixtures.seedUser({ label: 'actor', role: 'admin' })
      const dormant = await fixtures.seedUser({
        label: 'dormant',
        role: 'admin',
        isActive: false,
      })

      const result = await fixtures
        .db()
        .transaction((writer) =>
          setUserActive({ writer, actorUserId: actor.id, userId: dormant.id, isActive: true }),
        )

      expect(result.user.isActive).toBe(true)
    })

    it('writes no history for a request that changes nothing', async () => {
      const actor = await fixtures.seedUser({ label: 'actor', role: 'admin' })
      const subject = await fixtures.seedUser({ label: 'subject' })

      const result = await fixtures
        .db()
        .transaction((writer) =>
          setUserActive({ writer, actorUserId: actor.id, userId: subject.id, isActive: true }),
        )

      expect(result.changed).toBe(false)
      expect(await historyFor(subject.id)).toStrictEqual([])
    })
  })
})
