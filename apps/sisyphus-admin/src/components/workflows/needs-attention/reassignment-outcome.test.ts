import { UNEXPECTED_ERROR } from '@sisyphus-admin/components/admin'
import { describe, expect, it } from 'vitest'

import type { ReassignmentResult } from './reassignment-outcome'
import { describeReassignment, describeReassignmentError } from './reassignment-outcome'

const result = (changed: boolean): ReassignmentResult =>
  ({
    workflow: { id: '01890a5d-ac96-774b-bcce-b302099a8050' },
    previousOwnerUserId: 'user-gone',
    changed,
  }) as unknown as ReassignmentResult

describe('describeReassignment (FR-134, FR-176)', () => {
  it('names who is accountable now, rather than reporting an id', () => {
    expect(describeReassignment(result(true), 'Ada').detail).toContain('Ada is now accountable')
  })

  it('says the flag is cleared, which is the thing the queue was tracking', () => {
    expect(describeReassignment(result(true), 'Ada').detail).toContain(
      'no longer flagged for reassignment',
    )
  })

  it('abbreviates the run id the way the fleet list does', () => {
    expect(describeReassignment(result(true), 'Ada').readout).toBe('reassigned 01890a5d…')
  })

  it('reports a no-op rather than swallowing it', () => {
    const notice = describeReassignment(result(false), 'Ada')

    expect(notice.readout).toBe('unchanged')
    expect(notice.detail).toContain('nothing moved and nothing was recorded')
  })
})

describe('describeReassignmentError', () => {
  it('says to choose an active user on a conflict, which is what it always is here', () => {
    const refusal = describeReassignmentError({ data: { code: 'CONFLICT' } })

    expect(refusal.code).toBe('E_OWNER_NOT_AVAILABLE')
    expect(refusal.action).toContain('active user')
  })

  it('sends a non-admin to an admin rather than leaving them a dead end', () => {
    expect(describeReassignmentError({ data: { code: 'FORBIDDEN' } }).code).toBe('E_ADMIN_REQUIRED')
  })

  it('never produces a dead end', () => {
    expect(describeReassignmentError('something odd')).toStrictEqual(UNEXPECTED_ERROR)
  })
})
