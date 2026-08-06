import { TRPCError } from '@trpc/server'
import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'

import type { WorkflowEntry } from '../../db'
import { workflowEntries } from '../../db'
import type { TerminalOutcome } from '../../enums'
import { nonEmptyText, uuidInput } from '../../schemas'

import type { MachineContext } from './guard'
import { firstRow, requireEntryInWorkflow } from './guard'

/**
 * The two halves of per-entry reporting that `./entry-results.ts` does not cover (T104, FR-114,
 * FR-118).
 *
 * `reportEntryResult` is finished and mounted, and it is the *end* of an entry's life: what the run
 * did to one repository, written once, scoped to the credential's own workflow, first result wins.
 * Read it before reading this — nothing here duplicates it.
 *
 * What it cannot cover is the two clauses either side of it.
 *
 * ## FR-114 says **at checkout time**, and that is a different moment
 *
 * "A workflow MUST record the resolved commit of every entry at checkout time." `reportEntryResult`
 * carries a `resolvedCommit`, but it is called after delivery — so a run that provisions, checks
 * out three repositories and then dies in its first agent turn records **no commit for any of
 * them**. The workspace version pins a branch, not a commit; branches move; and the question
 * afterwards is always "what was this actually run against?". Recording it hours later, only on the
 * happy path, answers that question exactly when it does not need asking.
 *
 * So {@link reportEntryCheckout} exists, and it is called by bootstrap phase 6 as each entry lands
 * (`apps/sisyphus-executor/src/bootstrap/workspace.ts`), before the agent starts. It follows the
 * same first-write-wins rule as everything else on this surface, for the same reason: FR-047 has
 * the executor retrying whenever this surface is unreachable, and a retry that rewrote the recorded
 * commit would make the record it exists to provide unreliable in precisely the case — a flaky
 * network — where nobody is watching.
 *
 * It does not try to stop `reportEntryResult` restating the commit later. The two agree — both name
 * what the entry's base branch resolved to — and a checkout report that locked the column against
 * the procedure that already owns it would be this module reaching into another's write. What this
 * one guarantees is that the column is **not empty** for a run that never reached delivery.
 *
 * ## FR-118 says the terminal outcome must **state** the partial result
 *
 * "Where changes land for some entries and fail for others, the workflow MUST record a per-entry
 * result and MUST reach a terminal outcome that states the partial state. It MUST NOT report plain
 * success." `reportEntryResult` does the first clause. The second is about a *different row* — the
 * workflow's — and nothing was reading across the entries to decide it, so an executor that landed
 * two repositories of three and reported `succeeded` would have been believed.
 *
 * {@link summariseEntryResults} is that read, and {@link honestTerminalOutcome} is the rule applied
 * to it. Both are deliberately pure and separate from `reportTerminal`: the aggregate is a fact
 * about the entries, the substitution is a policy about outcomes, and a test that can construct the
 * awkward combinations directly — one landed and one pending, all failed, nothing reported at all —
 * is worth more than one that has to seed three repositories to reach each of them.
 *
 * An entry with **no** result at terminal time is treated exactly like a failed one for this
 * purpose. It is the more common shape and the more misleading: the run stopped before it got to
 * that repository, so there is no failure recorded anywhere, and "no news" must not read as "fine".
 */

/** The audit path recorded against a cross-workflow checkout report. */
export const REPORT_ENTRY_CHECKOUT_PATH = 'machine.reportEntryCheckout'

/**
 * What bootstrap phase 6 reports per entry (FR-114).
 *
 * No `entryResult`: an entry that has been checked out has no outcome yet, and a payload able to
 * carry one would let the checkout report pre-empt `reportEntryResult` — two procedures writing the
 * same column under different rules is how the first-result-wins guarantee stops being one.
 */
export const reportEntryCheckoutInput = z.object({
  entryId: uuidInput,
  /** What the entry's declared branch resolved to, at the moment it was cloned. */
  resolvedCommit: nonEmptyText,
  /**
   * The FR-079 assessment for this entry, if it was made at checkout. Optional and never cleared:
   * absent means "not assessed", which must not overwrite an assessment recorded elsewhere.
   */
  stalenessNote: nonEmptyText.optional(),
})

export type ReportEntryCheckoutInput = z.infer<typeof reportEntryCheckoutInput>

/** What `reportEntryCheckout` answers with. */
export interface EntryCheckoutReport {
  readonly entry: WorkflowEntry
  /**
   * `false` when the entry already carried a resolved commit and the **first** one was kept.
   * Answered successfully, because a retry that failed here would never stop retrying (FR-047).
   */
  readonly recorded: boolean
}

/**
 * Record one entry's resolved commit, at checkout time.
 *
 * @param ctx - The machine resolver context.
 * @param input - The validated `reportEntryCheckout` payload.
 */
