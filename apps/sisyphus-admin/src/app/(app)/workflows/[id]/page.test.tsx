import { describe, expect, it, vi } from 'vitest'

/**
 * The page reads one URL parameter and mounts the panel. The property worth asserting is what it
 * does **not** do: it never resolves the run. A page that could title itself with the run's ticket
 * reference would have confirmed the run exists, which is exactly the disclosure FR-190 forbids —
 * the id in the URL is the caller's guess.
 */

const panel = vi.fn(() => null)

vi.mock('@sisyphus-admin/env', () => ({
  env: { NEXT_PUBLIC_SITE_URL: 'https://sisyphus.example.com' },
}))
vi.mock('@sisyphus-admin/components/workflows', () => ({ WorkflowDetailPanel: panel }))

const WorkflowDetailPage = (await import('./page')).default
const { dynamic } = await import('./page')

const WORKFLOW_ID = '0199a1f4-0000-7000-8000-0000000000ab'

const render = async () => {
  const element = await WorkflowDetailPage({ params: Promise.resolve({ id: WORKFLOW_ID }) })
  return JSON.stringify(element, (_key, value: unknown) =>
    typeof value === 'function' ? '[component]' : value,
  )
}

describe('the /workflows/[id] page', () => {
  it('titles itself from the URL rather than from the run', async () => {
    const rendered = await render()

    expect(rendered).toContain('"eyebrow":"Run"')
    expect(rendered).toContain(`"title":"${WORKFLOW_ID}"`)
  })

  it('puts nothing run-derived in the heading, so it cannot confirm the run exists', async () => {
    const rendered = await render()

    // Everything above the panel is fixed text plus the id from the URL. A ticket reference, a
    // state or an owner here would be a page that had already resolved the run.
    expect(rendered).not.toContain('ticket')
    expect(rendered).not.toContain('succeeded')
    expect(panel).not.toHaveBeenCalled()
  })

  it('hands the panel the id from the URL', async () => {
    const rendered = await render()

    expect(rendered).toContain(`"workflowId":"${WORKFLOW_ID}"`)
  })

  it('says in the page’s own words that an out-of-scope run reads as not found (FR-190)', async () => {
    const rendered = await render()

    expect(rendered).toContain('reads as not found')
  })

  it('is dynamic, because its output is a function of the caller’s session', () => {
    expect(dynamic).toBe('force-dynamic')
  })
})
