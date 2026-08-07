import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { UserCard } from './user-card'
import { LAST_ACTIVE_ADMIN_ERROR } from './user-change-outcome'
import type { AdministeredUser } from './user-listing'

const noop = () => undefined

const user = (overrides: Partial<AdministeredUser> = {}): AdministeredUser => ({
  id: '0199a1f4-0000-7000-8000-000000000030',
  email: 'engineer@bluetel.co.uk',
  displayName: 'An Engineer',
  role: 'engineer',
  isActive: true,
  slackUserId: null,
  lastSignInAt: new Date('2026-08-05T09:14:00Z'),
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ownedWorkflowCount: 4,
  workflowsAwaitingReassignment: 0,
  ...overrides,
})

const render = (props: Partial<Parameters<typeof UserCard>[0]> = {}) =>
  renderToStaticMarkup(
    <UserCard
      user={user()}
      reason=""
      onSelect={noop}
      onCancel={noop}
      onReasonChange={noop}
      onConfirm={noop}
      {...props}
    />,
  )

describe('UserCard', () => {
  it('shows the identity, role, active state, last sign-in and owned runs FR-171 asks for', () => {
    const markup = render()

    expect(markup).toContain('engineer@bluetel.co.uk')
    expect(markup).toContain('An Engineer')
    expect(markup).toContain('engineer')
    expect(markup).toContain('active')
    expect(markup).toContain('2026-08-05 09:14')
    expect(markup).toContain('owns runs')
  })

  it('shows the reassignment backlog when there is one', () => {
    const markup = render({ user: user({ workflowsAwaitingReassignment: 2 }) })

    expect(markup).toContain('awaiting reassignment')
  })

  it('omits the backlog readout when there is none, so a present one is noticed', () => {
    expect(render()).not.toContain('awaiting reassignment')
  })

  it('offers the two changes the row’s state allows', () => {
    const markup = render()

    expect(markup).toContain('Grant admin')
    expect(markup).toContain('Deactivate')
    expect(markup).not.toContain('Reactivate')
  })

  it('offers an inactive user reactivation instead', () => {
    const markup = render({ user: user({ isActive: false }) })

    expect(markup).toContain('Reactivate')
    expect(markup).toContain('inactive')
  })

  it('offers an admin the revocation of their own role', () => {
    expect(render({ user: user({ role: 'admin' }) })).toContain('Revoke admin')
  })

  it('replaces the action row with a confirmation once a change is selected', () => {
    const markup = render({ selected: 'deactivate' })

    expect(markup).toContain('Confirm: deactivate')
    expect(markup).toContain('Nothing is deleted')
  })

  it('surfaces a refusal on the selected change, with its code and next action', () => {
    const markup = render({
      user: user({ role: 'admin' }),
      selected: 'revoke-admin',
      error: LAST_ACTIVE_ADMIN_ERROR,
    })

    expect(markup).toContain('E_LAST_ACTIVE_ADMIN')
    expect(markup).toContain('Grant the admin role to another active user first')
  })

  it('shows no confirmation for a change the row does not offer', () => {
    // Selecting `revoke-admin` on an engineer is not a state the card can be put in by clicking,
    // and it renders the action row rather than a confirmation for a change that cannot be made.
    expect(render({ selected: 'revoke-admin' })).toContain('Grant admin')
  })

  it('reports what a completed deactivation left behind', () => {
    const markup = render({
      notice: { readout: 'flagged 3', detail: '3 runs they own are now flagged.' },
    })

    expect(markup).toContain('flagged 3')
    expect(markup).toContain('role="status"')
  })

  it('keeps every chip on the idle colour, because role and activity are not machine state', () => {
    const markup = render({ user: user({ isActive: false, role: 'admin' }) })
    // Buttons report `data-state` too, so the chips are picked out by their own radius token.
    const chipClasses = [...markup.matchAll(/data-state="idle" class="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((classes) => classes.includes('rounded-chip'))

    expect(chipClasses.length).toBeGreaterThan(0)
    for (const classes of chipClasses) {
      expect(classes).toContain('text-graphite')
      expect(classes).not.toMatch(/text-(rust|amber|verdigris|signal)\b/)
    }
  })

  it('holds no primary button, so a management table has no single main action', () => {
    expect(render()).not.toContain('bg-signal ')
  })

  it('carries no literal colour, size or radius', () => {
    expect(render({ selected: 'deactivate' })).not.toMatch(/#[0-9a-fA-F]{3,8}|\d+(?:px|rem)/)
  })
})
