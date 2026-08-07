import type { WorkflowState } from '@bluetel-ai/sisyphus-api/client'
import { formatElapsed, formatTimestamp } from '@sisyphus-admin/components/admin'
import type { RouterOutputs } from '@sisyphus-admin/trpc'

import type { StorageParkReadout } from './storage-park'
import { toStorageParkReadout } from './storage-park'
import { ABSENT, abbreviateRunId, elapsedMs, isLiveWorkflow } from './workflow-listing'

/**
 * Shaping `workflow.byId` into the readouts the detail view renders (FR-014).
 *
 * Same rule as the list: the type is inferred from the procedure and every derived value is
 * computed here rather than in the JSX, so the decisions that can be wrong are the ones under
 * test. Three of them are worth naming, because each has a wrong answer that looks plausible:
 *
 * - **A cap that is not set is not a cap of zero.** `turn_cap` and `spend_cap` are nullable, and a
 *   run launched without one is uncapped. Rendering `0 / 0` would say the opposite of the truth,
 *   and a meter fed a null ceiling would read as full.
 * - **A finished run's duration must stop.** Measured against `updatedAt`, not against now.
 * - **An outcome reason is not an outcome.** `terminal_outcome` says what happened and
 *   `outcome_reason` says why; a run still in flight has neither, and inventing "in progress" as an
 *   outcome would make the field unreadable for the case it exists for.
 */

/** One run as `workflow.byId` returns it. */
export type WorkflowDetailResult = RouterOutputs['workflow']['byId']

/** A cap and its consumption, or the absence of a cap. */
export interface CapReadout {
  /** What has been used, as a readout. */
  readonly used: string
  /** The ceiling, or `undefined` when the run is uncapped. */
  readonly cap: string | undefined
  /** Numeric pair for the meter. `undefined` when there is no ceiling to measure against. */
  readonly meter: { readonly value: number; readonly max: number } | undefined
}

/** What the detail view puts on screen. */
export interface WorkflowDetailReadouts {
  readonly id: string
  readonly runId: string
  readonly state: WorkflowState
  readonly stateReadout: string
  readonly type: string
  readonly startedByLabel: string
  readonly startedBy: string
  readonly owner: string
  readonly workspace: string
  readonly ticket: string
  readonly model: string
  readonly instanceType: string
  readonly purchaseMode: string
  readonly executionProfile: string
  readonly resultBranch: string
  readonly startedAt: string
  readonly lastMovedAt: string
  readonly duration: string
  readonly turns: CapReadout
  readonly spend: CapReadout
  readonly outcome: string
  readonly outcomeReason: string
  /** Null when the run has not written one. Rendered as its own card, never as a readout. */
  readonly reviewerSummary: string | null
  /** FR-176 — the owner was deactivated and somebody must take this run over. */
  readonly needsReassignment: boolean
  /** FR-163 — oldest-first comment truncation happened while assembling the prompt. */
  readonly promptTruncated: boolean
  /**
   * FR-082 — the run could not write a snapshot and is holding at the boundary, retrying.
   *
   * `undefined` when the run has never parked. Deliberately **not** folded into `stateReadout`:
   * the run's state during a park is genuinely `running`, and overwriting the chip would be the
   * panel disagreeing with the heartbeat. See `./storage-park.ts`.
   */
  readonly storagePark: StorageParkReadout | undefined
}

/** One repository of a multi-repo run, as the detail view reads it (FR-114, FR-118). */
export interface WorkflowEntryReadouts {
  readonly id: string
  readonly repositoryUrl: string
  readonly baseBranch: string
  readonly subdirectory: string
  readonly role: string
  readonly resolvedCommit: string
  readonly changed: string
  readonly result: string
  readonly pullRequestUrl: string | null
  /** FR-079 — recorded, never acted on: whether to rebase is the repository's skills to decide. */
  readonly stalenessNote: string | null
}

const capReadout = (used: string, cap: string | null): CapReadout => {
  if (cap === null) {
    // "uncapped" rather than an empty cell: an absent ceiling is a fact about how the run was
    // launched, and a blank would read as a value nobody had loaded yet.
    return { used, cap: undefined, meter: undefined }
  }

  return { used, cap, meter: { value: Number(used), max: Number(cap) } }
}

/**
 * Derive the readouts for the detail view.
 *
 * @param detail - The run as `workflow.byId` returned it.
 * @param now - The page's clock, or `undefined` before the browser has one. See `./use-now.ts`.
 */
