import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

/**
 * The bar, asserted for what FR-194 asks of it: the signed-in identity is on screen, and the way
 * out is a control on the page rather than something to go looking for.
 *
 * The action is stubbed because the real one reaches Auth.js and a database; that it ends the
 * session and returns to sign-in is asserted in `sign-out-action.test.ts`.
 */
const signOutAction = vi.fn(() => Promise.resolve())

vi.mock('./sign-out-action', () => ({ signOutAction }))

const { TopBar } = await import('./top-bar')

const render = () =>
  renderToStaticMarkup(<TopBar displayName="Ada Lovelace" email="ada@bluetel.co.uk" />)

describe('the top bar', () => {
  it('says who is signed in (FR-194)', () => {
    const markup = render()

    expect(markup).toContain('Ada Lovelace')
    expect(markup).toContain('ada@bluetel.co.uk')
  })

  it('exposes sign-out on the screen itself, not behind a menu (SC-058)', () => {
    expect(render()).toContain('Sign out')
  })

  it('signs out by submitting a form, so the control works without JavaScript', () => {
    const markup = render()

    expect(markup).toContain('<form')
    expect(markup).toContain('type="submit"')
  })

  it('is a banner landmark rather than a row of divs', () => {
    expect(render()).toContain('<header')
  })

  it('gives the control the one shared focus ring (FR-201)', () => {
    expect(render()).toContain('focus-ring')
  })

  it('carries no literal colour, size or radius (SC-015)', () => {
    expect(render()).not.toMatch(/#[0-9a-fA-F]{3,8}|\d+(?:px|rem)/)
  })
})
