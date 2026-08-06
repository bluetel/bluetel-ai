import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { ProfileGrant } from './grant-listing'
import { GrantRow } from './grant-row'

const noop = () => undefined

const grant = (overrides: Partial<ProfileGrant> = {}): ProfileGrant => ({
  id: '0199a1f4-0000-7000-8000-000000000070',
  userId: '0199a1f4-0000-7000-8000-000000000071',
  email: 'engineer@bluetel.co.uk',
  displayName: 'An Engineer',
  grantedAt: new Date('2026-08-01T10:00:00Z'),
  grantedByUserId: '0199a1f4-0000-7000-8000-000000000072',
  revokedAt: null,
  revokedByUserId: null,
  ...overrides,
})

const render = (props: Partial<Parameters<typeof GrantRow>[0]> = {}) =>
  renderToStaticMarkup(
    <GrantRow grant={grant()} onSelect={noop} onCancel={noop} onConfirm={noop} {...props} />,
  )

describe('GrantRow', () => {
  it('names the holder and when access was issued', () => {
    const markup = render()

    expect(markup).toContain('An Engineer')
    expect(markup).toContain('engineer@bluetel.co.uk')
    expect(markup).toContain('2026-08-01 10:00')
  })

  it('reports a live grant as live and offers its revocation', () => {
    const markup = render()

    expect(markup).toContain('live')
    expect(markup).toContain('Revoke access')
  })

  it('keeps a revoked grant on the list, reports it as revoked, and offers no control', () => {
    const markup = render({ grant: grant({ revokedAt: new Date('2026-08-05T09:14:00Z') }) })

    expect(markup).toContain('revoked')
    expect(markup).toContain('2026-08-05 09:14')
    expect(markup).not.toContain('Revoke access')
  })

  it('shows the cascade instead of the control once revocation is being confirmed', () => {
    const markup = render({ confirming: true })

    expect(markup).toContain('Confirm: revoke access')
    expect(markup).toContain('Watches they hold on this profile')
    expect(markup).not.toContain('>Revoke access<')
  })

  it('reports what the completed revocation removed', () => {
    const markup = render({
      notice: { readout: 'watches removed 2', detail: '2 watches were removed.' },
    })

    expect(markup).toContain('watches removed 2')
    expect(markup).toContain('role="status"')
  })

  it('keeps the state chip on the idle colour, because a grant is not a workflow state', () => {
    const markup = render({ grant: grant({ revokedAt: new Date('2026-08-05T09:14:00Z') }) })
    const chipClasses = [...markup.matchAll(/data-state="idle" class="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((classes) => classes.includes('rounded-chip'))

    expect(chipClasses.length).toBeGreaterThan(0)
    for (const classes of chipClasses) {
      expect(classes).toContain('text-graphite')
    }
  })

  it('carries no literal colour, size or radius', () => {
    expect(render({ confirming: true })).not.toMatch(/#[0-9a-fA-F]{3,8}|\d+(?:px|rem)/)
  })
})
