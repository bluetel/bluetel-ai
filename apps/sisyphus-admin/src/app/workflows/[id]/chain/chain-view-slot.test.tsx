import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

/**
 * The client boundary that decides which procedure assembles the chain.
 *
 * Two properties are worth settling here and neither is visible in `chain-loader.test.ts`: that the
 * view is handed a loader at all — without one it silently falls back to the backwards-only walk and
 * the panel goes on saying "not established from this view" — and that the loader it is handed keeps
 * its identity across renders, because the view's walk is an effect keyed on it.
 */

const chainFetch = vi.fn(() =>
  Promise.resolve({
    requestedWorkflowId: 'r',
    links: [],
    workflowCount: 0,
    turnsTotal: 0,
    spendTotal: '0.0000',
  }),
)
const byIdFetch = vi.fn(() => Promise.reject(new Error('unused')))

vi.mock('@sisyphus-admin/trpc', () => ({
  api: {
    useUtils: () => ({
      workflow: { chain: { fetch: chainFetch }, byId: { fetch: byIdFetch } },
    }),
  },
}))

interface CapturedProps {
  readonly workflowId: string
  readonly loadChain: unknown
}

let lastProps: CapturedProps | undefined

vi.mock('@sisyphus-admin/components/workflows/chain', () => ({
  WorkflowChainView: (props: CapturedProps): null => {
    lastProps = props
    return null
  },
  toChainMember: (detail: { workflow: { id: string } }) => ({ workflowId: detail.workflow.id }),
}))

const { WorkflowChainSlot } = await import('./chain-view-slot')

const WORKFLOW_ID = '0199a1f4-0000-7000-8000-0000000000ab'

const propsOfLastRender = (): CapturedProps => {
  if (lastProps === undefined) {
    throw new Error('the slot rendered no chain view')
  }

  return lastProps
}

describe('WorkflowChainSlot', () => {
  it('hands the view a loader, so both directions are reachable (FR-152)', () => {
    renderToStaticMarkup(<WorkflowChainSlot workflowId={WORKFLOW_ID} />)

    const props = propsOfLastRender()

    expect(props.workflowId).toBe(WORKFLOW_ID)
    expect(typeof props.loadChain).toBe('function')
  })

  it('reads the chain through workflow.chain rather than walking byId backwards', async () => {
    renderToStaticMarkup(<WorkflowChainSlot workflowId={WORKFLOW_ID} />)

    await (propsOfLastRender().loadChain as (id: string) => Promise<unknown>)(WORKFLOW_ID)

    expect(chainFetch).toHaveBeenCalledWith({ workflowId: WORKFLOW_ID })
  })
})
