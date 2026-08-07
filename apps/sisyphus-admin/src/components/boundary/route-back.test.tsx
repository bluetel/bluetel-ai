import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ROUTE_BACK_HREF, RouteBack } from './route-back'

describe('RouteBack', () => {
  it('goes to the fleet list, which every role can open', () => {
    expect(ROUTE_BACK_HREF).toBe('/workflows')
    expect(renderToStaticMarkup(<RouteBack />)).toContain('href="/workflows"')
  })

  it('says where it goes rather than “go back”', () => {
    expect(renderToStaticMarkup(<RouteBack />)).toContain('Back to the workflow list')
  })

  it('shows a focus ring, because it is often the only focusable thing on the screen', () => {
    expect(renderToStaticMarkup(<RouteBack />)).toContain('focus-ring')
  })

  it('is a navigation landmark, findable without reading the card above it', () => {
    const markup = renderToStaticMarkup(<RouteBack />)

    expect(markup).toContain('<nav')
    expect(markup).toContain('aria-label="Route back"')
  })

  it('takes a nearer destination where one exists', () => {
    const markup = renderToStaticMarkup(<RouteBack href="/admin/users" label="Back to users" />)

    expect(markup).toContain('href="/admin/users"')
    expect(markup).toContain('Back to users')
  })

  it('names no colour of its own', () => {
    expect(renderToStaticMarkup(<RouteBack />)).not.toMatch(/#[0-9a-fA-F]{3,8}/)
  })
})
