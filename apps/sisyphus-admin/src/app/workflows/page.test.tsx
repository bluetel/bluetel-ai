import { describe, expect, it, vi } from 'vitest'

/**
 * The page parses the query string and mounts the panel. Two properties are worth asserting: that
 * the filters reach the panel already parsed, so the first render is the filtered list rather than
 * an unfiltered one that flickers; and that the page resolves **nothing** about the runs — no
 * count, no total, nothing in the heading that would depend on what the caller can see (FR-190).
 */

const panel = vi.fn(() => null)

vi.mock('@sisyphus-admin/env', () => ({
  env: { NEXT_PUBLIC_SITE_URL: 'https://sisyphus.example.com' },
}))

vi.mock('@sisyphus-admin/components/workflows', async () => {
  // The real parser, so the page is exercised against the conversion it actually ships with; only
  // the panel is replaced, because mounting it would need a query client.
  const actual = await vi.importActual<{ parseWorkflowFilters: unknown }>(
    '@sisyphus-admin/components/workflows/workflow-filters',
  )
  return { WorkflowsPanel: panel, parseWorkflowFilters: actual.parseWorkflowFilters }
})

const WorkflowsPage = (await import('./page')).default
const { dynamic } = await import('./page')

const render = async (searchParams: Record<string, string | string[] | undefined>) => {
  panel.mockClear()
  const element = await WorkflowsPage({ searchParams: Promise.resolve(searchParams) })
  return JSON.stringify(element, (_key, value: unknown) =>
    typeof value === 'function' ? '[component]' : value,
  )
}

describe('the /workflows page', () => {
  it('hands the panel the filters already parsed from the query string', async () => {
    const rendered = await render({ state: ['running'], q: 'ABC-12' })

    expect(rendered).toContain('"search":"ABC-12"')
    expect(rendered).toContain('"states":["running"]')
  })

  it('drops a state a hand-edited URL invented, so a stale link lists rather than errors', async () => {
    const rendered = await render({ state: ['deleted'] })

    expect(rendered).toContain('"states":[]')
  })

  it('names itself without resolving anything about the runs', async () => {
    const rendered = await render({})

    expect(rendered).toContain('Workflows')
    expect(rendered).toContain('Fleet')
    expect(rendered).not.toMatch(/"summary":"[^"]*\d+ runs/)
  })

  it('states in the page’s own words that filters narrow and never widen (FR-190)', async () => {
    const rendered = await render({})

    expect(rendered).toContain('they never widen it')
  })

  it('is dynamic, because its output is a function of the caller’s session', () => {
    expect(dynamic).toBe('force-dynamic')
  })
})
