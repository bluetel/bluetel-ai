import { randomUUID } from 'node:crypto'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { ListConfigurationAuditInput } from './audit'
import {
  auditRouter,
  entityHistoryInput,
  listConfigurationAudit,
  listConfigurationAuditInput,
  readConfigurationHistory,
} from './audit'
import { AUDITED_ACTIONS, AUDITED_ENTITY_TYPES, recordConfigurationChange } from './audit-log'
import type { UserFixtures } from './test-database'
import { createUserFixtures, readTestDatabaseUrl } from './test-database'

/**
 * `admin.audit` — the read side of FR-178.
 *
 * The trail has been written since the first bundle was registered and could not be read. What
 * these tests hold in place is that reading it stayed *the same table*: the filters accept exactly
 * the vocabulary the writer uses, a platform-initiated change is still visible as one, and the page
 * is a keyset page like every other admin list rather than an offset that shifts under a concurrent
 * insert.
 */

const connectionString = readTestDatabaseUrl()

const parse = (input: Record<string, unknown> = {}): ListConfigurationAuditInput =>
  listConfigurationAuditInput.parse(input)

describe('listConfigurationAuditInput', () => {
  it('accepts nothing at all, and that means the whole trail', () => {
    const parsed = parse()

    expect(parsed.entityType).toBeUndefined()
    expect(parsed.entityId).toBeUndefined()
    expect(parsed.actorUserId).toBeUndefined()
    expect(parsed.from).toBeUndefined()
    expect(parsed.to).toBeUndefined()
  })

  it('pages like every other admin list — a bounded limit and a cursor, not an offset', () => {
    expect(parse().limit).toBe(50)
    expect(parse({ limit: 10 }).limit).toBe(10)
    expect(() => parse({ limit: 500 })).toThrow()
    expect(() => parse({ cursor: 'not-an-id' })).toThrow()
  })

  it('takes its entity vocabulary from the writer, not from a copy of it', () => {
    // If a class is added to `AUDITED_ENTITY_TYPES` the filter accepts it the same day. A
    // hand-written `z.enum([...])` here would be a second opinion that compiles.
    for (const entityType of AUDITED_ENTITY_TYPES) {
      expect(parse({ entityType }).entityType).toBe(entityType)
    }

    expect(() => parse({ entityType: 'not_an_entity' })).toThrow()
  })

  it('takes its action vocabulary from the writer too', () => {
    for (const action of AUDITED_ACTIONS) {
      expect(parse({ action }).action).toBe(action)
    }

    expect(() => parse({ action: 'deleted' })).toThrow()
  })

  it('accepts an entity id on its own — ids are unique across the platform', () => {
    const entityId = randomUUID()

    expect(parse({ entityId }).entityId).toBe(entityId)
    expect(() => parse({ entityId: 'bundle-1' })).toThrow()
  })

  it('has no spelling for the platform actor, because it is not a user', () => {
    // A platform-initiated change records a null actor (FR-174). Accepting `'system'` here would
    // put a name on something the trail deliberately leaves unnamed.
    expect(() => parse({ actorUserId: 'system' })).toThrow()
  })

  it('takes a time window at both ends, independently', () => {
    const from = new Date('2026-01-01T00:00:00.000Z')
    const to = new Date('2026-02-01T00:00:00.000Z')

    expect(parse({ from }).from).toStrictEqual(from)
    expect(parse({ to }).to).toStrictEqual(to)
    expect(parse({ from, to })).toMatchObject({ from, to })
  })
})

describe('entityHistoryInput', () => {
  it('requires both halves of the identity, because it reads a composite index', () => {
    expect(() => entityHistoryInput.parse({ entityId: randomUUID() })).toThrow()
    expect(() => entityHistoryInput.parse({ entityType: 'setup_bundle' })).toThrow()
    expect(
      entityHistoryInput.parse({ entityType: 'setup_bundle', entityId: randomUUID() }).limit,
    ).toBe(50)
  })
})

describe('auditRouter', () => {
  it('exposes exactly the two reads, and no mutation — the table is append-only', () => {
    expect(Object.keys(auditRouter._def.procedures).sort()).toStrictEqual(['forEntity', 'list'])

    for (const procedure of Object.values(auditRouter._def.procedures)) {
      expect((procedure as { _def: { type: string } })._def.type).toBe('query')
    }
  })
})

