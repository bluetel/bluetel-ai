import { describe, expect, it } from 'vitest'

import { availableUserActions, userAction } from './user-actions'

const KINDS = ['grant-admin', 'revoke-admin', 'deactivate', 'reactivate'] as const

describe('userAction', () => {
  it.each(KINDS)('describes %s with a label, a variant, a verb and a consequence', (kind) => {
    const action = userAction(kind)

    expect(action.kind).toBe(kind)
    expect(action.label.length).toBeGreaterThan(0)
    expect(action.verb.length).toBeGreaterThan(0)
    expect(action.consequence.length).toBeGreaterThan(0)
  })

  it('never offers a primary variant, because a management table has no single main action', () => {
    expect(KINDS.map((kind) => userAction(kind).variant)).not.toContain('primary')
  })

  it('weights the two withdrawals as danger and the two grants as secondary', () => {
    expect(userAction('revoke-admin').variant).toBe('danger')
    expect(userAction('deactivate').variant).toBe('danger')
    expect(userAction('grant-admin').variant).toBe('secondary')
    expect(userAction('reactivate').variant).toBe('secondary')
  })

  it('keeps labels sentence case, because a button is never uppercase mono', () => {
    for (const kind of KINDS) {
      const { label } = userAction(kind)
      expect(label).not.toBe(label.toUpperCase())
    }
  })

  it('says deactivation does not delete, because that is the thing an admin fears', () => {
    expect(userAction('deactivate').consequence).toContain('Nothing is deleted')
  })

  it('warns that revoking the last admin will be refused, before it is attempted', () => {
    expect(userAction('revoke-admin').consequence).toContain('last active admin')
  })
})

describe('availableUserActions', () => {
  it('offers an engineer the admin grant and a deactivation', () => {
    expect(
      availableUserActions({ role: 'engineer', isActive: true }).map((action) => action.kind),
    ).toStrictEqual(['grant-admin', 'deactivate'])
  })

  it('offers an admin the revocation instead of the grant', () => {
    expect(
      availableUserActions({ role: 'admin', isActive: true }).map((action) => action.kind),
    ).toStrictEqual(['revoke-admin', 'deactivate'])
  })

  it('offers an inactive user reactivation and never deactivation', () => {
    const kinds = availableUserActions({ role: 'engineer', isActive: false }).map(
      (action) => action.kind,
    )

    expect(kinds).toContain('reactivate')
    expect(kinds).not.toContain('deactivate')
  })

  it('always offers exactly two, so no state is hidden', () => {
    for (const role of ['admin', 'engineer']) {
      for (const isActive of [true, false]) {
        expect(availableUserActions({ role, isActive })).toHaveLength(2)
      }
    }
  })

  it('offers the last active admin their own revocation, leaving the refusal to the server', () => {
    // The invariant is re-counted inside the server's transaction (FR-173). A panel that disabled
    // this button would be re-deriving that rule from a list that is already stale.
    expect(
      availableUserActions({ role: 'admin', isActive: true }).map((action) => action.kind),
    ).toContain('revoke-admin')
  })
})