export const toWorkflowDetailReadouts = (
  detail: WorkflowDetailResult,
  now: number | undefined,
): WorkflowDetailReadouts => {
  const { workflow } = detail
  const duration = formatElapsed(
    elapsedMs(workflow.state, workflow.createdAt, workflow.updatedAt, now),
  )

  return {
    id: workflow.id,
    runId: abbreviateRunId(workflow.id),
    state: workflow.state,
    stateReadout: isLiveWorkflow(workflow.state)
      ? `${workflow.state.replace(/_/g, ' ')} ${duration}`
      : workflow.state.replace(/_/g, ' '),
    type: workflow.type,
    startedByLabel: workflow.originatingIntegrationId === null ? 'initiated by' : 'integration',
    startedBy:
      workflow.originatingIntegrationId === null
        ? (detail.initiatedByDisplayName ?? 'platform')
        : (detail.originatingIntegrationName ?? ABSENT),
    owner: detail.ownerDisplayName,
    workspace: detail.workspaceName,
    ticket: workflow.ticketReference ?? ABSENT,
    model: workflow.model,
    instanceType: workflow.instanceType,
    purchaseMode: workflow.purchaseMode,
    executionProfile: detail.executionProfileName ?? 'ad hoc',
    resultBranch: workflow.resultBranchName ?? ABSENT,
    startedAt: formatTimestamp(workflow.createdAt),
    lastMovedAt: formatTimestamp(workflow.updatedAt),
    duration,
    turns: capReadout(
      String(workflow.turnsUsed),
      workflow.turnCap === null ? null : String(workflow.turnCap),
    ),
    spend: capReadout(workflow.spendUsed, workflow.spendCap),
    outcome: workflow.terminalOutcome ?? ABSENT,
    outcomeReason: workflow.outcomeReason ?? ABSENT,
    reviewerSummary: workflow.reviewerSummary,
    needsReassignment: workflow.needsReassignment,
    promptTruncated: workflow.promptTruncated,
    storagePark: toStorageParkReadout(detail.storagePark),
  }
}

/**
 * Derive the readouts for each repository the run touched.
 *
 * An entry with no result yet reads as `pending` rather than as a blank: a multi-repo run reports
 * per entry, and an empty cell would be indistinguishable from an entry the run skipped.
 *
 * @param detail - The run as `workflow.byId` returned it.
 */
export const toWorkflowEntryReadouts = (
  detail: WorkflowDetailResult,
): readonly WorkflowEntryReadouts[] =>
  detail.entries.map((entry) => ({
    id: entry.id,
    repositoryUrl: entry.repositoryUrl,
    baseBranch: entry.baseBranch,
    subdirectory: entry.subdirectory,
    role: entry.isPrimary ? 'primary' : 'secondary',
    resolvedCommit: entry.resolvedCommit ?? ABSENT,
    changed: entry.wasChanged ? 'changed' : 'unchanged',
    result: entry.entryResult ?? 'pending',
    pullRequestUrl: entry.pullRequestUrl,
    stalenessNote: entry.stalenessNote,
  }))

/** One timeline entry as `workflow.timeline` returns it. */
export type TimelineItem = RouterOutputs['workflow']['timeline'][number]

/** What one line of the timeline reads as. */
export interface TimelineReadouts {
  readonly id: string
  readonly event: string
  readonly actor: string
  readonly at: string
}

/**
 * Shape the lifecycle timeline (FR-014, FR-064).
 *
 * The actor is the human's name where there is one and the actor *type* otherwise — `executor`,
 * `platform` — because "who did this" and "what kind of thing did this" are the same question at
 * this level of detail, and an empty attribution on a timeline is the one thing that makes it
 * unusable as an audit record.
 */
export const toTimelineReadouts = (entries: readonly TimelineItem[]): readonly TimelineReadouts[] =>
  entries.map((entry) => ({
    id: entry.id,
    event: entry.event.replace(/_/g, ' '),
    actor: entry.actorDisplayName ?? entry.actorType,
    at: formatTimestamp(entry.createdAt),
  }))

/** One artifact as `workflow.artifacts` returns it. */
export type ArtifactItem = RouterOutputs['workflow']['artifacts'][number]

/** What one artifact row reads as. */
export interface ArtifactReadouts {
  readonly id: string
  readonly kind: string
  /** Where it lives — an external URL, or the stored object's key. */
  readonly location: string
  readonly externalUrl: string | null
  readonly recordedAt: string
  /**
   * `undefined` while the object is still retained. Present means the object is gone and the row
   * is the record that it existed — a gap that reads as retention rather than as loss (SC-012).
   */
  readonly expired: string | undefined
}

/**
 * Shape the artifact list (FR-014, SC-012).
 *
 * An expired artifact stays listed with the date it expired. Dropping it would make the record of
 * a finished run look like a run that produced nothing.
 *
 * @param items - The artifacts as `workflow.artifacts` returned them.
 * @param now - The page's clock, used only to decide whether an expiry is in the past. Before the
 *   browser has one, nothing is reported as expired — which errs toward saying less rather than
 *   toward claiming an object is gone when it may not be.
 */
export const toArtifactReadouts = (
  items: readonly ArtifactItem[],
  now: number | undefined,
): readonly ArtifactReadouts[] =>
  items.map((artifact) => ({
    id: artifact.id,
    kind: artifact.kind.replace(/_/g, ' '),
    location: artifact.externalUrl ?? artifact.s3Key ?? ABSENT,
    externalUrl: artifact.externalUrl,
    recordedAt: formatTimestamp(artifact.createdAt),
    expired:
      artifact.expiresAt !== null && now !== undefined && artifact.expiresAt.getTime() <= now
        ? formatTimestamp(artifact.expiresAt)
        : undefined,
  }))
