import { describe, expect, it, vi } from 'vitest'

import { configurationAudit } from '../../db'

import type { AuditWriter } from './audit-log'
import {
  AUDITED_ACTIONS,
  AUDITED_ENTITY_TYPES,
  readEntityHistory,
  recordConfigurationChange,
} from './audit-log'

/**
 * A recording stand-in for the database handle. The point of these tests is the *shape* of what is
 * written — which table, which columns, what a caller omitting a field ends up storing — none of
 * which needs a connection. The live-database behaviour is covered by the routers that call this.
 */
const createInsertWriter = () => {
  const values = vi.fn().mockResolvedValue(undefined)
  const insert = vi.fn().mockReturnValue({ values })
  return { writer: { insert, select: vi.fn() } as unknown as AuditWriter, insert, values }
}

const createSelectWriter = (rows: unknown[]) => {
  const limit = vi.fn().mockResolvedValue(rows)
  const orderBy = vi.fn().mockReturnValue({ limit })
  const where = vi.fn().mockReturnValue({ orderBy })
  const from = vi.fn().mockReturnValue({ where })
  const select = vi.fn().mockReturnValue({ from })
  return { writer: { insert: vi.fn(), select } as unknown as AuditWriter, from, limit }
}

describe('recordConfigurationChange', () => {
  it('writes to configuration_audit', async () => {
    const { writer, insert } = createInsertWriter()

    await recordConfigurationChange(writer, {
      actorUserId: 'admin-1',
      entityType: 'setup_bundle',
      entityId: 'bundle-1',
      action: 'registered',
    })

    expect(insert).toHaveBeenCalledWith(configurationAudit)
  })

  it('records the acting admin', async () => {
    const { writer, values } = createInsertWriter()

    await recordConfigurationChange(writer, {
      actorUserId: 'admin-1',
      entityType: 'setup_bundle',
      entityId: 'bundle-1',
      action: 'enabled',
      entityVersion: 3,
      detail: { digest: 'sha256:abc' },
    })

    expect(values).toHaveBeenCalledWith({
      actorUserId: 'admin-1',
      entityType: 'setup_bundle',
      entityId: 'bundle-1',
      entityVersion: 3,
      action: 'enabled',
      detail: { digest: 'sha256:abc' },
    })
  })

  it('keeps a platform-initiated change as an explicit null actor, not a placeholder id', async () => {
    // FR-174's bootstrap reconcile has no human behind it. Writing a sentinel user id here would
    // make the trail claim a person acted who did not.
    const { writer, values } = createInsertWriter()

    await recordConfigurationChange(writer, {
      actorUserId: null,
      entityType: 'user',
      entityId: 'user-1',
      action: 'role_changed',
      detail: { from: 'engineer', to: 'admin', source: 'bootstrap' },
    })

    expect(values.mock.calls[0]?.[0]).toMatchObject({ actorUserId: null })
  })

  it('nulls the optional columns rather than leaving them undefined', async () => {
    const { writer, values } = createInsertWriter()

    await recordConfigurationChange(writer, {
      actorUserId: 'admin-1',
      entityType: 'workspace',
      entityId: 'workspace-1',
      action: 'updated',
    })

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ entityVersion: null, detail: null }),
    )
  })

  it('propagates a write failure instead of swallowing it', async () => {
    // A silently-dropped audit row is the failure mode this module exists to prevent, so the
    // caller's transaction must be able to roll back on it.
    const values = vi.fn().mockRejectedValue(new Error('deadlock detected'))
    const writer = {
      insert: vi.fn().mockReturnValue({ values }),
      select: vi.fn(),
    } as unknown as AuditWriter

    await expect(
      recordConfigurationChange(writer, {
        actorUserId: 'admin-1',
        entityType: 'integration',
        entityId: 'integration-1',
        action: 'disabled',
      }),
    ).rejects.toThrow('deadlock detected')
  })

  it('accepts a transaction handle, so the audit row commits with the change it describes', async () => {
    const { writer, insert } = createInsertWriter()
    // `AuditWriter` is structural precisely so a `db.transaction(async (tx) => …)` callback can
    // pass `tx` here without a cast; this asserts the narrow surface is all that is required.
    const transactionShaped: AuditWriter = { insert: writer.insert, select: writer.select }

    await recordConfigurationChange(transactionShaped, {
      actorUserId: 'admin-1',
      entityType: 'profile_access_grant',
      entityId: 'grant-1',
      action: 'granted',
    })

    expect(insert).toHaveBeenCalledOnce()
  })
})

describe('audit vocabularies', () => {
  it('distinguishes replacement from update', () => {
    // Replacing a bundle archive creates a new version and leaves the old one immutable (FR-090);
    // collapsing it into `updated` would lose that distinction in the trail.
    expect(AUDITED_ACTIONS).toContain('replaced')
    expect(AUDITED_ACTIONS).toContain('updated')
  })

  it('covers every entity class whose change FR-178 requires recording', () => {
    expect([...AUDITED_ENTITY_TYPES]).toEqual([
      'setup_bundle',
      'workspace',
      'execution_profile',
      'integration',
      'user',
      'profile_access_grant',
      'workflow',
    ])
  })

  it('covers bundle registration, replacement, enable and disable', () => {
    for (const action of ['registered', 'replaced', 'enabled', 'disabled'] as const) {
      expect(AUDITED_ACTIONS).toContain(action)
    }
  })
})

describe('readEntityHistory', () => {
  it('reads the audit table newest-first with a default bound', async () => {
    const { writer, from, limit } = createSelectWriter([])

    await readEntityHistory(writer, { entityType: 'setup_bundle', entityId: 'bundle-1' })

    expect(from).toHaveBeenCalledWith(configurationAudit)
    expect(limit).toHaveBeenCalledWith(50)
  })

  it('honours an explicit limit', async () => {
    const { writer, limit } = createSelectWriter([])

    await readEntityHistory(writer, {
      entityType: 'user',
      entityId: 'user-1',
      limit: 5,
    })

    expect(limit).toHaveBeenCalledWith(5)
  })

  it('returns the rows it read', async () => {
    const rows = [{ id: 'audit-1' }]
    const { writer } = createSelectWriter(rows)

    await expect(
      readEntityHistory(writer, { entityType: 'workspace', entityId: 'workspace-1' }),
    ).resolves.toBe(rows)
  })
})
