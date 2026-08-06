import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { FieldError } from './field-error'

describe('FieldError', () => {
  it('shows the machine code and the next action together', () => {
    const markup = renderToStaticMarkup(
      <FieldError code="E_PROFILE_NOT_FOUND" action="Pick a profile you have access to." />,
    )
    expect(markup).toContain('E_PROFILE_NOT_FOUND')
    expect(markup).toContain('Pick a profile you have access to.')
  })

  it('sets the code in mono and the whole message in rust', () => {
    const markup = renderToStaticMarkup(
      <FieldError code="E_CAP_EXCEEDED" action="Raise the cap." />,
    )
    expect(markup).toContain('type-label-mono')
    expect(markup).toContain('text-rust')
  })

  it('announces itself, because an error after submit must not need looking for', () => {
    expect(renderToStaticMarkup(<FieldError code="E_X" action="Try again." />)).toContain(
      'role="alert"',
    )
  })

  it('takes an id so a control can point at it', () => {
    expect(
      renderToStaticMarkup(<FieldError id="prompt-error" code="E_X" action="Try again." />),
    ).toContain('id="prompt-error"')
  })
})
