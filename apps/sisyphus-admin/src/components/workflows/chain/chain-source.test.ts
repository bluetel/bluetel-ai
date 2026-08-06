import { describe, expect, it } from 'vitest'

import type { WorkflowDetailResult } from '../workflow-detail-readouts'

import { toChainMember } from './chain-source'

/**
 * The projection from `workflow.byId` to a chain member. Small, and worth a test for one reason:
 * a field silently dropped here is a column that renders blank in the chain and nowhere else, which
 * is the sort of thing nobody notices until the figures do not add up.
 */

const detail = {
  workflow: {
    id: 'run-a',
    predecessorWorkflowId: 'run-root',
    state: 'capped',
    terminalOutcome: 'capped',
    model: 'claude-opus-5',
    turnCap: 40,
    spendCap: '25.0000',
    turnsUsed: 39,
    spendUsed: '24.5000',
    createdAt: new Date('2026-08-05T09:00:00.000Z'),
    updatedAt: new Date('2026-08-05T09:30:00.000Z'),
  },
} as unknown as WorkflowDetailResult

describe('toChainMember', () => {
  it('carries every field the chain renders and sums', () => {
    expect(toChainMember(detail)).toStrictEqual({
      workflowId: 'run-a',
      predecessorWorkflowId: 'run-root',
      state: 'capped',
      terminalOutcome: 'capped',
      model: 'claude-opus-5',
      turnCap: 40,
      spendCap: '25.0000',
      turnsUsed: 39,
      spendUsed: '24.5000',
      createdAt: new Date('2026-08-05T09:00:00.000Z'),
      updatedAt: new Date('2026-08-05T09:30:00.000Z'),
    })
  })

  it('keeps spend as the decimal string the platform recorded, never a number', () => {
    expect(typeof toChainMember(detail).spendUsed).toBe('string')
  })
})
