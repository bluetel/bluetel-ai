import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { BOUNDARY_ERROR_CODE, NO_DIGEST } from './boundary-error'
import { ErrorCard } from './error-card'

describe('ErrorCard', () => {
  it('carries a machine code and a next action, not an apology (FR-031)', () => {
    const markup = renderToStaticMarkup(<ErrorCard />)

    expect(markup).toContain(BOUNDARY_ERROR_CODE)
    expect(markup).toMatch(/Try the screen again/i)
  })

  it('quotes the server’s digest so the screen can be found in the log', () => {
    expect(renderToStaticMarkup(<ErrorCard error={{ digest: '3751908259' }} />)).toContain(
      '3751908259',
    )
  })

  it('states that no digest was recorded rather than leaving a blank readout', () => {
    expect(renderToStaticMarkup(<ErrorCard />)).toContain(NO_DIGEST)
  })

  it('offers a retry only when the boundary gave it one', () => {
    expect(renderToStaticMarkup(<ErrorCard />)).not.toContain('Try again')
    expect(
      renderToStaticMarkup(
        <ErrorCard
          onRetry={() => {
            /* the boundary's reset */
          }}
        />,
      ),
    ).toContain('Try again')
  })

  it('keeps the idle chip: a screen that failed to draw is not a run that failed (FR-025)', () => {
    const markup = renderToStaticMarkup(<ErrorCard />)

    expect(markup).toContain('data-state="idle"')
    expect(markup).not.toContain('text-amber')
    expect(markup).not.toContain('text-verdigris')
  })

  it('puts the refusal in rust, through the one field-error treatment', () => {
    expect(renderToStaticMarkup(<ErrorCard />)).toContain('text-rust')
  })

  it('never prints the thrown message', () => {
    const thrown = Object.assign(new Error('secret internals'), { digest: 'd' })

    expect(renderToStaticMarkup(<ErrorCard error={thrown} />)).not.toContain('secret internals')
  })

  it('names no colour, size or radius of its own', () => {
    const markup = renderToStaticMarkup(<ErrorCard error={{ digest: 'd' }} />)

    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(markup).not.toMatch(/style="/)
  })
})