describe.skipIf(connectionString === undefined)(
  'the configuration trail against a live database',
  () => {
    let fixture: UserFixtures

    beforeAll(async () => {
      fixture = createUserFixtures(connectionString ?? '')
      await fixture.open()
    }, 60_000)

    afterAll(async () => {
      await fixture.close()
    }, 30_000)

    afterEach(async () => {
      await fixture.removeAll()
    })

    /** An admin to attribute changes to, and a second one to filter them apart from. */
    const seedAdmin = async (label: string): Promise<string> =>
      (await fixture.seedUser({ label, role: 'admin' })).id

    const record = async (options: {
      readonly actorUserId: string | null
      readonly entityType: (typeof AUDITED_ENTITY_TYPES)[number]
      readonly entityId: string
      readonly action: (typeof AUDITED_ACTIONS)[number]
      readonly detail?: Record<string, unknown>
    }): Promise<void> => {
      await recordConfigurationChange(fixture.db(), options)
    }

    it('reads back what recordConfigurationChange wrote, newest first', async () => {
      const admin = await seedAdmin('newest')
      const bundle = randomUUID()

      await record({
        actorUserId: admin,
        entityType: 'setup_bundle',
        entityId: bundle,
        action: 'registered',
      })
      await record({
        actorUserId: admin,
        entityType: 'setup_bundle',
        entityId: bundle,
        action: 'replaced',
      })
      await record({
        actorUserId: admin,
        entityType: 'setup_bundle',
        entityId: bundle,
        action: 'disabled',
      })

      const page = await listConfigurationAudit({
        db: fixture.db(),
        input: parse({ entityId: bundle }),
      })

      expect(page.items.map((row) => row.action)).toStrictEqual([
        'disabled',
        'replaced',
        'registered',
      ])
    })

    it('resolves the acting admin, so the trail is readable rather than a list of ids', async () => {
      const admin = await seedAdmin('named')
      const workspace = randomUUID()

      await record({
        actorUserId: admin,
        entityType: 'workspace',
        entityId: workspace,
        action: 'updated',
      })

      const page = await listConfigurationAudit({
        db: fixture.db(),
        input: parse({ entityId: workspace }),
      })

      expect(page.items[0]?.actorUserId).toBe(admin)
      expect(page.items[0]?.actorEmail).toContain('named')
      expect(page.items[0]?.actorDisplayName).toBe('Fixture named')
    })

    it('keeps a platform-initiated change in the trail, with no actor rather than a fake one', async () => {
      // The `left join` earning its keep: joining inner would silently drop exactly the changes no
      // human is accountable for (FR-174).
      const user = randomUUID()
      await record({
        actorUserId: null,
        entityType: 'user',
        entityId: user,
        action: 'role_changed',
      })

      const page = await listConfigurationAudit({
        db: fixture.db(),
        input: parse({ entityId: user }),
      })

      expect(page.items).toHaveLength(1)
      expect(page.items[0]?.actorUserId).toBeNull()
      expect(page.items[0]?.actorEmail).toBeNull()
    })

    it('excludes platform-initiated changes from an actor-filtered read', async () => {
      const admin = await seedAdmin('actor')
      const entityId = randomUUID()

      await record({ actorUserId: admin, entityType: 'integration', entityId, action: 'enabled' })
      await record({ actorUserId: null, entityType: 'integration', entityId, action: 'disabled' })

      const page = await listConfigurationAudit({
        db: fixture.db(),
        input: parse({ entityId, actorUserId: admin }),
      })

      expect(page.items.map((row) => row.action)).toStrictEqual(['enabled'])
    })

    it('filters by actor, so two admins’ changes are separable', async () => {
      const first = await seedAdmin('first')
      const second = await seedAdmin('second')
      const entityId = randomUUID()

      await record({
        actorUserId: first,
        entityType: 'execution_profile',
        entityId,
        action: 'updated',
      })
      await record({
        actorUserId: second,
        entityType: 'execution_profile',
        entityId,
        action: 'disabled',
      })

      const page = await listConfigurationAudit({
        db: fixture.db(),
        input: parse({ entityId, actorUserId: second }),
      })

      expect(page.items).toHaveLength(1)
      expect(page.items[0]?.action).toBe('disabled')
    })

    it('filters by entity type and by action independently', async () => {
      const admin = await seedAdmin('classes')
      const bundle = randomUUID()
      const profile = randomUUID()

      await record({
        actorUserId: admin,
        entityType: 'setup_bundle',
        entityId: bundle,
        action: 'registered',
      })
      await record({
        actorUserId: admin,
        entityType: 'execution_profile',
        entityId: profile,
        action: 'registered',
      })
      await record({
        actorUserId: admin,
        entityType: 'execution_profile',
        entityId: profile,
        action: 'disabled',
      })

      const byType = await listConfigurationAudit({
        db: fixture.db(),
        input: parse({ entityType: 'execution_profile', actorUserId: admin }),
      })
      const byAction = await listConfigurationAudit({
        db: fixture.db(),
        input: parse({ action: 'registered', actorUserId: admin }),
      })

      expect(byType.items).toHaveLength(2)
      expect(byAction.items).toHaveLength(2)
      expect(byAction.items.every((row) => row.action === 'registered')).toBe(true)
    })

    it('narrows to a time window, inclusively at both ends', async () => {
      const admin = await seedAdmin('window')
      const entityId = randomUUID()
      const before = new Date(Date.now() - 60_000)

      await record({ actorUserId: admin, entityType: 'workspace', entityId, action: 'updated' })

      const inside = await listConfigurationAudit({
        db: fixture.db(),
        input: parse({ entityId, from: before }),
      })
      const outside = await listConfigurationAudit({
        db: fixture.db(),
        input: parse({ entityId, to: before }),
      })

      expect(inside.items).toHaveLength(1)
      expect(outside.items).toStrictEqual([])
    })

    it('pages by cursor, and the cursor is a row the caller has seen', async () => {
      const admin = await seedAdmin('paged')
      const entityId = randomUUID()

      for (const action of ['registered', 'replaced', 'enabled', 'disabled'] as const) {
        await record({ actorUserId: admin, entityType: 'setup_bundle', entityId, action })
      }

      const first = await listConfigurationAudit({
        db: fixture.db(),
        input: parse({ entityId, limit: 2 }),
      })

      expect(first.items).toHaveLength(2)
      expect(first.nextCursor).toBe(first.items[1]?.id)

      const second = await listConfigurationAudit({
        db: fixture.db(),
        input: parse({ entityId, limit: 2, cursor: first.nextCursor }),
      })

      expect(second.items).toHaveLength(2)
      expect(second.nextCursor).toBeUndefined()
      // No overlap and no gap: four rows across two pages, each seen once.
      expect(new Set([...first.items, ...second.items].map((row) => row.id)).size).toBe(4)
    })

    it('carries the recorded detail through unchanged, because that is what makes an entry legible', async () => {
      const admin = await seedAdmin('detail')
      const entityId = randomUUID()

      await record({
        actorUserId: admin,
        entityType: 'setup_bundle',
        entityId,
        action: 'registered',
        detail: { digest: 'sha256:abc', sizeBytes: 4096 },
      })

      const page = await listConfigurationAudit({ db: fixture.db(), input: parse({ entityId }) })

      expect(page.items[0]?.detail).toStrictEqual({ digest: 'sha256:abc', sizeBytes: 4096 })
    })

    it('agrees with readEntityHistory for the fully-narrowed question', async () => {
      // The two paths answer the same question about one entity, and the general one degenerating to
      // something different from the indexed one is the failure worth catching.
      const admin = await seedAdmin('agree')
      const entityId = randomUUID()

      await record({ actorUserId: admin, entityType: 'workspace', entityId, action: 'updated' })
      await record({ actorUserId: admin, entityType: 'workspace', entityId, action: 'disabled' })

      const listed = await listConfigurationAudit({
        db: fixture.db(),
        input: parse({ entityType: 'workspace', entityId }),
      })
      const history = await readConfigurationHistory({
        db: fixture.db(),
        input: entityHistoryInput.parse({ entityType: 'workspace', entityId }),
      })

      expect(listed.items.map((row) => row.id)).toStrictEqual(history.map((row) => row.id))
    })
  },
)
