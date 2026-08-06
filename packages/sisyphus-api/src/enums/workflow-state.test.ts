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

  it('guards membership', () => {
    expect(isWorkflowState('provisioning')).toBe(true)
    expect(isWorkflowState('pending')).toBe(false)
  })
})
