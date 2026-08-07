import { TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'

import type { SisyphusDatabase, Workflow } from '../../db'
import { workflowEntries, workflows } from '../../db'
import type { TerminalOutcome, WorkflowState } from '../../enums'
import { TERMINAL_WORKFLOW_STATES } from '../../enums'
import type { MachineWriteContext } from '../procedures'
import { assertMachineWorkflowMatches } from '../procedures'

/**
 * The one place a machine-surface write decides what it is allowed to touch.
 *
 * `machineProcedure` has already established *which* workflow the credential covers and put it on
 * `ctx.workflowId`. What is left is the rule this module owns: **every write names that workflow
 * and nothing else** (FR-018, SC-014).
 *
 * ## Why that is not automatic
 *
 * None of the machine input schemas carries a `workflowId` — deliberately, because a payload that
 * named its own workflow would invite exactly the confusion FR-018 forbids. So the surface a
 * cross-workflow write can actually reach through is the **`entryId`** on
 * `reportBootstrapPhase` and `registerArtifact`: a `workflow_entries` id belonging to a different
 * run. That is the vector, so that is what {@link requireEntryInWorkflow} closes, and it closes it
 * by resolving the entry to its owning workflow and handing the answer to
 * `assertMachineWorkflowMatches` — the same recorder every other cross-workflow refusal goes
 * through, so the security event has one shape and one reason (`cross_workflow_write`).
 *
 * An `entryId` that matches **no** row is refused identically, and that is not laziness: telling
 * the caller "that entry does not exist" while telling them "that entry is not yours" for a real
 * one would make this procedure an oracle for enumerating entry ids.
 */

/** What a machine resolver needs: the credential's workflow, a handle, and the denial recorder. */
export type MachineContext = MachineWriteContext & { readonly db: SisyphusDatabase }

/**
 * The first row, honestly typed — `noUncheckedIndexedAccess` is off in this project, so `rows[0]`
 * is typed as present even when the result set is empty.
 */
export const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/**
 * The workflow the credential covers.
 *
 * `NOT_FOUND` if the row is gone — an executor still reporting against a deleted run is a
 * reconciliation problem, not an authorisation one, and it must not read as success.
 */
export const loadMachineWorkflow = async (ctx: MachineContext): Promise<Workflow> => {
  const rows = await ctx.db
    .select()
    .from(workflows)
    .where(eq(workflows.id, ctx.workflowId))
    .limit(1)

  const workflow = firstRow(rows)
  if (workflow === undefined) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'This workflow no longer exists.' })
  }
  return workflow
}

/** Whether a state is one no further work happens from without a human (FR-064). */
export const isTerminalState = (state: WorkflowState): state is TerminalOutcome =>
  (TERMINAL_WORKFLOW_STATES as readonly string[]).includes(state)

/**
 * Resolve a workspace entry, refusing one that belongs to another workflow.
 *
 * The refusal is `FORBIDDEN` — not the `NOT_FOUND` an out-of-scope *human* read gets — and the
 * two are not inconsistent. The executor already knows its own workflow exists, so there is
 * nothing to disclose; what matters here is that the attempt is recorded as a security event
 * (FR-018, SC-014), which `assertMachineWorkflowMatches` does before it throws.
 *
 * @param ctx - The machine resolver context.
 * @param entryId - The entry named in the payload.
 * @param path - Procedure path, for the audit record.
 */
export const requireEntryInWorkflow = async (
  ctx: MachineContext,
  entryId: string,
  path: string,
): Promise<string> => {
  const rows = await ctx.db
    .select({ workflowId: workflowEntries.workflowId })
    .from(workflowEntries)
    .where(eq(workflowEntries.id, entryId))
    .limit(1)

  const owning = firstRow(rows)?.workflowId
  // A missing entry is handed to the same assertion under a value that can never match, so it is
  // refused, recorded and worded identically to an entry belonging to somebody else.
  await assertMachineWorkflowMatches(ctx, owning ?? `unknown:${entryId}`, path)

  return entryId
}

/**
 * Resolve an optional `entryId`, or `null` when the payload named none.
 *
 * Convenience over {@link requireEntryInWorkflow} so no resolver writes its own `if (entryId !==
 * undefined)` — the branch that would eventually be forgotten is the one that skips the check.
 */
export const resolveOptionalEntry = async (
  ctx: MachineContext,
  entryId: string | undefined,
  path: string,
): Promise<string | null> =>
  entryId === undefined ? null : requireEntryInWorkflow(ctx, entryId, path)
