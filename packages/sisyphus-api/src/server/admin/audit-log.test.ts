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
      'agent_credential',
      'credential_group',
    ])
  })

  it('covers bundle registration, replacement, enable and disable', () => {
    for (const action of ['registered', 'replaced', 'enabled', 'disabled'] as const) {
      expect(AUDITED_ACTIONS).toContain(action)
    }
  })

  /**
   * 003/FR-058 and 003/FR-067: the credential pool's vocabulary.
   *
   * All four actions land here in one change even though only some have writers yet, so the trail
   * cannot acquire two spellings of the same event across the three later phases that write them.
   * A divergence would be invisible to every test — both spellings are valid `text` — and visible
   * only to somebody searching the table with the wrong word.
   */
  it('covers the credential entities the pool records against (003/FR-004, 003/FR-067)', () => {
    expect(AUDITED_ENTITY_TYPES).toContain('agent_credential')
    expect(AUDITED_ENTITY_TYPES).toContain('credential_group')
  })

  it('covers every lease event and credential state change (003/FR-058)', () => {
    for (const action of ['leased', 'released', 'force_released', 'state_changed'] as const) {
      expect(AUDITED_ACTIONS).toContain(action)
    }
  })

  it('keeps a forced release distinct from an ordinary one', () => {
    // A seat that came free because its run finished and a seat taken off a run are different
    // events. Collapsed into one word, the trail could not answer "was anything forced?".
    expect(AUDITED_ACTIONS).toContain('released')
    expect(AUDITED_ACTIONS).toContain('force_released')
  })

  it('needs no migration to widen, because both columns are text', () => {
    // `configuration_audit.entity_type` and `.action` are `text('…')` in `db/schema/notify.ts`,
    // not `pgEnum`s — so these tuples are closed in TypeScript and open in Postgres. Asserted
    // rather than assumed: the day either column became an enum, this test is what would say so.
    expect(configurationAudit.entityType.getSQLType()).toBe('text')
    expect(configurationAudit.action.getSQLType()).toBe('text')
    expect(configurationAudit.entityType.enumValues).toBeUndefined()
    expect(configurationAudit.action.enumValues).toBeUndefined()
  })
})

describe('recording a credential change', () => {
  it('writes a lease acquisition against the credential, naming the workflow (003/FR-058)', async () => {
    const { writer, values } = createInsertWriter()

    await recordConfigurationChange(writer, {
      actorUserId: null,
      entityType: 'agent_credential',
      entityId: 'credential-1',
      action: 'leased',
      detail: { workflowId: 'workflow-1', fence: 4 },
    })

    // `actorUserId` is null because a workflow reservation has no human behind it — the same
    // reading FR-174's bootstrap reconcile gets. The holder is in `detail`, where it belongs.
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: null,
        entityType: 'agent_credential',
        action: 'leased',
        detail: { workflowId: 'workflow-1', fence: 4 },
      }),
    )
  })

  it('records an attachment change against the group, naming the profile (003/FR-067)', async () => {
    const { writer, values } = createInsertWriter()

    await recordConfigurationChange(writer, {
      actorUserId: 'admin-1',
      entityType: 'credential_group',
      entityId: 'group-1',
      action: 'updated',
      detail: { executionProfileId: 'profile-1', position: 2 },
    })

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'admin-1',
        entityType: 'credential_group',
        entityId: 'group-1',
      }),
    )
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
