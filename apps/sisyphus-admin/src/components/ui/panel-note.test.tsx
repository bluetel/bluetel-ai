import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { PanelNote } from './panel-note'

describe('PanelNote', () => {
  it('is a machine readout in graphite, because it reports the panel and not a person', () => {
    const markup = renderToStaticMarkup(<PanelNote note="empty">no users</PanelNote>)

    expect(markup).toContain('type-data-mono')
    expect(markup).toContain('text-graphite')
  })

  it('names no colour, size or radius of its own', () => {
    const markup = renderToStaticMarkup(<PanelNote note="empty">no users</PanelNote>)

    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(markup).not.toMatch(/\d+px/)
  })

  it('says which of the two states it is in, in one readable attribute', () => {
    expect(renderToStaticMarkup(<PanelNote note="loading">reading</PanelNote>)).toContain(
      'data-note="loading"',
    )
    expect(renderToStaticMarkup(<PanelNote note="empty">none</PanelNote>)).toContain(
      'data-note="empty"',
    )
  })

  it('is the same element either way, so swapping one state for the other shifts nothing', () => {
    const loading = renderToStaticMarkup(<PanelNote note="loading">reading</PanelNote>)
    const empty = renderToStaticMarkup(<PanelNote note="empty">reading</PanelNote>)

    expect(loading.replace('loading', 'empty').replace(' role="status"', '')).toBe(empty)
  })

  it('announces itself only when told to', () => {
    expect(renderToStaticMarkup(<PanelNote note="empty">none</PanelNote>)).not.toContain('role=')
    expect(
      renderToStaticMarkup(
        <PanelNote note="loading" role="status">
          reading
        </PanelNote>,
      ),
    ).toContain('role="status"')
  })
})
