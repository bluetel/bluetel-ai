'use client'

import { api } from '@sisyphus-admin/trpc'
import { useEffect, useState } from 'react'

import { useNow } from '../use-now'

import { toChainMember } from './chain-source'
import type { ChainLoader, ChainMemberReader, LoadedChain } from './chain-walk'
import { walkPredecessors } from './chain-walk'
import { WorkflowChainPanel } from './workflow-chain-panel'

/**
 * The client container for `/workflows/{id}/chain` (T102, FR-152, FR-190).
 *
 * ## Why the loader is a prop
 *
 * The chain is assembled by a {@link ChainLoader}, and which one is in force is the single decision
 * this component makes. The default walks backwards over `workflow.byId`, because that is the
 * procedure the panel can reach today; `workflow.chain` — the server-side walk that does both
 * directions in one scoped query set — is written and unmounted, and pointing this at it is a
 * one-line loader passed here. Making that a parameter rather than an edit keeps the seam visible
 * and keeps the panel identical either way.
 *
 * ## Fetching imperatively, on purpose
 *
 * A chain is a variable number of sequential reads, and a hook cannot be called in a loop. So the
 * walk runs in an effect through `api.useUtils()`, which is the same query client the declarative
 * hooks use — the reads are cached and deduplicated exactly as `useQuery` would have them, and a
 * run already fetched by the detail page is not fetched again.
 *
 * ## An out-of-scope run reads as not found
 *
 * `workflow.byId` answers `NOT_FOUND` for a run that does not exist **and** for one outside the
 * caller's scope, identically. The walk turns a rejected read into an absent member, so this
 * component never sees the difference and cannot render it — which is the point (FR-190).
 */
interface WorkflowChainViewProps {
  readonly workflowId: string
  /** Overridden when `workflow.chain` is mounted. See the module comment. */
  readonly loadChain?: ChainLoader
}

interface ChainViewState {
  readonly chain: LoadedChain | undefined
  readonly loading: boolean
}

export const WorkflowChainView = ({ workflowId, loadChain }: WorkflowChainViewProps) => {
  const utils = api.useUtils()
  const now = useNow()
  const [state, setState] = useState<ChainViewState>({ chain: undefined, loading: true })

  useEffect(() => {
    let live = true

    const read: ChainMemberReader = async (id) => {
      try {
        return toChainMember(await utils.workflow.byId.fetch({ workflowId: id }))
      } catch {
        // Absent, or outside the caller's scope. The two are the same answer by design (FR-190).
        return undefined
      }
    }

    const load = loadChain ?? ((id: string) => walkPredecessors(read, id))

    void load(workflowId).then((chain) => {
      if (live) {
        setState({ chain, loading: false })
      }
    })

    return () => {
      live = false
    }
  }, [workflowId, loadChain, utils])

  return (
    <WorkflowChainPanel
      requestedWorkflowId={workflowId}
      chain={state.chain}
      loading={state.loading}
      notFound={!state.loading && state.chain?.members.length === 0}
      {...(now === undefined ? {} : { now })}
    />
  )
}
