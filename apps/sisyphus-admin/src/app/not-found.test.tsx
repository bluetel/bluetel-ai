import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

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

const RootNotFound = (await import('./not-found')).default

/**
 * The root not-found boundary (T153, FR-197).
 *
 * The placement assertion at the bottom is the one that matters most and is the one nothing else
 * can check: Next.js resolves `notFound()` against the nearest boundary **above the segment that
 * threw**, so a root boundary alone would render a non-admin's refusal outside the shell. The
 * second file inside `(app)` is what puts it in the console, and a refactor that deleted it would
 * silently regress FR-197 with every existing test still green.
 */
describe('the root not-found boundary', () => {
  const markup = renderToStaticMarkup(<RootNotFound />)

  it('is styled by the panel, not by the framework default', () => {
    expect(markup).toContain('type-heading')
    expect(markup).toContain('No such screen')
  })

  it('opens the main landmark and the page column, because nothing above it does', () => {
    expect(markup).toContain('<main')
    expect(markup).toContain('p-gutter')
    expect(markup).toContain('max-w-column')
  })

  it('offers a route back that is safe for a caller with no session', () => {
    expect(markup).toContain('href="/workflows"')
  })

  it('never mentions permission or a role (FR-190)', () => {
    expect(markup).not.toMatch(/permission/i)
    expect(markup).not.toMatch(/forbidden/i)
  })

  it('does not render the shell, which needs a session this caller may not have', () => {
    expect(markup).not.toContain('Skip to content')
    expect(markup).not.toContain('aria-label="Primary"')
  })

  it('is accompanied by a boundary inside the shell group, which catches a different throw', () => {
    const inGroup = fileURLToPath(new URL('./(app)/not-found.tsx', import.meta.url))

    expect(existsSync(inGroup)).toBe(true)
  })
})
