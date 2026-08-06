import { TRPCError } from '@trpc/server'
import { and, eq } from 'drizzle-orm'

import type { Iteration, ReviewFinding } from '../../db'
import { iterations, reviewFindings } from '../../db'
import type { ReportIterationInput, ReviewFindingInput } from '../../schemas'
import { reportIterationInput } from '../../schemas'
import { machineProcedure } from '../procedures'

import type { MachineContext } from './guard'
import { firstRow, resolveOptionalEntry } from './guard'

/**
 * `machine.reportIteration` — one pass of the autonomous build-and-review loop (FR-061, FR-062,
 * FR-119).
 *
 * ## The three-iteration bound is a database constraint, not a loop counter
 *
 * FR-061 fixes a **hard maximum of three** development iterations. The tempting implementation is
 * a counter in the executor: it is right there, it is one comparison, and it is wrong for a reason
 * that only shows up in production. The executor is not the only thing that can start an
 * iteration, and it is not a single continuous process: a run is snapshotted and restored, an
 * instance is reclaimed and replaced, a report is retried after a lost response, and the control
 * plane can re-invoke a workflow it believes to be stalled. Every one of those is a path on which
 * an in-memory count is either lost or double-counted, and the failure mode is a fourth iteration
 * spending real money against a ticket that has already failed review three times.
 *
 * So the bound lives where none of those paths can go around it:
 *
 * ```sql
 * CONSTRAINT "iterations_ordinal_bounds" CHECK ("iterations"."ordinal" between 1 and 3)
 * ```
 *
 * — declared on the table in `src/db/schema/supervision.ts` and present in
 * `0000_initial_schema.sql`. A fourth iteration is not refused because this file remembered to
 * check; it is refused because the row cannot exist. `reportIterationInput` also caps `ordinal` at
 * three, and the two are not redundant: the schema turns a fourth attempt into a readable
 * validation error at the edge, and the constraint is what makes the bound true for **every**
 * writer, including a future caller that does not go through this resolver at all.
 *
 * What this module adds is the translation. A raw `23514` reaching the executor as an opaque
 * database error would be retried — which is the one response that is certainly wrong, because a
 * fourth iteration will never be accepted however many times it is asked for. {@link
 * fourthIterationError} makes it a `BAD_REQUEST` naming the constraint and the bound, so the
 * caller stops rather than loops. `exhausted.ts` in the executor is the other half: it reaches
 * `needs_attention` with the history intact rather than asking for a fourth pass at all (FR-062).
 *
 * ## Scoping
 *
 * The iteration itself is written with `ctx.workflowId` and the payload carries no workflow id, so
 * there is nothing to compare and nothing to get wrong. The reachable surface is the
 * `workflowEntryId` on each **finding**: an entry id belonging to another run would anchor a
 * blocker to somebody else's repository. Each one goes through {@link resolveOptionalEntry}, so a
 * cross-workflow attempt is refused **and recorded** as a `cross_workflow_write` security event
 * (FR-018, SC-014), exactly as it is on `reportEntryResult`. Findings are resolved **before**
 * anything is written, so a payload with one bad anchor records no iteration at all rather than
 * half of one.
 *
 * ## Retry safety, and why the first verdict wins
 *
 * `iterations_ordinal_key` is unique on `(workflow_id, ordinal)`, so the second report of the same
 * pass is a conflict rather than a second row. FR-047 has the executor retrying whenever this
 * surface is unreachable, so that second report is ordinary rather than suspicious — it answers
 * `recorded: false` with the iteration that is already there, the same shape and for the same
 * reason as `reportTerminal` and `reportEntryResult`. Letting a retry overwrite the verdict would
 * make FR-062's "surface the unresolved review findings" unstable after the fact, and raising
 * would put the executor into a retry loop over a write that already succeeded.
 */

/** The audit path recorded against a cross-workflow finding anchor. */
export const REPORT_ITERATION_PATH = 'machine.reportIteration'

/** FR-061's hard maximum, as the check constraint states it. */
export const ITERATION_ORDINAL_BOUND = 3

/** The constraint that holds the bound. Named in the refusal so a reader can find it. */
export const ITERATION_ORDINAL_CONSTRAINT = 'iterations_ordinal_bounds'

/** Postgres `check_violation`. */
const CHECK_VIOLATION = '23514'

/** What `reportIteration` answers with. */
export interface IterationReport {
  readonly iteration: Iteration
  /** Every finding recorded against this pass, anchored to entry, file and line (FR-119). */
  readonly findings: readonly ReviewFinding[]
  /**
   * `false` when this pass was already recorded and the **first** verdict was kept. Answered
   * successfully, because a retry that failed here would never stop retrying.
   */
  readonly recorded: boolean
}

/**
 * The refusal for a fourth pass (FR-061).
 *
 * `BAD_REQUEST` rather than a passed-through database error, because the difference matters to the
 * caller: a transient failure is worth retrying and this is not. It names the bound and the
 * constraint so the answer to "why did it stop at three?" is in the message rather than in a
 * migration file.
 */
export const fourthIterationError = (ordinal: number): TRPCError =>
  new TRPCError({
    code: 'BAD_REQUEST',
    message:
      `Iteration ${String(ordinal)} cannot be recorded: an autonomous run is bounded at ` +
      `${String(ITERATION_ORDINAL_BOUND)} development iterations (FR-061), and the bound is the ` +
      `${ITERATION_ORDINAL_CONSTRAINT} check constraint rather than a count anything can lose ` +
      'track of. A run that has used all three stops for human attention with its history intact.',
  })

