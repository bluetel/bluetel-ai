import { describe, expect, it } from 'vitest'

import { columnOf, describeTable, indexOf, referencedTables } from './introspect'
import {
  configurationAudit,
  notificationPreferences,
  notifications,
  workflowWatchers,
} from './notify'

describe('notifications', () => {
  it('is append-only', () => {
    expect(describeTable(notifications).columns.map((column) => column.name)).not.toContain(
      'updated_at',
    )
  })

  it('records the attempt including its failure, without touching workflow state (FR-141)', () => {
    expect(columnOf(notifications, 'outcome').notNull).toBe(true)
    expect(columnOf(notifications, 'outcome').type).toBe('notification_outcome')
    expect(columnOf(notifications, 'error').notNull).toBe(false)
  })

  it('always names a recipient', () => {
    expect(columnOf(notifications, 'recipient_user_id').notNull).toBe(true)
  })

  it('allows a null workflow, because the FR-139 tick summary is about many of them', () => {
    expect(columnOf(notifications, 'workflow_id').notNull).toBe(false)
    expect([...referencedTables(notifications)].sort()).toStrictEqual(['users', 'workflows'])
  })

  it('defaults to the only channel in scope (FR-136)', () => {
    expect(columnOf(notifications, 'channel').defaultValue).toBe('slack_dm')
    expect(columnOf(notifications, 'channel').notNull).toBe(true)
  })

  it('records how many transitions one message coalesced (FR-139)', () => {
    expect(columnOf(notifications, 'coalesced_count').defaultValue).toBe(1)
    expect(columnOf(notifications, 'coalesced_count').notNull).toBe(true)
  })
})

describe('notification_preferences', () => {
  it('defaults enabled to TRUE — absence of a row means notified, not silent (FR-138)', () => {
    expect(columnOf(notificationPreferences, 'enabled').defaultValue).toBe(true)
    expect(columnOf(notificationPreferences, 'enabled').notNull).toBe(true)
  })

  it('never lets enabled be null, so "no opinion" is the missing row rather than a null', () => {
    expect(columnOf(notificationPreferences, 'enabled').notNull).toBe(true)
    expect(columnOf(notificationPreferences, 'enabled').hasDefault).toBe(true)
  })

  it('allows at most one preference per user per event (FR-138)', () => {
    const index = indexOf(notificationPreferences, 'notification_preferences_event_key')
    expect(index.unique).toBe(true)
    expect(index.columns).toStrictEqual(['user_id', 'event'])
  })

  it('constrains the event to the same closed set notifications record', () => {
    expect(columnOf(notificationPreferences, 'event').type).toBe('notification_event')
    expect(columnOf(notifications, 'event').type).toBe('notification_event')
  })
})

describe('workflow_watchers', () => {
  it('allows one watch per user per workflow (FR-138)', () => {
    const index = indexOf(workflowWatchers, 'workflow_watchers_user_key')
    expect(index.unique).toBe(true)
    expect(index.columns).toStrictEqual(['workflow_id', 'user_id'])
  })

  it('carries no preferences of its own — a watcher is filtered by their own (FR-138)', () => {
    expect(describeTable(workflowWatchers).columns.map((column) => column.name)).toStrictEqual([
      'id',
      'workflow_id',
      'user_id',
      'created_at',
    ])
  })
})

describe('configuration_audit', () => {
  it('is append-only (FR-178)', () => {
    expect(describeTable(configurationAudit).columns.map((column) => column.name)).not.toContain(
      'updated_at',
    )
  })

  it('allows a null actor for the deploy-time bootstrap reconcile (FR-174)', () => {
    expect(columnOf(configurationAudit, 'actor_user_id').notNull).toBe(false)
    expect(referencedTables(configurationAudit)).toStrictEqual(['users'])
  })

  it('points at a version, so an audit row for an edit points at content that still exists', () => {
    expect(columnOf(configurationAudit, 'entity_version').notNull).toBe(false)
    expect(columnOf(configurationAudit, 'entity_id').type).toBe('uuid')
    expect(columnOf(configurationAudit, 'entity_type').notNull).toBe(true)
    expect(columnOf(configurationAudit, 'action').notNull).toBe(true)
  })

  it('indexes the per-entity history newest-first', () => {
    expect(indexOf(configurationAudit, 'configuration_audit_entity_idx').columns).toStrictEqual([
      'entity_type',
      'entity_id',
      'created_at',
    ])
  })
})
