import { TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'

import { workflows } from '../../db'
import type { ReportReviewerSummaryInput } from '../../schemas'

import type { MachineContext } from './guard'
import { firstRow, loadMachineWorkflow } from './guard'

/**
 * `machine.reportReviewerSummary` — what the run wants the reviewer of its change to know
 * (FR-153).
 *
 * ## Where the summary goes, and why that is a column rather than an artifact
 *
 * `workflows.reviewer_summary` is a modelled column. Until this procedure was mounted the executor
 * delivered the same text through `registerArtifact({ kind: 'report' })`, which put the body in
 * object storage behind a key and left the column null — so the panel could not render the summary
 * beside the run without fetching an object, and the summary expired with the bucket's retention
 * policy while the run record did not. The adapter that did that
 * (`apps/sisyphus-executor/src/report/summary.ts` → `createArtifactSummarySink`) is written behind
 * a `ReviewerSummarySink` port for exactly this swap.
 *
 * ## Scoping
 *
 * The payload is a single string. There is no id in it, so there is no vector for a cross-workflow
 * write to travel on: the `where` below names `ctx.workflowId`, which came from the credential, and
 * there is no code path that takes a workflow id from the caller. That is why this module has no
 * `recordDenial` call — a denial that can never fire is not a check, it is a comment that compiles.
 * The one refusal that *can* happen is a run that no longer exists, and `loadMachineWorkflow`
 * answers that with `NOT_FOUND`.
 *
 * ## Retry safety
 *
 * The executor retries with backoff whenever this surface is unreachable and cannot tell a lost
 * response from a failed write (FR-047). A repeat of the identical summary writes nothing and
 * reports `recorded: false`, so a retry is observably a no-op rather than a second write of the
 * same bytes. A *different* summary replaces the stored one and says so — a run that refines its
 * summary is reporting, not racing, and keeping the first would leave the reviewer with the
 * draft.
 *
 * Deliberately **not** refused against a terminal run. The summary is published near the end of a
 * run, so a retry can easily land after `reportTerminal`; refusing it would trap the executor in a
 * retry loop over a run that has finished, and would lose the one artefact FR-153 exists for.
 */

/** What `reportReviewerSummary` answers with. */
export interface ReviewerSummaryReport {
  readonly workflowId: string
  readonly recordedAt: Date
  /**
   * `false` when the stored summary already matched, so nothing was written. A retry is not an
   * error and must not read as one.
   */
  readonly recorded: boolean
  /** `true` when a different summary was already on the run and has been superseded. */
  readonly replaced: boolean
}

/**
 * Record the reviewer summary against the credential's workflow.
 *
 * @param ctx - The machine resolver context.
 * @param input - The validated `reportReviewerSummary` payload.
 */
export const reportReviewerSummary = async (
  ctx: MachineContext,
  input: ReportReviewerSummaryInput,
): Promise<ReviewerSummaryReport> => {
  const workflow = await loadMachineWorkflow(ctx)
  const recordedAt = new Date()
  const existing = workflow.reviewerSummary

  if (existing === input.summary) {
    return { workflowId: workflow.id, recordedAt, recorded: false, replaced: false }
  }

  const updated = firstRow(
    await ctx.db
      .update(workflows)
      .set({ reviewerSummary: input.summary })
      .where(eq(workflows.id, ctx.workflowId))
      .returning({ id: workflows.id }),
  )

  if (updated === undefined) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'The reviewer summary could not be recorded.',
    })
  }

  return {
    workflowId: updated.id,
    recordedAt,
    recorded: true,
    replaced: existing !== null,
  }
}
