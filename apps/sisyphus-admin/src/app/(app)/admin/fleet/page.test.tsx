import { describe, expect, it, vi } from 'vitest'

/**
 * The page gates, parses the query string and mounts the panel. Four properties are worth
 * asserting: that the gate runs **before** anything else, so a non-admin gets no markup rather than
 * hidden markup; that the filters and the grouping reach the panel already parsed, so the first
 * render is the filtered view; that a hand-edited `?by=user` cannot make this an individual
 * breakdown (FR-156); and that the page resolves nothing about the runs itself (FR-190).
 */

const panel = vi.fn(() => null)
const requireAdminPage = vi.fn(async () => Promise.resolve({ id: 'admin' }))

vi.mock('@sisyphus-admin/env', () => ({
  env: { NEXT_PUBLIC_SITE_URL: 'https://sisyphus.example.com' },
}))

vi.mock('@sisyphus-admin/server', () => ({ requireAdminPage }))

vi.mock('@sisyphus-admin/components/admin/fleet', async () => {
  // The real parser, so the page is exercised against the conversion it actually ships with; only
  // the panel is replaced, because mounting it would need a query client.
  const actual = await vi.importActual<Record<string, unknown>>(
    '@sisyphus-admin/components/admin/fleet/spend-grouping',
  )
  return {
    FleetPanel: panel,
    GROUPING_PARAM: actual.GROUPING_PARAM,
    parseSpendGrouping: actual.parseSpendGrouping,
  }
})

const FleetPage = (await import('./page')).default
const { dynamic } = await import('./page')

const render = async (searchParams: Record<string, string | string[] | undefined>) => {
  panel.mockClear()
  const element = await FleetPage({ searchParams: Promise.resolve(searchParams) })
  return JSON.stringify(element, (_key, value: unknown) =>
    typeof value === 'function' ? '[component]' : value,
  )
}

describe('the /admin/fleet page', () => {
  it('opens with the admin gate, which throws rather than hiding', async () => {
    requireAdminPage.mockClear()
    await render({})

    expect(requireAdminPage).toHaveBeenCalledTimes(1)
  })

  it('hands the panel the filters already parsed from the query string', async () => {
    const rendered = await render({ state: ['running'], q: 'ABC-12' })

    expect(rendered).toContain('"search":"ABC-12"')
    expect(rendered).toContain('"states":["running"]')
  })

  it('hands the panel a grouping the screen offers', async () => {
    expect(await render({ by: 'workspace' })).toContain('"initialGrouping":"workspace"')
  })

  it('refuses a hand-edited individual grouping (FR-156)', async () => {
    const rendered = await render({ by: 'user' })

    expect(rendered).not.toContain('"initialGrouping":"user"')
    expect(rendered).toContain('"initialGrouping":"profile"')
  })

  it('drops a state a hand-edited URL invented, so a stale link lists rather than errors', async () => {
    expect(await render({ state: ['deleted'] })).toContain('"states":[]')
  })

  it('names itself without resolving anything about the runs', async () => {
    const rendered = await render({})

    expect(rendered).toContain('Oversight')
    expect(rendered).toContain('Fleet')
    expect(rendered).not.toMatch(/"summary":"[^"]*\d+ runs/)
  })

  it('states in the page’s own words that the totals cover only the caller’s scope (FR-190)', async () => {
    expect(await render({})).toContain('Totals cover exactly the runs in your scope')
  })

  it('is dynamic, because its output is a function of the caller’s session', () => {
    expect(dynamic).toBe('force-dynamic')
  })
})
