import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Card } from './card'

describe('Card', () => {
  it('is a lighter plane inside a hairline at the container radius', () => {
    const markup = renderToStaticMarkup(<Card>Body</Card>)
    expect(markup).toContain('bg-paper')
    expect(markup).toContain('border-hairline')
    expect(markup).toContain('rounded-md')
  })

  it('carries no shadow, because elevation means temporary and a card is not', () => {
    expect(renderToStaticMarkup(<Card>Body</Card>)).not.toMatch(/shadow-(?!none)/)
  })

  it('is a section, so a card is a landmark rather than a div', () => {
    expect(renderToStaticMarkup(<Card aria-label="Run">Body</Card>)).toContain('<section')
  })

  it('clips its header strip to the container radius', () => {
    expect(renderToStaticMarkup(<Card>Body</Card>)).toContain('overflow-hidden')
  })
})
