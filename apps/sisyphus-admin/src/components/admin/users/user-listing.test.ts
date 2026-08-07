import { describe, expect, it } from 'vitest'

import type { AdministeredUser } from './user-listing'
import { hasWorkInFlight, toUserReadouts } from './user-listing'

const user = (overrides: Partial<AdministeredUser> = {}): AdministeredUser => ({
  id: '0199a1f4-0000-7000-8000-000000000010',
  email: 'engineer@bluetel.co.uk',
  displayName: 'An Engineer',
  role: 'engineer',
  isActive: true,
  slackUserId: null,
  lastSignInAt: new Date('2026-08-05T09:14:00Z'),
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ownedWorkflowCount: 3,
  workflowsAwaitingReassignment: 0,
  ...overrides,
})

describe('toUserReadouts', () => {
  it('carries the identity through unchanged', () => {
    const readouts = toUserReadouts(user())

    expect(readouts.displayName).toBe('An Engineer')
    expect(readouts.email).toBe('engineer@bluetel.co.uk')
  })

  it('reports the role as its own readout', () => {
    expect(toUserReadouts(user({ role: 'admin' })).role).toBe('admin')
  })

  it('reports activity in words, so the chip does not have to carry it in colour', () => {
    expect(toUserReadouts(user()).activity).toBe('active')
    expect(toUserReadouts(user({ isActive: false })).activity).toBe('inactive')
  })

  it('renders a user who has never signed in as never, not as an empty cell', () => {
    expect(toUserReadouts(user({ lastSignInAt: null })).lastSignIn).toBe('never')
  })

  it('renders owned runs as a count, including zero', () => {
    expect(toUserReadouts(user({ ownedWorkflowCount: 0 })).ownedRuns).toBe('0')
    expect(toUserReadouts(user({ ownedWorkflowCount: 12 })).ownedRuns).toBe('12')
  })

  it('omits the reassignment backlog when there is none, so a present one is noticed', () => {
    expect(toUserReadouts(user()).awaitingReassignment).toBeUndefined()
  })

  it('reports the reassignment backlog when the deactivation left work behind', () => {
    expect(toUserReadouts(user({ workflowsAwaitingReassignment: 2 })).awaitingReassignment).toBe(
      '2',
    )
  })
})

describe('hasWorkInFlight', () => {
  it('is true for a user who owns runs', () => {
    expect(hasWorkInFlight(user({ ownedWorkflowCount: 1 }))).toBe(true)
  })

  it('is false for a user who owns none', () => {
    expect(hasWorkInFlight(user({ ownedWorkflowCount: 0 }))).toBe(false)
  })
})
