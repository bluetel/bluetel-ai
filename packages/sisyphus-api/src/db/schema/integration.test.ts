import { describe, expect, it } from 'vitest'

import { integrationMappings, integrationRuns, integrations, ticketClaims } from './integration'
import { columnOf, describeTable, indexOf, referencedTables } from './introspect'

describe('integrations', () => {
  it('requires prompt_intro (FR-158) — a run started from an empty intro is not described', () => {
    expect(columnOf(integrations, 'prompt_intro').notNull).toBe(true)
    expect(columnOf(integrations, 'prompt_intro').type).toBe('text')
    expect(columnOf(integrations, 'prompt_intro').hasDefault).toBe(false)
  })

  it('carries no repository, branch, model, caps or bundle — those come from the profile (FR-096)', () => {
    const names = describeTable(integrations).columns.map((column) => column.name)
    for (const forbidden of [
      'repository_url',
      'base_branch',
      'model',
      'instance_type',
      'turn_cap',
      'spend_cap',
      'setup_bundle_id',
      'setup_bundle_version_id',
      'workspace_id',
    ]) {
      expect(names).not.toContain(forbidden)
    }
  })

  it('holds a secret reference rather than a secret', () => {
    expect(columnOf(integrations, 'credential_secret_arn').notNull).toBe(true)
    const names = describeTable(integrations).columns.map((column) => column.name)
    expect(names).not.toContain('credential')
    expect(names).not.toContain('api_token')
  })

  it('allows a null default owner but cannot be enabled without one (FR-133)', () => {
    expect(columnOf(integrations, 'default_owner_user_id').notNull).toBe(false)
    expect(columnOf(integrations, 'enabled').defaultValue).toBe(false)
  })

  it('records why it auto-disabled, and keeps the schedule in lockstep (FR-100, FR-105)', () => {
    expect(columnOf(integrations, 'consecutive_failures').defaultValue).toBe(0)
    expect(columnOf(integrations, 'auto_disabled_reason').notNull).toBe(false)
    expect(columnOf(integrations, 'schedule_arn').notNull).toBe(false)
  })

  it('bounds how much one tick and one rolling period may start', () => {
    for (const name of ['per_tick_ceiling', 'rolling_period_ceiling', 'rolling_period_minutes']) {
      expect(columnOf(integrations, name).notNull).toBe(true)
    }
  })

  it('has a unique name', () => {
    expect(indexOf(integrations, 'integrations_name_key').unique).toBe(true)
  })
})

describe('integration_mappings', () => {
  it('keeps first-match deterministic with a unique position (FR-130)', () => {
    const index = indexOf(integrationMappings, 'integration_mappings_position_key')
    expect(index.unique).toBe(true)
    expect(index.columns).toStrictEqual(['integration_id', 'position'])
  })

  it('resolves to a profile, which is where the launch values live', () => {
    expect(columnOf(integrationMappings, 'execution_profile_id').notNull).toBe(true)
    expect([...referencedTables(integrationMappings)].sort()).toStrictEqual([
      'execution_profiles',
      'integrations',
    ])
  })

  it('requires criteria, so a mapping cannot match everything by accident', () => {
    expect(columnOf(integrationMappings, 'criteria').notNull).toBe(true)
    expect(columnOf(integrationMappings, 'is_default').defaultValue).toBe(false)
  })
})

describe('integration_runs', () => {
  it('is append-only', () => {
    const names = describeTable(integrationRuns).columns.map((column) => column.name)
    expect(names).not.toContain('updated_at')
  })

  it('makes a silently-failing connector visible (FR-105)', () => {
    for (const name of ['examined_count', 'matched_count', 'started_count', 'skipped_count']) {
      expect(columnOf(integrationRuns, name).notNull).toBe(true)
      expect(columnOf(integrationRuns, name).defaultValue).toBe(0)
    }
    expect(columnOf(integrationRuns, 'skip_reasons').type).toBe('jsonb')
    expect(columnOf(integrationRuns, 'error').notNull).toBe(false)
  })

  it('distinguishes a scheduled tick from a manual one', () => {
    expect(columnOf(integrationRuns, 'trigger').type).toBe('integration_trigger')
  })

  it('indexes an integration history newest-first', () => {
    expect(indexOf(integrationRuns, 'integration_runs_integration_idx').columns).toStrictEqual([
      'integration_id',
      'started_at',
    ])
  })
})

describe('ticket_claims', () => {
  it('makes exactly-once claiming hold at the database (FR-102)', () => {
    const index = indexOf(ticketClaims, 'ticket_claims_external_key')
    expect(index.unique).toBe(true)
    expect(index.columns).toStrictEqual(['integration_id', 'external_id'])
  })

  it('makes that index unconditional, so a restart or an overlapping tick cannot slip past it', () => {
    expect(indexOf(ticketClaims, 'ticket_claims_external_key').where).toBeUndefined()
  })

  it('scopes the claim to one integration, so two boards can carry the same ticket key', () => {
    expect(columnOf(ticketClaims, 'integration_id').notNull).toBe(true)
    expect(columnOf(ticketClaims, 'external_id').notNull).toBe(true)
  })

  it('allows a null workflow, so the claim can be taken in the creating transaction', () => {
    expect(columnOf(ticketClaims, 'workflow_id').notNull).toBe(false)
    expect([...referencedTables(ticketClaims)].sort()).toStrictEqual(['integrations', 'workflows'])
  })
})
