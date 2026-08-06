import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { DataReadout } from './data-readout'

const render = () =>
  renderToStaticMarkup(<DataReadout label="last sign-in" value="2026-08-05 09:14" />)

describe('DataReadout', () => {
  it('renders the caption and the value', () => {
    const markup = render()

    expect(markup).toContain('last sign-in')
    expect(markup).toContain('2026-08-05 09:14')
  })

  it('splits the two families by authorship: mono label, mono data, never prose for either', () => {
    const markup = render()

    expect(markup).toContain('type-label-mono')
    expect(markup).toContain('type-data-mono')
  })

  it('puts the caption above the value, never beside it as a prefix', () => {
    const markup = render()

    expect(markup.indexOf('last sign-in')).toBeLessThan(markup.indexOf('2026-08-05'))
    expect(markup).toContain('flex-col')
  })

  it('carries no literal colour, size or radius', () => {
    expect(render()).not.toMatch(/#[0-9a-fA-F]{3,8}|\d+(?:px|rem)/)
  })
})
