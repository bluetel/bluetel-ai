import { and, count, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { SisyphusDatabase } from '../../db'
import { createDatabaseClient, users } from '../../db'
import type { UserRole } from '../../enums'
import type { AuthorisationDenial, SisyphusContext, SisyphusSession } from '../context'
import { createCallerFactory } from '../procedures'
import { memoiseScope } from '../scope'

import { createUserFixtures, readTestDatabaseUrl } from './test-database'
import { setUserRole } from './user-changes'
import { usersRouter } from './users'

const createCaller = createCallerFactory(usersRouter)

interface CallerIdentity {
  readonly id: string
  readonly email: string
  readonly role: UserRole
}

/** A context carrying one signed-in human, built exactly as `createSisyphusAdditionalContext` does. */
const contextFor = (
  db: SisyphusDatabase,
  user: CallerIdentity,
  denials: AuthorisationDenial[],
): SisyphusContext => {
  const session: SisyphusSession = {
    user: { ...user, displayName: user.email, isActive: true },
    expiresAt: new Date(Date.now() + 60_000),
  }

  return {
    headers: new Headers(),
    dependencies: {
      db,
      resolveSession: () => Promise.resolve(session),
      resolveMachineCredential: () => Promise.resolve(null),
      recordDenial: (denial) => {
        denials.push(denial)
        return Promise.resolve()
      },
    },
    db,
    session,
    scope: memoiseScope(() =>
      Promise.resolve({
        userId: user.id,
        isAdmin: user.role === 'admin',
        visibleProfileIds: [],
      }),
    ),
    machineCredential: () => Promise.resolve(null),
  }
}

describe('the admin.users contract', () => {
  it('exposes exactly the procedures api-surface.md names', () => {
    expect(Object.keys(usersRouter._def.procedures).sort()).toStrictEqual([
      'list',
      'roleChanges',
      'setActive',
      'setRole',
    ])
  })

  it('refuses a non-admin and records the attempt (FR-169)', async () => {
    // The pool is never connected: `adminProcedure` turns the caller away before any resolver runs,
    // which is the point — the gate is not something a resolver opts into.
    const db = createDatabaseClient({ connectionString: 'postgres://x@db.invalid:5432/y' }).db
    const denials: AuthorisationDenial[] = []
    const caller = createCaller(
      contextFor(
        db,
        { id: crypto.randomUUID(), email: 'eng@sisyphus.test', role: 'engineer' },
        denials,
      ),
    )

    await expect(caller.list({ limit: 10, activeOnly: false })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(denials).toMatchObject([{ reason: 'not_admin' }])
  })
})

/**
 * The live suite, and the reason this task needed a database at all.
 *
 * FR-173 is not a rule about a value; it is a rule about an *interleaving*. The only test that can
 * fail when the invariant is implemented as a check-then-write is one that actually interleaves two
 * transactions, so that is what the last two tests here do.
 */
const connectionString = readTestDatabaseUrl()
const describeWithDatabase = connectionString === undefined ? describe.skip : describe

/** A promise plus its resolver, for holding a transaction open at a chosen moment. */
const createGate = (): { readonly opened: Promise<void>; readonly open: () => void } => {
  let open = (): void => undefined
  const opened = new Promise<void>((resolve) => {
    open = () => {
      resolve()
    }
  })
  return { opened, open }
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

describeWithDatabase('admin.users against a live database', () => {
  const fixtures = createUserFixtures(connectionString ?? '')
  const denials: AuthorisationDenial[] = []

  beforeAll(() => fixtures.open(), 60_000)
  afterEach(() => fixtures.removeAll())
  afterAll(() => fixtures.close())

  const callerFor = (user: CallerIdentity) => createCaller(contextFor(fixtures.db(), user, denials))

  const countActiveAdmins = async (): Promise<number> => {
    const rows = await fixtures
      .db()
      .select({ value: count() })
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.isActive, true)))
    return rows[0]?.value ?? 0
  }

  it('lists users, grants a role and reads the change back out of the history', async () => {
    const admin = await fixtures.seedUser({ label: 'admin', role: 'admin' })
    const engineer = await fixtures.seedUser({ label: 'engineer', role: 'engineer' })
    const caller = callerFor({ id: admin.id, email: admin.email, role: 'admin' })

    const before = await caller.list({ limit: 50, activeOnly: false, search: engineer.email })
    expect(before.items[0]).toMatchObject({ id: engineer.id, role: 'engineer' })

    const granted = await caller.setRole({ userId: engineer.id, role: 'admin' })
    expect(granted.user.role).toBe('admin')

    const history = await caller.roleChanges({ limit: 50, subjectUserId: engineer.id })
    expect(history.items).toMatchObject([{ change: 'grant_admin', actorUserId: admin.id }])
  })

  it('deactivates without deleting, and flags the run the user still owns (FR-176)', async () => {
    const admin = await fixtures.seedUser({ label: 'admin', role: 'admin' })
    const leaver = await fixtures.seedUser({ label: 'leaver' })
    await fixtures.seedWorkflow({ ownerUserId: leaver.id, state: 'running' })
    const caller = callerFor({ id: admin.id, email: admin.email, role: 'admin' })

    const result = await caller.setActive({ userId: leaver.id, isActive: false })

    expect(result).toMatchObject({
      user: { id: leaver.id, isActive: false },
      workflowsFlaggedForReassignment: 1,
    })
    const listed = await caller.list({ limit: 50, activeOnly: false, search: leaver.email })
    expect(listed.items[0]).toMatchObject({
      isActive: false,
      ownedWorkflowCount: 1,
      workflowsAwaitingReassignment: 1,
    })
  })

  it('hides an unknown user behind NOT_FOUND rather than confirming it is missing (FR-190)', async () => {
    const admin = await fixtures.seedUser({ label: 'admin', role: 'admin' })
    const caller = callerFor({ id: admin.id, email: admin.email, role: 'admin' })

    await expect(
      caller.setActive({ userId: crypto.randomUUID(), isActive: false }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('makes the second of two concurrent demotions block and then lose (FR-173)', async () => {
    // Exactly two active admins, each demoting the other. Under a check-then-write both would read
    // "2", both would decide the change was safe, and the platform would end up with none.
    const first = await fixtures.seedUser({ label: 'race-first', role: 'admin' })
    const second = await fixtures.seedUser({ label: 'race-second', role: 'admin' })
    expect(await countActiveAdmins()).toBe(2)

    const written = createGate()
    const release = createGate()

    // The winner: a real `setUserRole`, held open after it has written so its row locks are still
    // in place when the loser arrives.
    const winner = fixtures.db().transaction(async (writer) => {
      const result = await setUserRole({
        writer,
        actorUserId: first.id,
        userId: first.id,
        role: 'engineer',
      })
      written.open()
      await release.opened
      return result
    })

    await written.opened

    let loserSettled = false
    const loser = callerFor({ id: second.id, email: second.email, role: 'admin' })
      .setRole({ userId: second.id, role: 'engineer' })
      .finally(() => {
        loserSettled = true
      })

    // Wait for Postgres to report a backend parked on a lock. Without this assertion a run in
    // which the loser simply happened to execute after the winner would look identical to one in
    // which the lock made it wait — and only the second proves anything.
    let blocked = 0
    for (let attempt = 0; attempt < 200 && blocked === 0; attempt += 1) {
      await sleep(25)
      blocked = await fixtures.backendsWaitingOnLocks()
    }
    expect(blocked).toBeGreaterThan(0)
    expect(loserSettled).toBe(false)

    release.open()
    await expect(winner).resolves.toMatchObject({ changed: true })

    // The loser's locking read woke up on the *committed* demotion, re-counted one active admin,
    // and refused. A count taken before the transaction would still have said two.
    await expect(loser).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(await countActiveAdmins()).toBe(1)

    const survivor = await fixtures.db().select().from(users).where(eq(users.id, second.id))
    expect(survivor[0]?.role).toBe('admin')
  }, 30_000)

  it('lets exactly one of two simultaneous demotions through (FR-173)', async () => {
    // The same race without the choreography: fire both and let the database decide. The outcome
    // is the requirement — one succeeds, one is refused, and an admin remains.
    const first = await fixtures.seedUser({ label: 'both-first', role: 'admin' })
    const second = await fixtures.seedUser({ label: 'both-second', role: 'admin' })
    expect(await countActiveAdmins()).toBe(2)

    const results = await Promise.allSettled([
      callerFor({ id: first.id, email: first.email, role: 'admin' }).setRole({
        userId: first.id,
        role: 'engineer',
      }),
      callerFor({ id: second.id, email: second.email, role: 'admin' }).setRole({
        userId: second.id,
        role: 'engineer',
      }),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(await countActiveAdmins()).toBe(1)
  }, 30_000)
})
