import { TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'

import type { WorkflowEntry } from '../../db'
import { workflowEntries } from '../../db'
import type { ReportEntryResultInput } from '../../schemas'

import type { MachineContext } from './guard'
import { firstRow, requireEntryInWorkflow } from './guard'

/**
 * `machine.reportEntryResult` — the per-repository outcome of a multi-repo run (FR-114, FR-115,
 * FR-118).
 *
 * ## Why this is per entry and not per workflow
 *
 * A run over three repositories can leave one landed, one unchanged and one failed, and FR-118
 * requires the workflow's terminal outcome to state that partial result rather than call it plain
 * success. That is only expressible if each entry carries its own verdict, its own resolved commit
 * and its own pull request — which is what this procedure writes and `reportTerminal` later reads
 * across.
 *
 * ## Scoping — the whole of the check is `entryId`
 *
 * This is one of only three payloads on the machine surface that can name a row outside the
 * credential's run, and the one where it matters most: an entry id belonging to another workflow
 * would file a landed result, and a pull request URL, against somebody else's repository record.
 * So `entryId` goes through {@link requireEntryInWorkflow}, which resolves the entry to its owning
 * workflow and hands the answer to `assertMachineWorkflowMatches` — the same recorder every other
 * cross-workflow refusal goes through, so the attempt is **recorded** as a `cross_workflow_write`
 * security event and not merely refused (FR-018, SC-014). An entry id matching no row is refused
 * identically, so this is not an oracle for enumerating entry ids.
 *
 * ## Retry safety, and why the first result wins
 *
 * FR-047 has the executor retrying whenever this surface is unreachable, so a repeat call is
 * ordinary. The entry row is locked and read first; if it already carries an `entry_result`, the
 * first one is **kept** and the call answers `recorded: false` rather than raising — the same
 * shape `reportTerminal` uses, and for the same reason. Letting a later report flip a landed entry
 * to failed would make FR-118's aggregate unstable after the fact, and refusing outright would put
 * the executor into a retry loop over a write that already succeeded.
 *
 * FR-115 allows at most one pull request per entry, and that falls out of the same rule: the URL
 * is written with the first result and never overwritten.
 *
 * ## Staleness travels with the result
 *
 * `stalenessNote` writes `workflow_entries.staleness_note` — the FR-079 assessment of whether this
 * entry's base branch advanced during the run. It arrives here rather than on its own procedure
 * because it is a fact about the same entry, discovered at the same moment, and a second call
 * would be a second thing to retry and a second chance for an entry to end up with a result and no
 * assessment.
 *
 * It follows the first-result-wins rule for the same reason everything else here does: a retry
 * must not be able to rewrite the assessment the first report recorded. An omitted note leaves the
 * column alone rather than clearing it, so a caller that reports a result without having assessed
 * staleness cannot erase an assessment recorded some other way.
 */

/** The audit path recorded against a cross-workflow entry-result report. */
export const REPORT_ENTRY_RESULT_PATH = 'machine.reportEntryResult'

/** What `reportEntryResult` answers with. */
export interface EntryResultReport {
  readonly entry: WorkflowEntry
  /**
   * `false` when the entry already carried a result and the **first** one was kept. Answered
   * successfully, because a retry that failed here would never stop retrying.
   */
  readonly recorded: boolean
}

/**
 * Record one entry's outcome against the credential's workflow.
 *
 * @param ctx - The machine resolver context.
 * @param input - The validated `reportEntryResult` payload.
 */
export const reportEntryResult = async (
  ctx: MachineContext,
  input: ReportEntryResultInput,
): Promise<EntryResultReport> => {
  const entryId = await requireEntryInWorkflow(ctx, input.entryId, REPORT_ENTRY_RESULT_PATH)

  return ctx.db.transaction(async (tx) => {
    // Locked before it is read, so two reports racing — a retry overtaking its original, or the
    // per-entry delivery step running twice — cannot both see an unrecorded entry and both write.
    const locked = firstRow(
      await tx.select().from(workflowEntries).where(eq(workflowEntries.id, entryId)).for('update'),
    )

    if (locked === undefined) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'This workspace entry no longer exists.' })
    }

    if (locked.entryResult !== null) {
      return { entry: locked, recorded: false }
    }

    const updated = firstRow(
      await tx
        .update(workflowEntries)
        .set({
          resolvedCommit: input.resolvedCommit,
          wasChanged: input.wasChanged,
          pullRequestUrl: input.pullRequestUrl ?? null,
          entryResult: input.entryResult,
          // Omitted means "not assessed", which must not overwrite an assessment already on the
          // row. `undefined` is how Drizzle expresses "leave this column alone"; `null` would
          // clear it.
          ...(input.stalenessNote === undefined ? {} : { stalenessNote: input.stalenessNote }),
        })
        .where(eq(workflowEntries.id, entryId))
        .returning(),
    )

    if (updated === undefined) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'The entry result could not be recorded.',
      })
    }

    return { entry: updated, recorded: true }
  })
}
