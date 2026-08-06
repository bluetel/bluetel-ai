import type { WorkflowState } from '@bluetel-ai/sisyphus-api/client'
import { formatElapsed, formatTimestamp } from '@sisyphus-admin/components/admin'

import { abbreviateRunId, elapsedMs, isLiveWorkflow } from '../workflow-listing'

/**
 * **Successor chains, both ways (T102, FR-150, FR-152).**
 *
 * A run that hit its spend cap is continued by a *successor* rather than by an edit, so the true
 * cost of a piece of work is spread across several workflow rows and the record of what happened
 * is a sequence rather than a row. FR-152 asks for two things from that: traversal in **both**
 * directions, and consumption reportable both per workflow and summed across the whole chain.
 *
 * Everything decidable without a network is decided here, so it can be asserted without one:
 * ordering, the two neighbours, the totals, and every readout. The panel renders what this returns
 * and makes no decisions of its own.
 *
 * ## Ordering is derived, not trusted
 *
 * {@link orderChain} follows `predecessorWorkflowId` from the earliest visible member rather than
 * sorting by `createdAt`. Two successors created in the same second sort arbitrarily by time, and a
 * chain rendered in the wrong order tells a story that did not happen. Where the links are broken —
 * which is what a chain with an out-of-scope member in the middle looks like (FR-190) — the
 * remaining members follow in time order rather than being dropped.
 */

/**
 * One run in the chain.
 *
 * Declared structurally rather than imported from the procedure's output type, because the panel's
 * job is to render a chain and not to know which procedure produced it. It matches `ChainLink` in
 * `server/workflow/successor.ts` field for field, so wiring the two together is an assignment.
 */
