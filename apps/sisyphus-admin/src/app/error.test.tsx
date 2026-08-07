import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

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

const RootError = (await import('./error')).default

const thrown = Object.assign(new Error('ECONNREFUSED 127.0.0.1:5432'), { digest: '99f0' })

describe('the root error boundary', () => {
  const markup = renderToStaticMarkup(
    <RootError
      error={thrown}
      reset={() => {
        /* React's reset */
      }}
    />,
  )

  it('carries a code, a digest and a next action (FR-031)', () => {
    expect(markup).toContain(BOUNDARY_ERROR_CODE)
    expect(markup).toContain('99f0')
    expect(markup).toMatch(/Try the screen again/i)
  })

  it('opens the main landmark and the page column, because nothing above it does', () => {
    expect(markup).toContain('<main')
    expect(markup).toContain('max-w-column')
  })

  it('does not print the thrown message, which may name something the caller may not see', () => {
    expect(markup).not.toContain('ECONNREFUSED')
  })

  it('offers both a retry and a route back', () => {
    expect(markup).toContain('Try again')
    expect(markup).toContain('href="/workflows"')
  })

  it('does not render the shell, which needs a session that may be the thing that threw', () => {
    expect(markup).not.toContain('Skip to content')
    expect(markup).not.toContain('aria-label="Primary"')
  })

  it('is accompanied by a boundary inside the shell group, which catches a different throw', () => {
    expect(existsSync(fileURLToPath(new URL('./(app)/error.tsx', import.meta.url)))).toBe(true)
  })

  it('is not a global-error boundary, which would replace the token layer as well', () => {
    expect(existsSync(fileURLToPath(new URL('./global-error.tsx', import.meta.url)))).toBe(false)
  })
})
