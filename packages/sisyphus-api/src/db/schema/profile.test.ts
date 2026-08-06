import { describe, expect, it } from 'vitest'

import { columnOf, describeTable, indexOf, referencedTables } from './introspect'
import {
  executionProfiles,
  executionProfileVersions,
  workspaceEntries,
  workspaces,
  workspaceVersions,
} from './profile'

const columnNames = (table: Parameters<typeof describeTable>[0]) =>
  describeTable(table).columns.map((column) => column.name)

describe('workspaces', () => {
  it('holds identity and pointer state only — no entries and no launch values', () => {
    const names = columnNames(workspaces)
    expect(names).toContain('current_version_id')
    expect(names).not.toContain('repository_url')
    expect(names).not.toContain('base_branch')
    expect(names).not.toContain('version')
  })

  it('archives rather than deletes (FR-128)', () => {
    expect(columnOf(workspaces, 'archived_at').notNull).toBe(false)
  })

  it('has a unique name and is disabled until enabled', () => {
    expect(indexOf(workspaces, 'workspaces_name_key').unique).toBe(true)
    expect(columnOf(workspaces, 'enabled').defaultValue).toBe(false)
  })
})

describe('workspace_versions', () => {
  it('is immutable once created', () => {
    expect(columnNames(workspaceVersions)).not.toContain('updated_at')
  })

  it('numbers versions uniquely within a workspace (FR-125)', () => {
    const index = indexOf(workspaceVersions, 'workspace_versions_version_key')
    expect(index.unique).toBe(true)
    expect(index.columns).toStrictEqual(['workspace_id', 'version'])
  })
})

describe('workspace_entries', () => {
  it('hangs off the VERSION, not the workspace — this is what makes FR-125 hold', () => {
    expect(columnOf(workspaceEntries, 'workspace_version_id').notNull).toBe(true)
    expect(columnNames(workspaceEntries)).not.toContain('workspace_id')
    expect(referencedTables(workspaceEntries)).toStrictEqual(['workspace_versions'])
  })

  it('allows exactly one primary entry per version (FR-110)', () => {
    const index = indexOf(workspaceEntries, 'workspace_entries_primary_key')
    expect(index.unique).toBe(true)
    expect(index.columns).toStrictEqual(['workspace_version_id'])
    expect(index.where).toBe('"workspace_entries"."is_primary"')
  })

  it('scopes the primary index to the version, so a new version may repeat the flag', () => {
    expect(indexOf(workspaceEntries, 'workspace_entries_primary_key').columns).not.toContain(
      'workspace_id',
    )
  })

  it('allows one entry per subdirectory per version (FR-111)', () => {
    const index = indexOf(workspaceEntries, 'workspace_entries_subdirectory_key')
    expect(index.unique).toBe(true)
    expect(index.columns).toStrictEqual(['workspace_version_id', 'subdirectory'])
  })

  it('orders entries deterministically', () => {
    expect(indexOf(workspaceEntries, 'workspace_entries_position_key').columns).toStrictEqual([
      'workspace_version_id',
      'position',
    ])
  })
})

describe('execution_profiles', () => {
  it('holds identity and pointer state only — every launch value is on the version', () => {
    const names = columnNames(executionProfiles)
    expect(names).toStrictEqual([
      'id',
      'name',
      'description',
      'current_version_id',
      'enabled',
      'archived_at',
      'created_at',
      'updated_at',
    ])
  })

  it('carries no model, caps, instance type or bundle of its own (FR-125)', () => {
    const names = columnNames(executionProfiles)
    for (const forbidden of [
      'model',
      'instance_type',
      'purchase_mode',
      'turn_cap',
      'spend_cap',
      'setup_bundle_id',
      'setup_bundle_version_id',
      'workspace_id',
      'workspace_version_id',
      'prompt_preamble',
    ]) {
      expect(names).not.toContain(forbidden)
    }
  })

  it('is disabled until validation passes (FR-124) and archived rather than deleted (FR-128)', () => {
    expect(columnOf(executionProfiles, 'enabled').defaultValue).toBe(false)
    expect(columnOf(executionProfiles, 'archived_at').notNull).toBe(false)
  })
})

describe('execution_profile_versions', () => {
  it('snapshots every launch value (FR-065, FR-125, FR-126)', () => {
    for (const name of [
      'workspace_version_id',
      'setup_bundle_version_id',
      'model',
      'instance_type',
      'purchase_mode',
      'turn_cap',
      'spend_cap',
      'default_workflow_type',
      'prompt_preamble',
      'locked_fields',
    ]) {
      expect(columnNames(executionProfileVersions)).toContain(name)
    }
  })

  it('pins the bundle VERSION and workspace VERSION, not their ids', () => {
    expect(columnOf(executionProfileVersions, 'setup_bundle_version_id').notNull).toBe(true)
    expect(columnOf(executionProfileVersions, 'workspace_version_id').notNull).toBe(true)
    expect([...referencedTables(executionProfileVersions)].sort()).toStrictEqual([
      'execution_profiles',
      'setup_bundle_versions',
      'users',
      'workspace_versions',
    ])
  })

  it('is immutable', () => {
    expect(columnNames(executionProfileVersions)).not.toContain('updated_at')
  })

  it('numbers versions uniquely within a profile (FR-125)', () => {
    const index = indexOf(executionProfileVersions, 'execution_profile_versions_version_key')
    expect(index.unique).toBe(true)
    expect(index.columns).toStrictEqual(['execution_profile_id', 'version'])
  })

  it('uses the model allowlist rather than free text (R15)', () => {
    expect(columnOf(executionProfileVersions, 'model').type).toBe('claude_model')
    expect(columnOf(executionProfileVersions, 'purchase_mode').defaultValue).toBe('spot')
  })

  it('keeps money as numeric and locked fields as a non-null array (FR-123)', () => {
    expect(columnOf(executionProfileVersions, 'spend_cap').type).toBe('numeric(12, 4)')
    expect(columnOf(executionProfileVersions, 'locked_fields').notNull).toBe(true)
    expect(columnOf(executionProfileVersions, 'locked_fields').defaultValue).toStrictEqual([])
  })
})
