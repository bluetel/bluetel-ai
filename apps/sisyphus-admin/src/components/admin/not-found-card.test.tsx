import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { NotFoundCard } from './not-found-card'

const render = () => renderToStaticMarkup(<NotFoundCard message="No such execution profile." />)

describe('NotFoundCard', () => {
  it('renders the message it was given', () => {
    expect(render()).toContain('No such execution profile.')
  })

  it('says not found, and says it in the header as well as the chip', () => {
    const markup = render()

    expect(markup).toContain('not found')
    expect(markup).toContain('data-state="idle"')
  })

  it('never mentions permission, which would confirm the target exists', () => {
    const markup = render().toLowerCase()

    expect(markup).not.toContain('permission')
    expect(markup).not.toContain('forbidden')
    expect(markup).not.toContain('not allowed')
    expect(markup).not.toContain('access denied')
  })

  it('uses the idle chip, because absence is not a machine state', () => {
    expect(render()).toContain('text-graphite')
    expect(render()).not.toContain('text-rust')
  })

  it('carries no literal colour, size or radius', () => {
    expect(render()).not.toMatch(/#[0-9a-fA-F]{3,8}|\d+(?:px|rem)/)
  })
})
