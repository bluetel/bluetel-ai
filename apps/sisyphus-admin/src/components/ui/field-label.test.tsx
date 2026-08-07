import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { FieldLabel } from './field-label'

describe('FieldLabel', () => {
  it('sets the label in uppercase mono, in graphite', () => {
    const markup = renderToStaticMarkup(<FieldLabel htmlFor="prompt">Prompt</FieldLabel>)
    expect(markup).toContain('type-label-mono')
    expect(markup).toContain('text-graphite')
  })

  it('renders a real label element bound to its control', () => {
    const markup = renderToStaticMarkup(<FieldLabel htmlFor="prompt">Prompt</FieldLabel>)
    expect(markup).toContain('<label')
    expect(markup).toContain('for="prompt"')
  })

  it('merges a caller class through the shared cn', () => {
    expect(renderToStaticMarkup(<FieldLabel className="text-ink">Prompt</FieldLabel>)).toContain(
      'text-ink',
    )
  })
})
