'use client'

import { toChainMember, WorkflowChainView } from '@sisyphus-admin/components/workflows/chain'
import { api } from '@sisyphus-admin/trpc'
import { useMemo } from 'react'

import { createChainLoader } from './chain-loader'

/**
 * Where `workflow.chain` is handed to the chain view (T102, FR-152).
 *
 * The page is a server component and a loader is a function, so the two cannot meet there. This is
 * the client boundary that builds one: it is the only thing in this route that knows *which*
 * procedure assembles the chain, which is exactly the seam `WorkflowChainView`'s `loadChain` prop
 * was left open for.
 *
 * `useMemo` is not an optimisation here. `WorkflowChainView` runs its walk in an effect keyed on the
 * loader, so a loader rebuilt on every render would re-run the walk on every render — and each walk
 * ends in `setState`, which renders again. A stable identity is what makes the effect run once.
 *
 * Both reads go through `api.useUtils()`, the same query client the declarative hooks use, so a run
 * the detail page has already fetched is not fetched again.
 */
interface WorkflowChainSlotProps {
  readonly workflowId: string
}

export const WorkflowChainSlot = ({ workflowId }: WorkflowChainSlotProps) => {
  const utils = api.useUtils()

  const loadChain = useMemo(
    () =>
      createChainLoader({
        readChain: async (id) => utils.workflow.chain.fetch({ workflowId: id }),
        readMember: async (id) => {
          try {
            return toChainMember(await utils.workflow.byId.fetch({ workflowId: id }))
          } catch {
            // Absent, or outside the caller's scope. The two are the same answer by design (FR-190).
            return undefined
          }
        },
      }),
    [utils],
  )

  return <WorkflowChainView workflowId={workflowId} loadChain={loadChain} />
}
