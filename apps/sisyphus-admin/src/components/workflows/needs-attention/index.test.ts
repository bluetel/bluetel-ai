import { describe, expect, it } from 'vitest'

import * as needsAttention from './index'

describe('the needs-attention barrel', () => {
  it('exposes the screen, its parts and its pure modules, so nothing imports an internal', () => {
    for (const name of [
      'NeedsAttentionPanel',
      'StrandedOwnerCard',
      'ReassignmentRow',
      'stoppedForMeInput',
      'awaitingReassignmentInput',
      'strandedOwners',
      'reassignmentCandidates',
      'describeReassignment',
      'describeReassignmentError',
    ]) {
      expect(needsAttention).toHaveProperty(name)
    }
  })

  it('re-exports no part of the fleet list — this view is that list, narrowed', () => {
    expect(needsAttention).not.toHaveProperty('WorkflowList')
    expect(needsAttention).not.toHaveProperty('WorkflowRow')
    expect(needsAttention).not.toHaveProperty('toWorkflowRowReadouts')
  })
})
