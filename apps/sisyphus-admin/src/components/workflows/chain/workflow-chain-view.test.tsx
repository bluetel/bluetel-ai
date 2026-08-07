import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const fetchWorkflow = vi.fn()

vi.mock('@sisyphus-admin/trpc', () => ({
  api: {
    useUtils: () => ({ workflow: { byId: { fetch: fetchWorkflow } } }),
  },
}))

const { WorkflowChainView } = await import('./workflow-chain-view')

/**
 * The container is exercised as a server render, which is where its one on-screen decision lives:
 * what the page says **before** the walk has answered.
 *
 * Effects do not run in this environment, so the walk itself is not exercised here — deliberately.
 * It is a pure function over a reader and is asserted in `chain-walk.test.ts` without React at all,
 * which is a better test of it than any render would be.
 */
const WORKFLOW_ID = '0199a1f4-0000-7000-8000-0000000000ab'

describe('WorkflowChainView', () => {
  it('says it is reading rather than showing an empty chain', () => {
    const markup = renderToStaticMarkup(<WorkflowChainView workflowId={WORKFLOW_ID} />)

    expect(markup).toContain('reading')
    expect(markup).not.toContain('no runs in this chain')
  })

  it('claims nothing about the chain before the walk has answered', () => {
    const markup = renderToStaticMarkup(<WorkflowChainView workflowId={WORKFLOW_ID} />)

    // Neither "not found" nor "this is the latest run" — both would be assertions nobody checked.
    expect(markup).not.toContain('No such run.')
    expect(markup).not.toContain('this is the latest run of the chain')
  })

  it('fetches nothing during render — the reads belong to the effect', () => {
    renderToStaticMarkup(<WorkflowChainView workflowId={WORKFLOW_ID} />)

    expect(fetchWorkflow).not.toHaveBeenCalled()
  })

  it('accepts a loader, which is the seam workflow.chain is mounted through', () => {
    const loadChain = vi.fn()

    const markup = renderToStaticMarkup(
      <WorkflowChainView workflowId={WORKFLOW_ID} loadChain={loadChain} />,
    )

    expect(markup).toContain('reading')
    // Called from the effect, not from render, so a server render triggers no work either way.
    expect(loadChain).not.toHaveBeenCalled()
  })
})
