import { describe, expect, it } from 'vitest'

import { setupBundles, setupBundleVersions, validationRuns } from './bundle'
import { columnOf, describeTable, indexOf, referencedTables } from './introspect'

describe('setup_bundles', () => {
  it('is disabled until an admin enables it (FR-167, FR-168)', () => {
    expect(columnOf(setupBundles, 'enabled').defaultValue).toBe(false)
    expect(columnOf(setupBundles, 'enabled').notNull).toBe(true)
  })

  it('records whether spend caps can actually be enforced (FR-093)', () => {
    expect(columnOf(setupBundles, 'spend_caps_enforceable').defaultValue).toBe(false)
    expect(columnOf(setupBundles, 'spend_caps_enforceable').notNull).toBe(true)
  })

  it('archives rather than deletes, because history references it (FR-092)', () => {
    expect(columnOf(setupBundles, 'archived_at').notNull).toBe(false)
    expect(describeTable(setupBundles).columns.map((column) => column.name)).not.toContain(
      'deleted_at',
    )
  })

  it('has a unique name', () => {
    expect(indexOf(setupBundles, 'setup_bundles_name_key').unique).toBe(true)
  })

  it('holds no archive location itself — a bundle is its versions', () => {
    const names = describeTable(setupBundles).columns.map((column) => column.name)
    expect(names).not.toContain('s3_key')
    expect(names).not.toContain('content_digest')
  })
})

describe('setup_bundle_versions', () => {
  it('is immutable: it has created_at and no updated_at (FR-090)', () => {
    const names = describeTable(setupBundleVersions).columns.map((column) => column.name)
    expect(names).toContain('created_at')
    expect(names).not.toContain('updated_at')
  })

  it('numbers versions uniquely within a bundle', () => {
    const index = indexOf(setupBundleVersions, 'setup_bundle_versions_version_key')
    expect(index.unique).toBe(true)
    expect(index.columns).toStrictEqual(['setup_bundle_id', 'version'])
  })

  it('carries the digest that makes immutability checkable rather than asserted', () => {
    expect(columnOf(setupBundleVersions, 'content_digest').notNull).toBe(true)
    expect(columnOf(setupBundleVersions, 's3_key').notNull).toBe(true)
    expect(columnOf(setupBundleVersions, 'size_bytes').type).toBe('bigint')
  })

  it('records who registered it', () => {
    expect(columnOf(setupBundleVersions, 'registered_by_user_id').notNull).toBe(true)
    expect([...referencedTables(setupBundleVersions)].sort()).toStrictEqual([
      'setup_bundles',
      'users',
    ])
  })
})

describe('validation_runs', () => {
  it('proves a bundle version, not a bundle (FR-147, FR-148)', () => {
    expect(columnOf(validationRuns, 'setup_bundle_version_id').notNull).toBe(true)
    expect(referencedTables(validationRuns)).toContain('setup_bundle_versions')
  })

  it('leaves outcome and end time null while the run is in flight', () => {
    expect(columnOf(validationRuns, 'outcome').notNull).toBe(false)
    expect(columnOf(validationRuns, 'ended_at').notNull).toBe(false)
    expect(columnOf(validationRuns, 'started_at').notNull).toBe(true)
  })

  it('records per-phase results, so a failure names the phase that failed', () => {
    expect(columnOf(validationRuns, 'phase_results').type).toBe('jsonb')
    expect(columnOf(validationRuns, 'output_s3_key').notNull).toBe(false)
  })

  it('attributes the run to whoever triggered it', () => {
    expect(columnOf(validationRuns, 'triggered_by_user_id').notNull).toBe(true)
  })
})
