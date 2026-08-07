import { describe, expect, it } from 'vitest'

import { columnOf, describeTable, indexOf, referencedTables } from './introspect'
import {
  corrections,
  externalActions,
  iterations,
  profileOverrides,
  reviewFindings,
  scopedCredentials,
  supervisionCommands,
} from './supervision'

describe('corrections', () => {
  it('is append-only', () => {
    expect(describeTable(corrections).columns.map((column) => column.name)).not.toContain(
      'updated_at',
    )
  })

  it('delivers in submission order without duplicate sequence numbers (FR-049)', () => {
    const index = indexOf(corrections, 'corrections_sequence_key')
    expect(index.unique).toBe(true)
    expect(index.columns).toStrictEqual(['workflow_id', 'sequence'])
  })

  it('starts pending and fails visibly rather than being dropped (FR-049, FR-081)', () => {
    expect(columnOf(corrections, 'delivery_outcome').defaultValue).toBe('pending')
    expect(columnOf(corrections, 'delivery_outcome').notNull).toBe(true)
    expect(columnOf(corrections, 'failure_reason').notNull).toBe(false)
  })

  it('records the state at submission, so a rejection is explicable afterwards', () => {
    expect(columnOf(corrections, 'workflow_state_at_submission').type).toBe('workflow_state')
    expect(columnOf(corrections, 'workflow_state_at_submission').notNull).toBe(true)
  })

  it('indexes the pending queue the executor polls', () => {
    const index = indexOf(corrections, 'corrections_pending_idx')
    expect(index.where).toBe(`"corrections"."delivery_outcome" = 'pending'`)
  })
})

describe('supervision_commands', () => {
  it('exists at all — without it a pause is a state row nothing on the instance reads', () => {
    expect(columnOf(supervisionCommands, 'command').type).toBe('supervision_command')
    expect(columnOf(supervisionCommands, 'workflow_id').notNull).toBe(true)
  })

  it('is ordered and exactly-once (FR-049)', () => {
    const index = indexOf(supervisionCommands, 'supervision_commands_sequence_key')
    expect(index.unique).toBe(true)
    expect(index.columns).toStrictEqual(['workflow_id', 'sequence'])
  })

  it('indexes the executor poll that SC-003 depends on', () => {
    const index = indexOf(supervisionCommands, 'supervision_commands_pending_idx')
    expect(index.unique).toBe(false)
    expect(index.columns).toStrictEqual(['workflow_id'])
    expect(index.where).toBe(`"supervision_commands"."delivery_outcome" = 'pending'`)
  })

  it('acknowledges rather than assuming delivery, so "paused" means paused on the instance', () => {
    expect(columnOf(supervisionCommands, 'acknowledged_at').notNull).toBe(false)
    expect(columnOf(supervisionCommands, 'delivery_outcome').defaultValue).toBe('pending')
    expect(columnOf(supervisionCommands, 'delivery_outcome').type).toBe(
      'supervision_delivery_outcome',
    )
  })

  it('attributes every command to a person', () => {
    expect(columnOf(supervisionCommands, 'requested_by_user_id').notNull).toBe(true)
  })
})

describe('profile_overrides', () => {
  it('records one row per deviation, with both values (FR-123)', () => {
    expect(columnOf(profileOverrides, 'used_value').notNull).toBe(true)
    expect(columnOf(profileOverrides, 'profile_value').notNull).toBe(false)
    expect(columnOf(profileOverrides, 'set_by_user_id').notNull).toBe(true)
  })

  it('allows only one override per field per run', () => {
    const index = indexOf(profileOverrides, 'profile_overrides_field_key')
    expect(index.unique).toBe(true)
    expect(index.columns).toStrictEqual(['workflow_id', 'field'])
  })
})

describe('external_actions', () => {
  it('makes a retry unable to produce a duplicate PR or comment (FR-077)', () => {
    const index = indexOf(externalActions, 'external_actions_idempotency_key')
    expect(index.unique).toBe(true)
    expect(index.columns).toStrictEqual(['workflow_id', 'kind', 'idempotency_key'])
    expect(index.where).toBeUndefined()
  })

  it('requires the idempotency key rather than letting it be optional', () => {
    expect(columnOf(externalActions, 'idempotency_key').notNull).toBe(true)
    expect(columnOf(externalActions, 'target_reference').notNull).toBe(true)
  })

  it('counts attempts so bounded backoff can exhaust visibly (FR-076)', () => {
    expect(columnOf(externalActions, 'attempt_count').defaultValue).toBe(0)
    expect(columnOf(externalActions, 'result').defaultValue).toBe('pending')
  })

  it('is append-only', () => {
    expect(describeTable(externalActions).columns.map((column) => column.name)).not.toContain(
      'updated_at',
    )
  })
})

describe('scoped_credentials', () => {
  it('makes a replayed token recognisable (FR-018, FR-037)', () => {
    expect(indexOf(scopedCredentials, 'scoped_credentials_jti_key').unique).toBe(true)
    expect(columnOf(scopedCredentials, 'jti').notNull).toBe(true)
  })

  it('binds the credential to one workflow, which every machine-surface write checks', () => {
    expect(columnOf(scopedCredentials, 'workflow_id').notNull).toBe(true)
    expect(referencedTables(scopedCredentials)).toStrictEqual(['workflows'])
  })

  it('allows one live credential per workflow, revocation being a timestamp', () => {
    const index = indexOf(scopedCredentials, 'scoped_credentials_live_key')
    expect(index.unique).toBe(true)
    expect(index.where).toBe('"scoped_credentials"."revoked_at" is null')
  })

  it('requires an expiry and counts renewals', () => {
    expect(columnOf(scopedCredentials, 'expires_at').notNull).toBe(true)
    expect(columnOf(scopedCredentials, 'renewal_count').defaultValue).toBe(0)
  })
})

describe('iterations', () => {
  it('caps the loop at three in the database, not in a counter application code can lose (FR-061)', () => {
    expect(describeTable(iterations).checks).toStrictEqual([
      { name: 'iterations_ordinal_bounds', expression: '"iterations"."ordinal" between 1 and 3' },
    ])
  })

  it('numbers iterations uniquely within a workflow', () => {
    const index = indexOf(iterations, 'iterations_ordinal_key')
    expect(index.unique).toBe(true)
    expect(index.columns).toStrictEqual(['workflow_id', 'ordinal'])
  })

  it('leaves the verdict null until the review runs', () => {
    expect(columnOf(iterations, 'review_verdict').notNull).toBe(false)
    expect(columnOf(iterations, 'review_verdict').type).toBe('review_verdict')
  })
})

describe('review_findings', () => {
  it('anchors a finding to entry, file and line for multi-repo reviews (FR-119)', () => {
    for (const name of ['workflow_entry_id', 'file_path', 'line']) {
      expect(columnOf(reviewFindings, name).notNull).toBe(false)
    }
    expect(referencedTables(reviewFindings)).toContain('workflow_entries')
  })

  it('tracks which later iteration resolved it', () => {
    expect(columnOf(reviewFindings, 'resolved_in_iteration_id').notNull).toBe(false)
    expect(referencedTables(reviewFindings)).toContain('iterations')
  })

  it('requires a severity and a summary', () => {
    expect(columnOf(reviewFindings, 'severity').notNull).toBe(true)
    expect(columnOf(reviewFindings, 'summary').notNull).toBe(true)
  })
})