export const reportEntryCheckout = async (
  ctx: MachineContext,
  input: ReportEntryCheckoutInput,
): Promise<EntryCheckoutReport> => {
  const entryId = await requireEntryInWorkflow(ctx, input.entryId, REPORT_ENTRY_CHECKOUT_PATH)

  return ctx.db.transaction(async (tx) => {
    // Locked before it is read, so a retry overtaking its original cannot have both see an
    // unrecorded entry and both write.
    const locked = firstRow(
      await tx.select().from(workflowEntries).where(eq(workflowEntries.id, entryId)).for('update'),
    )

    if (locked === undefined) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'This workspace entry no longer exists.' })
    }

    if (locked.resolvedCommit !== null) {
      return { entry: locked, recorded: false }
    }

    const updated = firstRow(
      await tx
        .update(workflowEntries)
        .set({
          resolvedCommit: input.resolvedCommit,
          ...(input.stalenessNote === undefined ? {} : { stalenessNote: input.stalenessNote }),
        })
        .where(eq(workflowEntries.id, entryId))
        .returning(),
    )

    if (updated === undefined) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'The entry checkout could not be recorded.',
      })
    }

    return { entry: updated, recorded: true }
  })
}

/** How one entry stands, for the purposes of the workflow's outcome. */
export interface EntryStanding {
  readonly entryId: string
  readonly repositoryUrl: string
  /** `unchanged`, `landed`, `failed`, or `pending` where nothing was reported. */
  readonly standing: 'unchanged' | 'landed' | 'failed' | 'pending'
}

/** What the entries of one run add up to (FR-118). */
export interface EntryResultSummary {
  readonly entries: readonly EntryStanding[]
  readonly landed: number
  readonly unchanged: number
  readonly failed: number
  /** Entries the run never reported on at all. Counted against success, not ignored. */
  readonly pending: number
  /** Something landed and something did not — the state FR-118 requires stating. */
  readonly isPartial: boolean
  /** Whether `succeeded` would be a lie. True for a partial result and for a total failure. */
  readonly forbidsPlainSuccess: boolean
  /** One line naming every repository and what happened to it, for the outcome reason. */
  readonly statement: string
}

const standingOf = (entry: WorkflowEntry): EntryStanding['standing'] =>
  entry.entryResult ?? 'pending'

/**
 * Read what the entries say, as one aggregate.
 *
 * @param entries - Every `workflow_entries` row of one run.
 */
export const summariseEntryResults = (entries: readonly WorkflowEntry[]): EntryResultSummary => {
  const standings = entries.map(
    (entry): EntryStanding => ({
      entryId: entry.id,
      repositoryUrl: entry.repositoryUrl,
      standing: standingOf(entry),
    }),
  )

  const count = (standing: EntryStanding['standing']): number =>
    standings.filter((entry) => entry.standing === standing).length

  const landed = count('landed')
  const unchanged = count('unchanged')
  const failed = count('failed')
  const pending = count('pending')
  const shortfall = failed + pending

  return {
    entries: standings,
    landed,
    unchanged,
    failed,
    pending,
    // `unchanged` is a completed entry, not a shortfall: a repository the work did not need to
    // touch has not failed, and counting it as partial would make every single-sided change in a
    // multi-repository workspace read as half-done.
    isPartial: landed > 0 && shortfall > 0,
    forbidsPlainSuccess: shortfall > 0,
    statement: standings
      .map(({ repositoryUrl, standing }) => `${repositoryUrl}: ${standing}`)
      .join('; '),
  }
}

/** Every entry of the credential's own run, oldest first. */
export const loadEntryStandings = async (ctx: MachineContext): Promise<EntryResultSummary> =>
  summariseEntryResults(
    await ctx.db
      .select()
      .from(workflowEntries)
      .where(eq(workflowEntries.workflowId, ctx.workflowId))
      .orderBy(asc(workflowEntries.createdAt)),
  )

/** The outcome that must be recorded, and whether it differs from the one asked for. */
export interface HonestTerminalOutcome {
  readonly outcome: TerminalOutcome
  /** `true` when plain success was refused and something truthful was put in its place. */
  readonly substituted: boolean
  /** Why, naming every repository. Empty when nothing was substituted. */
  readonly reason: string
}

/**
 * Apply FR-118 to a requested terminal outcome.
 *
 * `needs_attention` is the substitute, and it is the only defensible one. `failed` would erase two
 * repositories of real, landed, reviewable work; `succeeded` is the thing forbidden; and there is
 * no outcome in FR-064's closed set that means "partly". What is actually true of a run that landed
 * some of its repositories and not others is that **a human has to look at it**, which is what
 * `needs_attention` says and what FR-118 is protecting.
 *
 * Only `succeeded` is ever substituted. An executor reporting `failed`, `capped` or `cancelled` has
 * already said something that is not plain success, and overriding it would replace a specific,
 * true statement with a vaguer one.
 *
 * @param summary - What the entries add up to.
 * @param requested - The outcome the executor asked to record.
 */
export const honestTerminalOutcome = (
  summary: EntryResultSummary,
  requested: TerminalOutcome,
): HonestTerminalOutcome => {
  if (requested !== 'succeeded' || !summary.forbidsPlainSuccess) {
    return { outcome: requested, substituted: false, reason: '' }
  }

  const shortfall = summary.failed + summary.pending

  return {
    outcome: 'needs_attention',
    substituted: true,
    reason:
      `${String(summary.landed)} of ${String(summary.entries.length)} repositories landed and ` +
      `${String(shortfall)} did not, so this run is not a plain success (FR-118). ${summary.statement}`,
  }
}
