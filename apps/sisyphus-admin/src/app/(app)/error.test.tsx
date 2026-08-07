import { BOUNDARY_ERROR_CODE } from '@sisyphus-admin/components/boundary'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

/**
 * `@sisyphus-admin/env` is stubbed because `PageHeader` is imported through the shell barrel, which
 * also publishes the top bar, which owns the sign-out server action, which loads the auth config
 * and validates the whole environment at import time. None of that is on this screen; the stub is
 * what keeps a boundary test from needing a database URL to render a 404.
 */
vi.mock('@sisyphus-admin/env', () => ({
  env: { NEXT_PUBLIC_SITE_URL: 'https://sisyphus.example.com' },
}))

const AppError = (await import('./error')).default

const thrown = Object.assign(new Error('Cannot read properties of undefined'), {
  digest: '3751908259',
})

describe('the error boundary inside the shell', () => {
  const markup = renderToStaticMarkup(
    <AppError
      error={thrown}
      reset={() => {
        /* React's reset */
      }}
    />,
  )

  it('carries a code and a next action rather than a dead end (FR-031)', () => {
    expect(markup).toContain(BOUNDARY_ERROR_CODE)
    expect(markup).toMatch(/Try the screen again/i)
  })

  it('quotes the digest, which is what ties this screen to the server log', () => {
    expect(markup).toContain('3751908259')
  })

  it('offers a retry, because re-rendering resolves a transient failure without a reload', () => {
    expect(markup).toContain('Try again')
  })

  it('offers a route back as well, so a persistent failure is still not a dead end', () => {
    expect(markup).toContain('href="/workflows"')
  })

  it('does not print the thrown message', () => {
    expect(markup).not.toContain('Cannot read properties of undefined')
  })

  it('opens no second main landmark, because the group’s layout already opened one', () => {
    expect(markup).not.toContain('<main')
  })

  it('reports no machine state colour: a screen that failed to draw is not a failed run', () => {
    expect(markup).toContain('data-state="idle"')
    expect(markup).not.toContain('text-amber')
    expect(markup).not.toContain('text-verdigris')
  })
})
