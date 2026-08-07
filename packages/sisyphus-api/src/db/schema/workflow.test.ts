import { describe, expect, it } from 'vitest'

import { TERMINAL_OUTCOMES } from '../../enums'

import { columnOf, describeTable, indexOf, referencedTables } from './introspect'
import {
  bootstrapPhases,
  computeLeases,
  workflowEntries,
  workflowEvents,
  workflows,
} from './workflow'

describe('workflows', () => {
  it('always has exactly one accountable human owner (FR-132)', () => {
    expect(columnOf(workflows, 'owner_user_id').notNull).toBe(true)
  })

  it('allows a null initiator, because an integration-started run has no person (FR-131)', () => {
    expect(columnOf(workflows, 'initiated_by_user_id').notNull).toBe(false)
    expect(columnOf(workflows, 'originating_integration_id').notNull).toBe(false)
    expect(columnOf(workflows, 'originating_mapping_id').notNull).toBe(false)
  })

  it('allows a null profile, because an ad hoc run has none (FR-126)', () => {
    expect(columnOf(workflows, 'execution_profile_id').notNull).toBe(false)
    expect(columnOf(workflows, 'execution_profile_version_id').notNull).toBe(false)
  })

  it('pins the bundle version and the workspace version, not their parents (FR-125, FR-065)', () => {
    expect(columnOf(workflows, 'setup_bundle_version_id').notNull).toBe(true)
    expect(columnOf(workflows, 'workspace_version_id').notNull).toBe(true)
    const names = describeTable(workflows).columns.map((column) => column.name)
    expect(names).not.toContain('workspace_id')
    expect(names).not.toContain('setup_bundle_id')
  })

  it('carries the resolved job spec on the row, making it reconstructable (FR-149)', () => {
    for (const name of ['model', 'instance_type', 'purchase_mode']) {
      expect(columnOf(workflows, name).notNull).toBe(true)
    }
    expect(columnOf(workflows, 'turn_cap').notNull).toBe(false)
    expect(columnOf(workflows, 'spend_cap').type).toBe('numeric(12, 4)')
  })

  it('counts consumption in numeric, never a float', () => {
    expect(columnOf(workflows, 'spend_used').type).toBe('numeric(12, 4)')
    expect(columnOf(workflows, 'spend_used').defaultValue).toBe('0')
    expect(columnOf(workflows, 'turns_used').defaultValue).toBe(0)
    expect(columnOf(workflows, 'compute_cost_basis').type).toBe('numeric(12, 4)')
  })

  it('leaves terminal_outcome null until the run is terminal (FR-064)', () => {
    expect(columnOf(workflows, 'terminal_outcome').notNull).toBe(false)
    expect(columnOf(workflows, 'state').notNull).toBe(true)
  })

  it('names its outcome column after the FR-064 enum, so state and outcome share a vocabulary', () => {
    expect(TERMINAL_OUTCOMES).toContain('parked_resumable')
    expect(columnOf(workflows, 'terminal_outcome').type).toBe('terminal_outcome')
    expect(columnOf(workflows, 'state').type).toBe('workflow_state')
  })

  it('records the prompt as sent, and whether it was truncated (FR-162, FR-163)', () => {
    expect(columnOf(workflows, 'assembled_prompt').notNull).toBe(false)
    expect(columnOf(workflows, 'prompt_truncated').defaultValue).toBe(false)
  })

  it('assigns the session id before the agent starts (FR-052)', () => {
    expect(columnOf(workflows, 'session_id').notNull).toBe(true)
    expect(columnOf(workflows, 'session_id').type).toBe('uuid')
  })

  it('links successors to predecessors for summable consumption (FR-150, FR-152)', () => {
    expect(columnOf(workflows, 'predecessor_workflow_id').notNull).toBe(false)
    expect(referencedTables(workflows)).toContain('workflows')
    expect(indexOf(workflows, 'workflows_predecessor_idx').columns).toStrictEqual([
      'predecessor_workflow_id',
    ])
  })

  it('indexes the panel reads the data model names (FR-012, FR-013, FR-135)', () => {
    expect(indexOf(workflows, 'workflows_profile_state_idx').columns).toStrictEqual([
      'execution_profile_id',
      'state',
      'created_at',
    ])
    expect(indexOf(workflows, 'workflows_owner_state_idx').columns).toStrictEqual([
      'owner_user_id',
      'state',
    ])
    expect(indexOf(workflows, 'workflows_integration_idx').columns).toStrictEqual([
      'originating_integration_id',
      'created_at',
    ])
  })

  it('flags a run whose owner was deactivated rather than orphaning it (FR-176)', () => {
    expect(columnOf(workflows, 'needs_reassignment').defaultValue).toBe(false)
  })
})