/**
 * Whether this error is the ordinal bound refusing a row.
 *
 * The chain is walked rather than the top error inspected, because Drizzle wraps the driver's
 * error in a `Failed query:` error of its own and the `23514` lives on the `cause`. The message is
 * accepted as well as the structured fields: the driver's exact property names are not part of any
 * contract this package holds, and a bound that silently stopped being recognised — surfacing as a
 * retryable `INTERNAL_SERVER_ERROR` on the one write that will never succeed — is a worse failure
 * than being slightly generous about how the violation is spelled.
 */
const isCheckViolation = (thrown: unknown, constraint: string): boolean => {
  let current: unknown = thrown

  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    const record = current as Record<string, unknown>
    const message = typeof record['message'] === 'string' ? record['message'] : ''

    if (
      (record['code'] === CHECK_VIOLATION || message.includes('check constraint')) &&
      (record['constraint_name'] === constraint || message.includes(constraint))
    ) {
      return true
    }

    current = record['cause']
  }

  return false
}

const findingsOf = async (
  ctx: MachineContext,
  iterationId: string,
): Promise<readonly ReviewFinding[]> =>
  ctx.db.select().from(reviewFindings).where(eq(reviewFindings.iterationId, iterationId))

/**
 * Resolve every finding's entry anchor against the credential's own run.
 *
 * Done up front and in full: a payload naming one entry from another workflow must record nothing
 * at all, because a half-recorded iteration is a verdict whose findings do not add up.
 */
const resolveAnchors = async (
  ctx: MachineContext,
  findings: readonly ReviewFindingInput[],
): Promise<readonly (string | null)[]> => {
  const anchors: (string | null)[] = []

  for (const finding of findings) {
    anchors.push(await resolveOptionalEntry(ctx, finding.workflowEntryId, REPORT_ITERATION_PATH))
  }

  return anchors
}

/**
 * Record one iteration of the autonomous loop against the credential's workflow.
 *
 * @param ctx - The machine resolver context.
 * @param input - The validated `reportIteration` payload.
 * @returns The iteration, its findings, and whether this call was the one that wrote them.
 * @throws {TRPCError} `BAD_REQUEST` when a fourth pass is attempted; `FORBIDDEN` when a finding
 *   anchors to another workflow's entry.
 */
export const reportIteration = async (
  ctx: MachineContext,
  input: ReportIterationInput,
): Promise<IterationReport> => {
  const anchors = await resolveAnchors(ctx, input.findings)

  try {
    return await ctx.db.transaction(async (tx) => {
      const inserted = firstRow(
        await tx
          .insert(iterations)
          .values({
            workflowId: ctx.workflowId,
            ordinal: input.ordinal,
            reviewVerdict: input.verdict,
            endedAt: new Date(),
          })
          .onConflictDoNothing({ target: [iterations.workflowId, iterations.ordinal] })
          .returning(),
      )

      if (inserted === undefined) {
        // The pass is already on record. First verdict wins; this is a retry, not a correction.
        const already = firstRow(
          await tx
            .select()
            .from(iterations)
            .where(
              and(eq(iterations.workflowId, ctx.workflowId), eq(iterations.ordinal, input.ordinal)),
            )
            .limit(1),
        )

        if (already === undefined) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'The iteration could not be recorded.',
          })
        }

        const kept = await tx
          .select()
          .from(reviewFindings)
          .where(eq(reviewFindings.iterationId, already.id))

        return { iteration: already, findings: kept, recorded: false }
      }

      if (input.findings.length === 0) {
        return { iteration: inserted, findings: [], recorded: true }
      }

      const written = await tx
        .insert(reviewFindings)
        .values(
          input.findings.map((finding, index) => ({
            iterationId: inserted.id,
            workflowEntryId: anchors[index] ?? null,
            filePath: finding.filePath ?? null,
            line: finding.line ?? null,
            severity: finding.severity,
            summary: finding.summary,
          })),
        )
        .returning()

      return { iteration: inserted, findings: written, recorded: true }
    })
  } catch (cause) {
    if (isCheckViolation(cause, ITERATION_ORDINAL_CONSTRAINT)) {
      throw fourthIterationError(input.ordinal)
    }

    throw cause
  }
}

/**
 * Every pass this run has recorded, oldest first.
 *
 * FR-062 requires an exhausted run to surface its **unresolved** findings, which is a question
 * about the whole history rather than about the last pass — a blocker raised in iteration one and
 * never resolved is exactly what a human needs to see. Scoped to `ctx.workflowId` like every other
 * read on this surface.
 *
 * @param ctx - The machine resolver context.
 */
export const iterationHistory = async (
  ctx: MachineContext,
): Promise<readonly IterationReport[]> => {
  const passes = await ctx.db
    .select()
    .from(iterations)
    .where(eq(iterations.workflowId, ctx.workflowId))
    .orderBy(iterations.ordinal)

  const history: IterationReport[] = []

  for (const pass of passes) {
    history.push({ iteration: pass, findings: await findingsOf(ctx, pass.id), recorded: true })
  }

  return history
}

/**
 * `machine.reportIteration` — ready to mount beside the other machine procedures.
 *
 * Exported rather than assembled in `router.ts` for the same reason the supervision procedures are:
 * the input schema, the resolver and the `machineProcedure` base belong together, and a router that
 * re-declares the schema is a second place for it to drift.
 */
export const reportIterationProcedure = machineProcedure.input(reportIterationInput).mutation(
  async ({ ctx, input }): Promise<IterationReport> =>
    reportIteration(
      {
        db: ctx.db,
        workflowId: ctx.workflowId,
        credential: ctx.credential,
        dependencies: ctx.dependencies,
      },
      input,
    ),
)

export type { Iteration, ReviewFinding }
