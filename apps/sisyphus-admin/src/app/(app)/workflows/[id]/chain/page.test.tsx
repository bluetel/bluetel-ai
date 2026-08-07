import { describe, expect, it, vi } from 'vitest'

/**
 * The page reads one URL parameter and mounts the chain view. The property worth asserting is the
 * same one the detail page holds: it never resolves the run. A page that could title itself from
 * the chain — "3 runs, £41" — would have confirmed the run exists before anything decided whether
 * the caller may know that (FR-190).
 */

const view = vi.fn(() => null)

vi.mock('@sisyphus-admin/env', () => ({
  env: { NEXT_PUBLIC_SITE_URL: 'https://sisyphus.example.com' },
}))
vi.mock('./chain-view-slot', () => ({ WorkflowChainSlot: view }))

const WorkflowChainPage = (await import('./page')).default
const { dynamic } = await import('./page')

const WORKFLOW_ID = '0199a1f4-0000-7000-8000-0000000000ab'

const render = async (): Promise<string> => {
  const element = await WorkflowChainPage({ params: Promise.resolve({ id: WORKFLOW_ID }) })

  return JSON.stringify(element, (_key, value: unknown) =>
    typeof value === 'function' ? '[component]' : value,
  )
}

describe('the /workflows/[id]/chain page', () => {
  it('titles itself from the URL rather than from the chain', async () => {
    const rendered = await render()

    expect(rendered).toContain('"eyebrow":"Chain"')
    expect(rendered).toContain(`"title":"${WORKFLOW_ID}"`)
  })

  it('resolves nothing about the run before rendering the view', async () => {
    await render()

    expect(view).not.toHaveBeenCalled()
  })

  it('hands the view the id from the URL', async () => {
    const rendered = await render()

    expect(rendered).toContain(`"workflowId":"${WORKFLOW_ID}"`)
  })

  it('says in the page’s own words that an invisible run is neither listed nor counted (FR-190)', async () => {
    const rendered = await render()

    expect(rendered).toContain('neither listed nor counted')
  })

  it('promises both directions in its own summary (FR-152)', async () => {
    const rendered = await render()

    expect(rendered).toContain('what each one continued, what continued it')
  })

  it('is dynamic, because its output is a function of the caller’s session', () => {
    expect(dynamic).toBe('force-dynamic')
  })
})