describe('workflow_entries', () => {
  it('records the resolved commit per entry, so a run is reproducible (FR-079)', () => {
    expect(columnOf(workflowEntries, 'resolved_commit').notNull).toBe(false)
    expect(columnOf(workflowEntries, 'staleness_note').notNull).toBe(false)
  })

  it('allows at most one PR per entry and one entry result (FR-115, FR-118)', () => {
    expect(columnOf(workflowEntries, 'pull_request_url').notNull).toBe(false)
    expect(columnOf(workflowEntries, 'entry_result').type).toBe('entry_result')
  })

  it('indexes repository and branch as the FR-120 advisory-lock probe, not as a constraint', () => {
    const index = indexOf(workflowEntries, 'workflow_entries_repository_branch_idx')
    expect(index.columns).toStrictEqual(['repository_url', 'base_branch'])
    expect(index.unique).toBe(false)
  })

  it('resolves each entry from a version-pinned workspace entry', () => {
    expect(columnOf(workflowEntries, 'workspace_entry_id').notNull).toBe(true)
    expect([...referencedTables(workflowEntries)].sort()).toStrictEqual([
      'workflows',
      'workspace_entries',
    ])
  })
})

describe('workflow_events', () => {
  it('is append-only', () => {
    const names = describeTable(workflowEvents).columns.map((column) => column.name)
    expect(names).toContain('created_at')
    expect(names).not.toContain('updated_at')
  })

  it('attributes every transition to an actor (FR-064)', () => {
    expect(columnOf(workflowEvents, 'actor_type').notNull).toBe(true)
    expect(columnOf(workflowEvents, 'actor_user_id').notNull).toBe(false)
  })

  it('indexes the timeline the panel renders in order', () => {
    expect(indexOf(workflowEvents, 'workflow_events_workflow_idx').columns).toStrictEqual([
      'workflow_id',
      'created_at',
    ])
  })
})

describe('compute_leases', () => {
  it('makes FR-078 hold at the database: one live lease per workflow', () => {
    const index = indexOf(computeLeases, 'compute_leases_live_key')
    expect(index.unique).toBe(true)
    expect(index.columns).toStrictEqual(['workflow_id'])
    expect(index.where).toBe('"compute_leases"."released_at" is null')
  })

  it('scopes that index to live leases, so a workflow can legitimately be resumed later', () => {
    expect(indexOf(computeLeases, 'compute_leases_live_key').where).toBeDefined()
  })

  it('makes the FR-040 admission count cheap: a partial index over unreleased leases', () => {
    const index = indexOf(computeLeases, 'compute_leases_unreleased_idx')
    expect(index.unique).toBe(false)
    expect(index.columns).toStrictEqual(['released_at'])
    expect(index.where).toBe('"compute_leases"."released_at" is null')
  })

  it('counts leases rather than workflow rows, because a lease is what costs money', () => {
    expect(columnOf(computeLeases, 'workflow_id').notNull).toBe(true)
    expect(columnOf(computeLeases, 'instance_type').notNull).toBe(true)
    expect(columnOf(computeLeases, 'purchase_mode').notNull).toBe(true)
  })

  it('lets the reconciliation sweep see a lapsed heartbeat and a release reason (FR-039, FR-048)', () => {
    expect(columnOf(computeLeases, 'last_heartbeat_at').notNull).toBe(false)
    expect(columnOf(computeLeases, 'release_reason').notNull).toBe(false)
    expect(columnOf(computeLeases, 'requested_at').hasDefault).toBe(true)
  })
})

describe('bootstrap_phases', () => {
  it('names the phase, so a timeout is attributable (FR-146)', () => {
    expect(columnOf(bootstrapPhases, 'phase').type).toBe('bootstrap_phase')
    expect(columnOf(bootstrapPhases, 'phase').notNull).toBe(true)
    expect(columnOf(bootstrapPhases, 'outcome').type).toBe('bootstrap_phase_outcome')
  })

  it('distinguishes timed_out from failed, which is the whole point of the table', () => {
    expect(columnOf(bootstrapPhases, 'outcome').notNull).toBe(false)
    expect(columnOf(bootstrapPhases, 'detail').notNull).toBe(false)
  })

  it('anchors a per-entry phase to its entry', () => {
    expect(columnOf(bootstrapPhases, 'entry_id').notNull).toBe(false)
    expect([...referencedTables(bootstrapPhases)].sort()).toStrictEqual([
      'workflow_entries',
      'workflows',
    ])
  })

  it('keeps the phases ordered without duplicates', () => {
    const index = indexOf(bootstrapPhases, 'bootstrap_phases_sequence_key')
    expect(index.unique).toBe(true)
    expect(index.columns).toStrictEqual(['workflow_id', 'sequence'])
  })
})
