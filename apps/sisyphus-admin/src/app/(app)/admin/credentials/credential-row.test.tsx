import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { CredentialReadout } from './credential-listing'
import { CredentialRow } from './credential-row'

const noop = () => undefined

const readout = (overrides: Partial<CredentialReadout> = {}): CredentialReadout => ({
  id: '0199a1f4-0000-7000-8000-000000000001',
  name: 'seat-one',
  credentialGroupName: 'seats-a',
  state: 'available',
  enabled: true,
  archived: false,
  selectable: true,
  secretId: 'arn:aws:secretsmanager:eu-west-2:000000000000:secret:seat-one',
  lastLogin: '2026-08-05 09:14',
  lastUsed: 'never',
  ...overrides,
})

const render = (props: Partial<Parameters<typeof CredentialRow>[0]> = {}) =>
  renderToStaticMarkup(
    <CredentialRow credential={readout()} onSetEnabled={noop} onDelete={noop} {...props} />,
  )

describe('CredentialRow', () => {
  it('leads with the seat’s state and whether it is actually usable', () => {
    const markup = render()

    expect(markup).toContain('seat-one')
    expect(markup).toContain('available')
    expect(markup).toContain('usable')
    expect(markup).toContain('yes')
  })

  it('says why a seat is withheld when the state alone would not explain it', () => {
    // The interesting case: `available`, enabled, logged in — and handed to nobody, because the
    // pool it sits in was withdrawn. A row showing only the state would report this seat as fine.
    const markup = render({
      credential: readout({
        selectable: false,
        withheldBecause: 'its group seats-a is disabled, which withholds every seat in it',
      }),
    })

    expect(markup).toContain('Withheld from selection')
    expect(markup).toContain('its group seats-a is disabled')
  })

  it('renders a failure reason in full, against the seat it belongs to (FR-009)', () => {
    const markup = render({
      credential: readout({
        state: 'unhealthy',
        selectable: false,
        lastFailureReason: 'the provider rejected the session: credentials expired 2026-08-04',
      }),
    })

    expect(markup).toContain('the provider rejected the session: credentials expired 2026-08-04')
  })

  it('offers the login only from the two states a login is the remedy for', () => {
    // The same pair the router refuses out of. A row that offered a login on an `available` seat
    // would be inviting an administrator to replace material the pool is about to hand out.
    expect(
      render({ credential: readout({ state: 'awaiting_login', selectable: false }) }),
    ).toContain('Log in')
    expect(render({ credential: readout({ state: 'unhealthy', selectable: false }) })).toContain(
      'Log in again',
    )
    expect(render()).not.toContain('Log in')
    expect(render({ credential: readout({ state: 'held', selectable: false }) })).not.toContain(
      'Log in',
    )
  })

  it('carries no input at all — there is nothing about a login to type here (FR-070)', () => {
    const markup = render({ credential: readout({ state: 'awaiting_login', selectable: false }) })

    // Until Phase 7 this row had a field for the name of a secret an operator had written by hand.
    // A row with any input on it is one edit away from being a row with a token in it, and the
    // login it links to has no field either: the material is produced on the login instance and
    // captured server-side.
    expect(markup).not.toContain('<input')
    expect(markup).not.toContain('Secret name')
    expect(markup).toContain('/admin/credentials/0199a1f4-0000-7000-8000-000000000001/login')
  })

  it('offers disable for an enabled seat and enable for a disabled one', () => {
    expect(render()).toContain('Disable')
    expect(render({ credential: readout({ enabled: false, selectable: false }) })).toContain(
      'Enable',
    )
  })

  it('offers nothing to act on for a deleted seat', () => {
    // FR-005 keeps the row so a finished run can still name its identity. There is nothing left to
    // do to it, and offering buttons that the router would refuse is worse than offering none.
    const markup = render({
      credential: readout({
        archived: true,
        enabled: false,
        selectable: false,
        state: 'awaiting_login',
      }),
    })

    expect(markup).not.toContain('Delete')
    expect(markup).not.toContain('Log in')
  })

  it('shows the secret identifier where there is one, and says so where there is not', () => {
    expect(render()).toContain('arn:aws:secretsmanager:eu-west-2:000000000000:secret:seat-one')
    expect(render({ credential: readout({ secretId: undefined }) })).toContain('none recorded')
  })

  it('replaces its controls with a live readout while an action is in flight', () => {
    const markup = render({ startedAt: Date.now() })

    expect(markup).toContain('Working')
    expect(markup).not.toContain('>Delete<')
  })
})
