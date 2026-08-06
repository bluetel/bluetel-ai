import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { CardHeader } from './card-header'

describe('CardHeader', () => {
  it('is a tinted strip above a hairline', () => {
    const markup = renderToStaticMarkup(<CardHeader>Run 4f21</CardHeader>)
    expect(markup).toContain('bg-paper-2')
    expect(markup).toContain('border-b')
    expect(markup).toContain('border-hairline')
  })

  it('sets its title in uppercase mono, which is what a header is', () => {
    expect(renderToStaticMarkup(<CardHeader>Run 4f21</CardHeader>)).toContain('type-label-mono')
  })

  it('lays out as a row with room for a state chip at the far end', () => {
    const markup = renderToStaticMarkup(<CardHeader>Run 4f21</CardHeader>)
    expect(markup).toContain('justify-between')
    expect(markup).toContain('items-center')
  })
})
