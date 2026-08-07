import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { BoundaryScreen } from './boundary-screen'

describe('BoundaryScreen', () => {
  it('opens the main landmark, because nothing above it does', () => {
    expect(renderToStaticMarkup(<BoundaryScreen>x</BoundaryScreen>)).toContain('<main')
  })

  it('sets the same page column and gutter the shell would have', () => {
    const markup = renderToStaticMarkup(<BoundaryScreen>x</BoundaryScreen>)

    expect(markup).toContain('p-gutter')
    expect(markup).toContain('max-w-column')
  })

  it('does not claim the shell’s main id, which belongs to the skip link’s target', () => {
    expect(renderToStaticMarkup(<BoundaryScreen>x</BoundaryScreen>)).not.toContain(
      'id="main-content"',
    )
  })

  it('names no colour, size or radius of its own', () => {
    const markup = renderToStaticMarkup(<BoundaryScreen>x</BoundaryScreen>)

    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(markup).not.toMatch(/\d+px/)
  })
})
