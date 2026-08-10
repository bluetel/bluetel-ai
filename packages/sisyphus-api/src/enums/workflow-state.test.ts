import { describe, expect, it } from 'vitest'

import { TERMINAL_OUTCOMES } from './terminal-outcome'
import {
  ACTIVE_WORKFLOW_STATES,
  isWorkflowState,
  TERMINAL_WORKFLOW_STATES,
  WORKFLOW_STATES,
} from './workflow-state'

describe('WORKFLOW_STATES', () => {
  it('matches the data-model state machine, in order', () => {
    expect([...WORKFLOW_STATES]).toStrictEqual([
      'queued',
      'awaiting_credential',
      'provisioning',
      'running',
      'paused',
      'parked_resumable',
      'succeeded',
      'failed',
      'capped',
      'cancelled',
      'needs_attention',
    ])
  })

  it('holds no duplicates', () => {
    expect(new Set(WORKFLOW_STATES).size).toBe(WORKFLOW_STATES.length)
  })

  it('contains every terminal outcome, so state and outcome cannot disagree', () => {
    for (const outcome of TERMINAL_OUTCOMES) {
      expect(WORKFLOW_STATES).toContain(outcome)
    }
  })

  it('splits cleanly into active states and terminal outcomes with nothing left over', () => {
    const partitioned = new Set<string>([...ACTIVE_WORKFLOW_STATES, ...TERMINAL_WORKFLOW_STATES])
    expect([...WORKFLOW_STATES].every((state) => partitioned.has(state))).toBe(true)
    expect(partitioned.size).toBe(WORKFLOW_STATES.length)
  })

  it('treats parked_resumable as both an outcome and a re-enterable state (FR-151)', () => {
    expect(TERMINAL_WORKFLOW_STATES).toContain('parked_resumable')
    expect(ACTIVE_WORKFLOW_STATES).not.toContain('parked_resumable')
  })

  it('names waiting for a credential as its own state rather than overloading queued (R10)', () => {
    // `queued` already means "admitted, waiting on the concurrency ceiling". FR-029 requires the
    // platform to report *which* scarcity is biting and name the groups searched, and that
    // distinction collapses the moment both conditions share a state — as does the meaning of
    // every existing query filtering on `queued`.
    expect(WORKFLOW_STATES).toContain('awaiting_credential')
    expect(WORKFLOW_STATES.indexOf('queued')).toBeLessThan(
      WORKFLOW_STATES.indexOf('awaiting_credential'),
    )
    expect(WORKFLOW_STATES.indexOf('awaiting_credential')).toBeLessThan(
      WORKFLOW_STATES.indexOf('provisioning'),
    )
  })

  it('counts a workflow waiting for a credential as live, so the sweep leaves its reservation alone', () => {
    // This half is the load-bearing one. The reconciliation sweep releases leases whose workflow is
    // no longer active; a waiting run that this list omitted would be read as finished, and the
    // reservation it is waiting on — or, once granted, holding — would be swept out from under it.
    // A test that only checked WORKFLOW_STATES would pass while shipping exactly that bug (R10).
    expect(ACTIVE_WORKFLOW_STATES).toContain('awaiting_credential')
    expect(TERMINAL_WORKFLOW_STATES).not.toContain('awaiting_credential')
  })

  it('guards membership', () => {
    expect(isWorkflowState('provisioning')).toBe(true)
    expect(isWorkflowState('awaiting_credential')).toBe(true)
    expect(isWorkflowState('pending')).toBe(false)
    expect(isWorkflowState('awaiting-credential')).toBe(false)
  })
})
