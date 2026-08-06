import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createUserFixtures, readTestDatabaseUrl } from './test-database'
import { setUserActive, setUserRole } from './user-changes'
import { escapeSearchTerm, listRoleChanges, listUsers, paginate } from './user-queries'

describe('escapeSearchTerm', () => {
  it('neutralises the wildcards, so a search for a literal character finds it', () => {
    // Unescaped, a search for `100%` matches every user in the platform and a search for `a_b`
    // matches `axb`. Both look like the search working until someone checks the results.
    expect(escapeSearchTerm('100%')).toBe('100\\%')
    expect(escapeSearchTerm('a_b')).toBe('a\\_b')
  })

  it('escapes the escape character first, so it cannot be used to escape the escaping', () => {
    expect(escapeSearchTerm('a\\%b')).toBe('a\\\\\\%b')
  })

  it('leaves ordinary text alone', () => {
    expect(escapeSearchTerm('alice@example.com')).toBe('alice@example.com')
  })
})

describe('paginate', () => {
  const rows = [{ id: 'c' }, { id: 'b' }, { id: 'a' }]

  it('returns the page and a cursor when there is more to read', () => {
    expect(paginate(rows, 2)).toStrictEqual({ items: [{ id: 'c' }, { id: 'b' }], nextCursor: 'b' })
  })

  it('returns no cursor on the last page, so a caller stops rather than looping', () => {
    expect(paginate(rows, 3)).toStrictEqual({ items: rows, nextCursor: undefined })
  })

  it('handles an empty result without inventing a cursor', () => {
    expect(paginate([], 10)).toStrictEqual({ items: [], nextCursor: undefined })
  })

  it('cursors on the last row of the page, not on the over-fetched one', () => {
    // Cursoring on the extra row would skip it on the next page — an off-by-one that only shows up
    // once a list is longer than one page.
    expect(paginate(rows, 1).nextCursor).toBe('c')
  })
})

const connectionString = readTestDatabaseUrl()
const describeWithDatabase = connectionString === undefined ? describe.skip : describe

describeWithDatabase('the admin reads against a live database', () => {
  const fixtures = createUserFixtures(connectionString ?? '')

  beforeAll(() => fixtures.open(), 60_000)
  afterEach(() => fixtures.removeAll())
  afterAll(() => fixtures.close())

  it('lists a user with their role, active state and owned-run counts (FR-171)', async () => {
    const owner = await fixtures.seedUser({ label: 'owner', role: 'engineer' })
    await fixtures.seedWorkflow({ ownerUserId: owner.id, state: 'running' })
    await fixtures.seedWorkflow({ ownerUserId: owner.id, state: 'succeeded' })

    const page = await listUsers({
      db: fixtures.db(),
      input: { limit: 50, activeOnly: false, search: owner.email },
    })

    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      id: owner.id,
      email: owner.email,
      role: 'engineer',
      isActive: true,
      ownedWorkflowCount: 2,
      workflowsAwaitingReassignment: 0,
    })
  })

  it('counts the reassignment queue separately from total ownership (FR-176)', async () => {
    const admin = await fixtures.seedUser({ label: 'admin', role: 'admin' })
    const leaver = await fixtures.seedUser({ label: 'leaver', role: 'engineer' })
    await fixtures.seedWorkflow({ ownerUserId: leaver.id, state: 'running' })
    await fixtures.seedWorkflow({ ownerUserId: leaver.id, state: 'succeeded' })

    await fixtures
      .db()
      .transaction((writer) =>
        setUserActive({ writer, actorUserId: admin.id, userId: leaver.id, isActive: false }),
      )

    const page = await listUsers({
      db: fixtures.db(),
      input: { limit: 50, activeOnly: false, search: leaver.email },
    })

    expect(page.items[0]).toMatchObject({
      ownedWorkflowCount: 2,
      // Only the run still in flight. Flagging the finished one would fill the queue with history.
      workflowsAwaitingReassignment: 1,
    })
  })

  it('filters by role and by active state', async () => {
    const keeper = await fixtures.seedUser({ label: 'keeper', role: 'admin' })
    await fixtures.seedUser({ label: 'dormant', role: 'admin', isActive: false })
    await fixtures.seedUser({ label: 'plain', role: 'engineer' })

    const admins = await listUsers({
      db: fixtures.db(),
      input: { limit: 50, activeOnly: true, role: 'admin', search: fixtures.suffix },
    })

    expect(admins.items.map((user) => user.id)).toStrictEqual([keeper.id])
  })

  it('treats a search term as text, not as a pattern', async () => {
    const literal = await fixtures.seedUser({ label: 'has%percent' })
    await fixtures.seedUser({ label: 'plain' })

    const matched = await listUsers({
      db: fixtures.db(),
      input: { limit: 50, activeOnly: false, search: 'has%percent' },
    })

    expect(matched.items.map((user) => user.id)).toStrictEqual([literal.id])
  })

  it('pages by keyset, newest first, without repeating or skipping a row', async () => {
    const seeded = [
      await fixtures.seedUser({ label: 'page-1' }),
      await fixtures.seedUser({ label: 'page-2' }),
      await fixtures.seedUser({ label: 'page-3' }),
    ]
    // UUID v7 sorts in creation order, so newest-first is the reverse of the seeding order.
    const expected = [...seeded].reverse().map((user) => user.id)

    const first = await listUsers({
      db: fixtures.db(),
      input: { limit: 2, activeOnly: false, search: fixtures.suffix },
    })
    expect(first.items.map((user) => user.id)).toStrictEqual(expected.slice(0, 2))
    expect(first.nextCursor).toBe(expected[1])

    const second = await listUsers({
      db: fixtures.db(),
      input: { limit: 2, activeOnly: false, search: fixtures.suffix, cursor: first.nextCursor },
    })
    expect(second.items.map((user) => user.id)).toStrictEqual(expected.slice(2))
    expect(second.nextCursor).toBeUndefined()
  })

  it('reads the role history with both identities resolved, newest first (FR-177)', async () => {
    const admin = await fixtures.seedUser({ label: 'actor', role: 'admin' })
    const subject = await fixtures.seedUser({ label: 'subject', role: 'engineer' })

    await fixtures
      .db()
      .transaction((writer) =>
        setUserRole({ writer, actorUserId: admin.id, userId: subject.id, role: 'admin' }),
      )
    await fixtures.db().transaction((writer) =>
      setUserRole({
        writer,
        actorUserId: admin.id,
        userId: subject.id,
        role: 'engineer',
        reason: 'Left the client account.',
      }),
    )

    const history = await listRoleChanges({
      db: fixtures.db(),
      input: { limit: 50, subjectUserId: subject.id },
    })

    expect(history.items.map((entry) => entry.change)).toStrictEqual([
      'revoke_admin',
      'grant_admin',
    ])
    expect(history.items[0]).toMatchObject({
      actorUserId: admin.id,
      actorEmail: admin.email,
      subjectUserId: subject.id,
      subjectEmail: subject.email,
      reason: 'Left the client account.',
    })
  })
})
