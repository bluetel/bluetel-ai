import { ACTIVE_WORKFLOW_STATES } from '@bluetel-ai/sisyphus-api/client'
import { describe, expect, it } from 'vitest'

import type { AdministeredUser } from './needs-attention-input'
import {
  awaitingReassignmentInput,
  NEEDS_ATTENTION_PAGE_SIZE,
  reassignmentCandidates,
  stoppedForMeInput,
  strandedOwners,
} from './needs-attention-input'

const ME = '01890a5d-ac96-774b-bcce-b302099a8050'
const GONE = '01890a5d-ac96-774b-bcce-b302099a8051'

const user = (overrides: Partial<AdministeredUser> = {}): AdministeredUser =>
  ({
    id: ME,
    email: 'ada@example.com',
    displayName: 'Ada',
    role: 'engineer',
    isActive: true,
    slackUserId: null,
    lastSignInAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ownedWorkflowCount: 4,
    workflowsAwaitingReassignment: 0,
    ...overrides,
  }) as AdministeredUser

describe('stoppedForMeInput (FR-135)', () => {
  it('asks for exactly the runs I own that stopped needing me', () => {
    expect(stoppedForMeInput(ME)).toEqual({
      limit: NEEDS_ATTENTION_PAGE_SIZE,
      ownerUserId: ME,
      state: ['needs_attention'],
    })
  })

  it('does not widen to paused or parked, which are states somebody chose', () => {
    expect(stoppedForMeInput(ME).state).toEqual(['needs_attention'])
  })
})

describe('awaitingReassignmentInput (FR-176)', () => {
  it('asks for one owner’s non-terminal runs, which is the set the flag marks', () => {
    expect(awaitingReassignmentInput(GONE)).toEqual({
      limit: NEEDS_ATTENTION_PAGE_SIZE,
      ownerUserId: GONE,
      state: [...ACTIVE_WORKFLOW_STATES],
    })
  })

  it('takes its states from the state machine rather than restating them', () => {
    expect(awaitingReassignmentInput(GONE).state).toEqual([...ACTIVE_WORKFLOW_STATES])
  })
})

describe('strandedOwners (FR-176)', () => {
  it('finds a deactivated owner with runs still flagged', () => {
    const owners = strandedOwners([
      user({ id: GONE, displayName: 'Grace', isActive: false, workflowsAwaitingReassignment: 3 }),
    ])

    expect(owners).toEqual([
      {
        userId: GONE,
        displayName: 'Grace',
        email: 'ada@example.com',
        flaggedCount: 3,
      },
    ])
  })

  it('ignores an active user, whose flag reactivation already cleared', () => {
    expect(strandedOwners([user({ workflowsAwaitingReassignment: 3 })])).toEqual([])
  })

  it('ignores a deactivated user with nothing left in flight', () => {
    expect(strandedOwners([user({ isActive: false, workflowsAwaitingReassignment: 0 })])).toEqual(
      [],
    )
  })
})

describe('reassignmentCandidates (FR-134)', () => {
  it('offers active users', () => {
    const candidates = reassignmentCandidates([user(), user({ id: GONE })], GONE)

    expect(candidates.map((candidate) => candidate.id)).toEqual([ME])
  })

  it('never offers a deactivated user, which is the state reassignment exists to leave', () => {
    const candidates = reassignmentCandidates([user({ isActive: false })], GONE)

    expect(candidates).toEqual([])
  })

  it('never offers the person the run is being taken from', () => {
    expect(reassignmentCandidates([user({ id: GONE, isActive: true })], GONE)).toEqual([])
  })
})
