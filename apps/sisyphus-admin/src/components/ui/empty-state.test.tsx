import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { EmptyState } from './empty-state'

describe('EmptyState', () => {
  it('states the absence in the caller’s words rather than a generic “no data”', () => {
    const markup = renderToStaticMarkup(<EmptyState>no users match that search</EmptyState>)

    expect(markup).toContain('no users match that search')
  })

  it('marks itself as the empty case, so it cannot be read as a loading one', () => {
    expect(renderToStaticMarkup(<EmptyState>none</EmptyState>)).toContain('data-note="empty"')
  })

  it('does not interrupt: a list that arrives empty is part of the page, not an event', () => {
    expect(renderToStaticMarkup(<EmptyState>none</EmptyState>)).not.toContain('role=')
  })

  it('is built from the panel note rather than a second line style of its own', () => {
    const markup = renderToStaticMarkup(<EmptyState>none</EmptyState>)

    expect(markup).toContain('type-data-mono')
    expect(markup).toContain('text-graphite')
  })
})
