import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { RoleChangeEntry } from './role-change-entry'
import { RoleChangeHistory } from './role-change-history'

const entry = (overrides: Partial<RoleChangeEntry> = {}): RoleChangeEntry => ({
  id: '0199a1f4-0000-7000-8000-000000000040',
  change: 'grant_admin',
  reason: 'Taking over the on-call rota.',
  createdAt: new Date('2026-08-05T09:14:00Z'),
  actorUserId: '0199a1f4-0000-7000-8000-000000000041',
  actorEmail: 'admin@bluetel.co.uk',
  actorDisplayName: 'An Admin',
  subjectUserId: '0199a1f4-0000-7000-8000-000000000042',
  subjectEmail: 'engineer@bluetel.co.uk',
  subjectDisplayName: 'An Engineer',
  ...overrides,
})

describe('RoleChangeHistory', () => {
  it('renders the change, the subject, the actor, the time and the reason', () => {
    const markup = renderToStaticMarkup(<RoleChangeHistory entries={[entry()]} />)

    expect(markup).toContain('grant admin')
    expect(markup).toContain('An Engineer')
    expect(markup).toContain('An Admin')
    expect(markup).toContain('2026-08-05 09:14')
    expect(markup).toContain('Taking over the on-call rota.')
  })

  it('names the bootstrap reconcile rather than leaving the actor blank', () => {
    const markup = renderToStaticMarkup(
      <RoleChangeHistory
        entries={[entry({ actorUserId: null, actorEmail: null, actorDisplayName: null })]}
      />,
    )

    expect(markup).toContain('system')
  })

  it('offers no control, because an append-only trail cannot be edited', () => {
    const markup = renderToStaticMarkup(<RoleChangeHistory entries={[entry()]} />)

    expect(markup).not.toContain('<button')
    expect(markup).not.toContain('<input')
  })

  it('says the trail is append-only, so nobody goes looking for the delete', () => {
    expect(renderToStaticMarkup(<RoleChangeHistory entries={[]} />)).toContain('Appended')
  })

  it('distinguishes an empty history from one still being read', () => {
    expect(renderToStaticMarkup(<RoleChangeHistory entries={[]} />)).toContain(
      'no changes recorded yet',
    )
    expect(renderToStaticMarkup(<RoleChangeHistory entries={[]} loading />)).toContain('reading')
  })

  it('counts the entries in the header chip', () => {
    const markup = renderToStaticMarkup(
      <RoleChangeHistory entries={[entry(), entry({ id: 'second' })]} />,
    )

    expect(markup).toContain('entries 2')
  })

  it('carries no literal colour, size or radius', () => {
    expect(renderToStaticMarkup(<RoleChangeHistory entries={[entry()]} />)).not.toMatch(
      /#[0-9a-fA-F]{3,8}|\d+(?:px|rem)/,
    )
  })

  it('reports a refused read with a code and a next action (FR-031, FR-201)', () => {
    const markup = renderToStaticMarkup(
      <RoleChangeHistory
        entries={[]}
        error={{ code: 'E_ADMIN_REQUIRED', action: 'Ask an active admin to read this.' }}
      />,
    )

    expect(markup).toContain('E_ADMIN_REQUIRED')
    expect(markup).toContain('Ask an active admin to read this.')
  })

  it('never claims nothing was recorded on a trail it could not read', () => {
    const markup = renderToStaticMarkup(
      <RoleChangeHistory entries={[]} error={{ code: 'E_UNEXPECTED', action: 'Retry once.' }} />,
    )

    expect(markup).not.toContain('no changes recorded yet')
    expect(markup).not.toContain('data-note="empty"')
  })

  it('keeps reading and empty apart as two distinct notes', () => {
    expect(renderToStaticMarkup(<RoleChangeHistory entries={[]} loading />)).toContain(
      'data-note="loading"',
    )
    expect(renderToStaticMarkup(<RoleChangeHistory entries={[]} />)).toContain('data-note="empty"')
  })
})
