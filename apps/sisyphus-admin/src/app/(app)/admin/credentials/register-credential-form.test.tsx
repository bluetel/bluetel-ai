import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { CredentialGroupOption } from './register-credential-form'
import { RegisterCredentialForm } from './register-credential-form'

const noop = () => undefined

const groups: readonly CredentialGroupOption[] = [
  { id: '0199a1f4-0000-7000-8000-000000000010', name: 'seats-a', enabled: true },
  { id: '0199a1f4-0000-7000-8000-000000000011', name: 'overflow', enabled: false },
]

const render = (props: Partial<Parameters<typeof RegisterCredentialForm>[0]> = {}) =>
  renderToStaticMarkup(
    <RegisterCredentialForm
      groups={groups}
      name=""
      credentialGroupId=""
      onNameChange={noop}
      onGroupChange={noop}
      onSubmit={noop}
      {...props}
    />,
  )

describe('RegisterCredentialForm', () => {
  it('asks for a name and a group, and for nothing else', () => {
    const markup = render()

    // The absence of a third field is the assertion. A form that also asked for a secret would
    // imply an administrator should have credential material in front of them (FR-070).
    expect(markup).toContain('Name')
    expect(markup).toContain('Credential group')
    expect(markup).not.toContain('Secret')
    expect(markup).not.toContain('password')
  })

  it('labels the picker above it, never as a placeholder standing in for a label', () => {
    const markup = render()

    expect(markup.indexOf('<label')).toBeLessThan(markup.indexOf('<select'))
  })

  it('lists a disabled group and says it is disabled, rather than hiding it', () => {
    // Staging replacement capacity is "disable the pool, rebuild it, re-enable it". Hiding the
    // group would make the ordinary way to rebuild one look impossible.
    const markup = render()

    expect(markup).toContain('seats-a')
    expect(markup).toContain('overflow — disabled')
  })

  it('counts the groups a seat could be registered into', () => {
    expect(render()).toContain('groups 2')
  })

  it('says the seat is handed to nobody until material exists for it (FR-008)', () => {
    expect(render()).toContain('handed to nobody')
  })

  it('will not submit without both a name and a group', () => {
    expect(render()).toContain('disabled')
    expect(render({ name: 'seat-one', credentialGroupId: groups[0].id })).toContain('Register seat')
  })

  it('replaces the button with a live readout while a registration is in flight', () => {
    const markup = render({ startedAt: Date.now() })

    expect(markup).toContain('Registering')
  })
})
