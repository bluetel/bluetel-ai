import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { CreateGroupForm } from './create-group-form'

const noop = () => undefined

const render = (props: Partial<Parameters<typeof CreateGroupForm>[0]> = {}) =>
  renderToStaticMarkup(
    <CreateGroupForm name="" description="" onChange={noop} onSubmit={noop} {...props} />,
  )

describe('CreateGroupForm (FR-060, FR-061)', () => {
  it('says a credential belongs to exactly one group, chosen at registration', () => {
    expect(render()).toContain('exactly one')
  })

  it('says a run only draws from a group its profile is attached to (FR-063)', () => {
    expect(render()).toContain('execution profile is attached to')
  })

  it('says a new group is empty, so its arrival does not read as capacity', () => {
    expect(render()).toContain('enabled and empty')
  })

  it('refuses to submit an unnamed group without asking the server first', () => {
    expect(render()).toContain('data-state="disabled"')
    expect(render({ name: 'Payments' })).not.toContain('data-state="disabled"')
  })

  it('replaces the button label with a live readout while the create is in flight', () => {
    const markup = render({ name: 'Payments', startedAt: Date.now() })

    expect(markup).toContain('Creating')
    expect(markup).toContain('data-state="pending"')
  })

  it('renders a refusal as a code and a next action', () => {
    expect(
      render({ error: { code: 'E_CREDENTIAL_GROUP_REFUSED', action: 'Choose another name.' } }),
    ).toContain('E_CREDENTIAL_GROUP_REFUSED')
  })
})
