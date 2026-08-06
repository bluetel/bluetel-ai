import { describe, expect, it } from 'vitest'

import type { RoleChangeEntry } from './role-change-entry'
import { NO_REASON, SYSTEM_ACTOR, toRoleChangeReadouts } from './role-change-entry'

const entry = (overrides: Partial<RoleChangeEntry> = {}): RoleChangeEntry => ({
  id: '0199a1f4-0000-7000-8000-000000000020',
  change: 'grant_admin',
  reason: 'Taking over the on-call rota.',
  createdAt: new Date('2026-08-05T09:14:00Z'),
  actorUserId: '0199a1f4-0000-7000-8000-000000000021',
  actorEmail: 'admin@bluetel.co.uk',
  actorDisplayName: 'An Admin',
  subjectUserId: '0199a1f4-0000-7000-8000-000000000022',
  subjectEmail: 'engineer@bluetel.co.uk',
  subjectDisplayName: 'An Engineer',
  ...overrides,
})

describe('toRoleChangeReadouts', () => {
  it('spaces the change for the mono readout', () => {
    expect(toRoleChangeReadouts(entry()).change).toBe('grant admin')
    expect(toRoleChangeReadouts(entry({ change: 'revoke_admin' })).change).toBe('revoke admin')
  })

  it('leaves a single-word change alone', () => {
    expect(toRoleChangeReadouts(entry({ change: 'deactivate' })).change).toBe('deactivate')
  })

  it('names the acting admin and the affected user', () => {
    const readouts = toRoleChangeReadouts(entry())

    expect(readouts.actor).toBe('An Admin')
    expect(readouts.subject).toBe('An Engineer')
  })

  it('falls back to the actor’s address when they have no display name', () => {
    expect(toRoleChangeReadouts(entry({ actorDisplayName: null })).actor).toBe(
      'admin@bluetel.co.uk',
    )
  })

  it('names the bootstrap reconcile as the system actor rather than as a blank cell', () => {
    const readouts = toRoleChangeReadouts(
      entry({ actorUserId: null, actorEmail: null, actorDisplayName: null }),
    )

    expect(readouts.actor).toBe(SYSTEM_ACTOR)
  })

  it('states an absent reason rather than leaving whitespace', () => {
    expect(toRoleChangeReadouts(entry({ reason: null })).reason).toBe(NO_REASON)
  })

  it('renders the time as a machine readout', () => {
    expect(toRoleChangeReadouts(entry()).at).toBe('2026-08-05 09:14')
  })
})
