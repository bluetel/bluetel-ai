import { describe, expect, it } from 'vitest'

import type { UserChangeResult } from './user-change-outcome'
import {
  describeUserChange,
  describeUserChangeError,
  LAST_ACTIVE_ADMIN_ERROR,
} from './user-change-outcome'

const rejection = (code: string, message = 'refused'): unknown => ({ message, data: { code } })

const result = (overrides: Partial<UserChangeResult> = {}): UserChangeResult => ({
  user: {
    id: '0199a1f4-0000-7000-8000-000000000011',
    email: 'engineer@bluetel.co.uk',
    displayName: 'An Engineer',
    role: 'engineer',
    isActive: false,
    slackUserId: null,
    lastSignInAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  },
  changed: true,
  workflowsFlaggedForReassignment: 0,
  ...overrides,
})

describe('describeUserChangeError', () => {
  it('turns the never-zero-admins refusal into a code and a next action', () => {
    const content = describeUserChangeError(rejection('PRECONDITION_FAILED'))

    expect(content).toStrictEqual(LAST_ACTIVE_ADMIN_ERROR)
    expect(content.code).toBe('E_LAST_ACTIVE_ADMIN')
    expect(content.action).toContain('Grant the admin role to another active user first')
  })

  it('does not swallow that refusal into a generic message', () => {
    expect(describeUserChangeError(rejection('PRECONDITION_FAILED')).code).not.toBe('E_UNEXPECTED')
  })

  it('leaves the other refusals on the shared mapping', () => {
    expect(describeUserChangeError(rejection('FORBIDDEN')).code).toBe('E_ADMIN_REQUIRED')
    expect(describeUserChangeError(rejection('NOT_FOUND')).code).toBe('E_TARGET_NOT_FOUND')
  })

  it('still produces a code and an action for a failure that is not a tRPC error', () => {
    const content = describeUserChangeError(new Error('fetch failed'))

    expect(content.code).toBe('E_UNEXPECTED')
    expect(content.action.length).toBeGreaterThan(0)
  })
})

describe('describeUserChange', () => {
  it('reports a deactivation that stranded runs, with the count the server returned', () => {
    const notice = describeUserChange('deactivate', result({ workflowsFlaggedForReassignment: 3 }))

    expect(notice.readout).toBe('flagged 3')
    expect(notice.detail).toContain('3 runs')
    expect(notice.detail).toContain('flagged for reassignment')
  })

  it('says so explicitly when a deactivation stranded nothing', () => {
    const notice = describeUserChange('deactivate', result())

    expect(notice.readout).toBe('flagged 0')
    expect(notice.detail).toContain('No run they own was still in flight')
  })

  it('agrees the verb for a single stranded run', () => {
    const notice = describeUserChange('deactivate', result({ workflowsFlaggedForReassignment: 1 }))

    expect(notice.detail).toContain('1 run they own is still in flight')
  })

  it('never leaves a deactivation silent about what it left behind', () => {
    for (const flagged of [0, 1, 7]) {
      const notice = describeUserChange(
        'deactivate',
        result({ workflowsFlaggedForReassignment: flagged }),
      )
      expect(notice.readout).toContain(String(flagged))
    }
  })

  it('reports what a reactivation cleared', () => {
    const notice = describeUserChange('reactivate', result({ workflowsFlaggedForReassignment: 2 }))

    expect(notice.readout).toBe('cleared 2')
    expect(notice.detail).toContain('cleared from 2 runs')
  })

  it('says a role change takes effect at the next request, not at next sign-in', () => {
    expect(describeUserChange('grant-admin', result()).detail).toContain('next request')
    expect(describeUserChange('revoke-admin', result()).detail).toContain('next request')
  })

  it('says a revocation keeps the work they own', () => {
    expect(describeUserChange('revoke-admin', result()).detail).toContain('own or initiated')
  })

  it('reports a request for the state the row was already in as no event at all', () => {
    const notice = describeUserChange('deactivate', result({ changed: false }))

    expect(notice.readout).toBe('unchanged')
    expect(notice.detail).toContain('nothing was recorded')
  })

  it('always produces both halves, for every kind', () => {
    for (const kind of ['grant-admin', 'revoke-admin', 'deactivate', 'reactivate'] as const) {
      const notice = describeUserChange(kind, result())
      expect(notice.readout.length).toBeGreaterThan(0)
      expect(notice.detail.length).toBeGreaterThan(0)
    }
  })
})
