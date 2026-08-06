import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { FieldControl } from './field-control'

describe('FieldControl', () => {
  it('reports a valid state to assistive technology and to the DOM', () => {
    const markup = renderToStaticMarkup(<FieldControl name="prompt" />)
    expect(markup).toContain('aria-invalid="false"')
    expect(markup).toContain('data-state="valid"')
  })

  it('reports a refused value in both places', () => {
    const markup = renderToStaticMarkup(<FieldControl name="prompt" invalid />)
    expect(markup).toContain('aria-invalid="true"')
    expect(markup).toContain('data-state="invalid"')
    expect(markup).toContain('border-rust')
  })

  it('passes native attributes straight through', () => {
    const markup = renderToStaticMarkup(
      <FieldControl name="prompt" placeholder="Describe the change" required />,
    )
    expect(markup).toContain('name="prompt"')
    expect(markup).toContain('placeholder="Describe the change"')
    expect(markup).toContain('required')
  })

  it('composes a caller class through the shared cn', () => {
    const markup = renderToStaticMarkup(<FieldControl className="w-full" />)
    expect(markup).toContain('w-full')
    expect(markup).toContain('type-body')
  })
})
