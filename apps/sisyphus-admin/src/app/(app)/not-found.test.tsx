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

const AppNotFound = (await import('./not-found')).default

/**
 * The boundary an engineer lands on when they open an admin URL (T153, FR-197, FR-190).
 *
 * The property under test is not "it looks nice". It is that the screen says *not found* and only
 * not found — `requireAdminPage()` chose `notFound` over `forbidden` so the caller cannot tell a
 * screen they may not have from one that does not exist, and a boundary that mentioned permission
 * would undo that from the outside.
 */
describe('the not-found boundary inside the shell', () => {
  const markup = renderToStaticMarkup(<AppNotFound />)

  it('says not found', () => {
    expect(markup).toContain('No such screen')
  })

  it('never mentions permission, a role, or an admin (FR-190)', () => {
    expect(markup).not.toMatch(/permission/i)
    expect(markup).not.toMatch(/\badmin\b/i)
    expect(markup).not.toMatch(/forbidden/i)
    expect(markup).not.toMatch(/not authorised|not authorized/i)
  })

  it('offers a route back rather than a dead end (FR-197)', () => {
    expect(markup).toContain('href="/workflows"')
    expect(markup).toContain('Back to the workflow list')
  })

  it('reuses the panel’s one not-found card, chip and all', () => {
    expect(markup).toContain('not found')
    expect(markup).toContain('data-state="idle"')
  })

  it('opens no second main landmark, because the group’s layout already opened one', () => {
    expect(markup).not.toContain('<main')
  })

  it('renders the page header rather than a hand-rolled heading block', () => {
    expect(markup).toContain('type-heading')
    expect(markup).toContain('type-label-mono')
  })
})