export interface ChainMember {
  readonly workflowId: string
  /** Null for the root of the chain — the run that continues nothing. */
  readonly predecessorWorkflowId: string | null
  readonly state: WorkflowState
  readonly terminalOutcome: string | null
  readonly model: string
  readonly turnCap: number | null
  readonly spendCap: string | null
  readonly turnsUsed: number
  readonly spendUsed: string
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** The em dash the panel uses for a value that is genuinely absent. */
export const ABSENT = '—'

/**
 * Order a chain oldest first by following the predecessor links.
 *
 * @param members - The chain in any order.
 */
export const orderChain = (members: readonly ChainMember[]): readonly ChainMember[] => {
  const byId = new Map(members.map((member) => [member.workflowId, member]))
  const byPredecessor = new Map<string, ChainMember>()

  for (const member of members) {
    if (member.predecessorWorkflowId !== null) {
      byPredecessor.set(member.predecessorWorkflowId, member)
    }
  }

  const inTimeOrder = [...members].sort(
    (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
  )
  // The first run whose predecessor is not among the visible members. That is the root when the
  // chain is whole, and the earliest visible run when part of it is out of scope.
  const root =
    inTimeOrder.find(
      (member) => member.predecessorWorkflowId === null || !byId.has(member.predecessorWorkflowId),
    ) ?? inTimeOrder[0]

  const ordered: ChainMember[] = []
  const placed = new Set<string>()
  let cursor: ChainMember | undefined = root

  while (cursor !== undefined && !placed.has(cursor.workflowId)) {
    ordered.push(cursor)
    placed.add(cursor.workflowId)
    cursor = byPredecessor.get(cursor.workflowId)
  }

  // Anything the walk could not reach — a second fragment left by an invisible middle — follows in
  // time order rather than disappearing, because a run the caller *can* see must still be listed.
  for (const member of inTimeOrder) {
    if (!placed.has(member.workflowId)) {
      ordered.push(member)
      placed.add(member.workflowId)
    }
  }

  return ordered
}

/** The run before and the run after — the two directions FR-152 requires. */
export interface ChainNeighbours {
  /** The run this one continues, or `undefined` at the start of the chain. */
  readonly previous: ChainMember | undefined
  /** The run that continues this one, or `undefined` at the end of the chain. */
  readonly next: ChainMember | undefined
}

/**
 * The immediate neighbours of one run.
 *
 * Both are looked up on the link rather than on position in the ordered array, so a fragmented
 * chain does not produce a "next" that is simply the following row.
 */
export const chainNeighbours = (
  members: readonly ChainMember[],
  workflowId: string,
): ChainNeighbours => {
  const current = members.find((member) => member.workflowId === workflowId)

  return {
    previous:
      current?.predecessorWorkflowId === null || current === undefined
        ? undefined
        : members.find((member) => member.workflowId === current.predecessorWorkflowId),
    next: members.find((member) => member.predecessorWorkflowId === workflowId),
  }
}

/** Consumption across the whole chain (FR-152). */
export interface ChainTotals {
  readonly workflowCount: number
  readonly turnsTotal: number
  /** Fixed to four places, matching the money column, so two chains are comparable as strings. */
  readonly spendTotal: string
}

/**
 * Sum consumption across the chain.
 *
 * Over the members **given**, which under FR-190 are the members the caller may see. A total that
 * silently included an invisible run would disclose its existence in a number nobody would think to
 * check, so the figure is honest about being a figure for the visible chain.
 */
export const summariseChain = (members: readonly ChainMember[]): ChainTotals => ({
  workflowCount: members.length,
  turnsTotal: members.reduce((total, member) => total + member.turnsUsed, 0),
  spendTotal: members.reduce((total, member) => total + Number(member.spendUsed), 0).toFixed(4),
})

/** One run of the chain as the panel renders it. */
export interface ChainMemberReadouts {
  readonly workflowId: string
  readonly runId: string
  /** 1-based, oldest first. */
  readonly position: number
  readonly state: WorkflowState
  readonly stateReadout: string
  readonly model: string
  readonly turns: string
  readonly spend: string
  readonly startedAt: string
  /** True for the run whose page this is. */
  readonly isRequested: boolean
  /** What this run continues, and what continues it, as a sentence fragment for the row. */
  readonly relation: string
}

/**
 * The chip's readout for one member.
 *
 * The same rule the list follows — a working run carries its elapsed time, a settled one does not —
 * restated over a chain member rather than over a list row, because the two carry different fields
 * and a shared signature would mean widening one of them to satisfy the other.
 */
export const chainStateReadout = (member: ChainMember, now: number | undefined): string => {
  const label = member.state.replace(/_/g, ' ')

  return isLiveWorkflow(member.state)
    ? `${label} ${formatElapsed(elapsedMs(member.state, member.createdAt, member.updatedAt, now))}`
    : label
}

const relationFor = (position: number, count: number): string => {
  if (count === 1) {
    return 'the only run in this chain'
  }

  if (position === 1) {
    return 'the first run — continues nothing'
  }

  return position === count ? 'the latest run — nothing continues it yet' : 'continued from and by'
}

/**
 * Shape an ordered chain for rendering.
 *
 * @param members - Ordered oldest first; pass {@link orderChain}'s output.
 * @param requestedWorkflowId - The run whose page this is.
 * @param now - One clock for the page, so every elapsed readout agrees.
 */
export const toChainReadouts = (
  members: readonly ChainMember[],
  requestedWorkflowId: string,
  now: number | undefined,
): readonly ChainMemberReadouts[] =>
  members.map((member, index) => ({
    workflowId: member.workflowId,
    runId: abbreviateRunId(member.workflowId),
    position: index + 1,
    state: member.state,
    stateReadout: chainStateReadout(member, now),
    model: member.model,
    turns:
      member.turnCap === null
        ? `${String(member.turnsUsed)} (uncapped)`
        : `${String(member.turnsUsed)} / ${String(member.turnCap)}`,
    spend:
      member.spendCap === null
        ? `${member.spendUsed} (uncapped)`
        : `${member.spendUsed} / ${member.spendCap}`,
    startedAt: formatTimestamp(member.createdAt),
    isRequested: member.workflowId === requestedWorkflowId,
    relation: relationFor(index + 1, members.length),
  }))
