import { TRPCError } from '@trpc/server'
import type { SQL } from 'drizzle-orm'
import { and, eq, isNull } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'

import type { SkillReference } from '../../db'
import { skillReferences, workflows } from '../../db'
import type { ReportSkillReferenceInput } from '../../schemas'
import { reportSkillReferenceInput } from '../../schemas'
import { machineProcedure } from '../procedures'

import type { MachineContext } from './guard'
import { firstRow, resolveOptionalEntry } from './guard'

/**
 * `machine.reportSkillReference` — which convention a run was actually given, and which version of
 * it (T179, FR-058, FR-059, SC-016).
 *
 * ## What was missing, and why the read could never have worked
 *
 * `workflow.skillReferences` (`../workflow/skills.ts`) has been reading the `skill_references`
 * table against live Postgres since T134. Nothing wrote to it. The executor computed the digests —
 * `apps/sisyphus-executor/src/skills/resolve.ts` calls its `report(...)` callback on every
 * resolution and on every halt — and the callback was bound to a function that discarded them, for
 * the plain reason that there was no procedure here to bind it to. So the panel's answer to "why
 * did this run behave that way" was an empty list, and an empty list is indistinguishable from a
 * run that resolved nothing. This is the write half.
 *
 * ## The digest is the version, so the report is a claim about a moment
 *
 * Skills are repository files with no version number. `contentDigest` is the sha256 of the bytes as
 * they were read, and it is the only thing that survives the file being edited afterwards — which
 * it will be, long before anybody asks. Nothing here recomputes it, consults a repository, or
 * validates it against a "current" digest: doing so would answer what the skill says *now* while
 * looking like it had answered what the run was told.
 *
 * ## An absence is a recording, not a missing row
 *
 * FR-058 halts a run whose skill is absent, unreadable or self-contradictory **and** records the
 * absence. That is why every field except `skillName` is optional: a halt reports
 * `unavailableReason` with no path and no digest, and that row is as much a fact about the run as a
 * successful resolution. Refusing it would lose the explanation at exactly the moment it is needed.
 *
 * ## Scoping
 *
 * The row is written with `ctx.workflowId`, which came from the credential. The one field that can
 * name something outside this run is `entryId` — a `workflow_entries` id — and it goes through
 * {@link resolveOptionalEntry}, so a cross-workflow attempt is refused **and recorded** as a
 * `cross_workflow_write` security event (FR-018, SC-014), exactly as on `reportIteration`.
 *
 * ## Retry safety, without a unique index
 *
 * FR-047 has the executor retrying whenever this surface is unreachable, and it cannot tell a lost
 * response from a failed write. `skill_references` carries no unique constraint to conflict on, and
 * must not grow one: a run legitimately resolves the same skill in several phases, and a file that
 * changed mid-run legitimately produces a second digest for the same skill and phase. Both are
 * facts, and a unique index would erase one of them.
 *
 * So the rule is **identical means retry**: a report matching an existing row on every field writes
 * nothing and answers `recorded: false`. Anything that differs — a new phase, a new digest, an
 * absence after a resolution — is a new fact and gets its own row. The comparison and the insert
 * run in one transaction behind a `for update` lock on the **workflow** row, because with no unique
 * index the run itself is the only thing available to serialise on; two retries overtaking each
 * other would otherwise both see no match and both write.
 */

/** The audit path recorded against a cross-workflow skill reference. */
export const REPORT_SKILL_REFERENCE_PATH = 'machine.reportSkillReference'

/** What `reportSkillReference` answers with. */
export interface SkillReferenceReport {
  readonly reference: SkillReference
  /**
   * `false` when an identical reference was already on record, so nothing was written. A retry is
   * ordinary rather than an error, and must not read as one (FR-047).
   */
  readonly recorded: boolean
}

/**
 * Match a nullable column against an optional payload field.
 *
 * `eq(column, undefined)` is not a null check, and an absent field means "this run recorded no
 * value here" — which is a value the comparison has to be able to express, or every halt report
 * would look like a new fact and duplicate on every retry.
 */
const matches = (column: PgColumn, value: string | null | undefined): SQL =>
  value === undefined || value === null ? isNull(column) : eq(column, value)

/**
 * Record one skill resolution — or one recorded absence — against the credential's workflow.
 *
 * @param ctx - The machine resolver context.
 * @param input - The validated `reportSkillReference` payload.
 * @returns The row, and whether this call was the one that wrote it.
 * @throws {TRPCError} `FORBIDDEN` when `entryId` names another workflow's entry; `NOT_FOUND` when
 *   the run itself no longer exists.
 */
export const reportSkillReference = async (
  ctx: MachineContext,
  input: ReportSkillReferenceInput,
): Promise<SkillReferenceReport> => {
  const entryId = await resolveOptionalEntry(ctx, input.entryId, REPORT_SKILL_REFERENCE_PATH)

  return ctx.db.transaction(async (tx) => {
    // Locked before the table is read, so a retry overtaking its original cannot have both see no
    // matching row and both insert. There is no unique index here to fall back on — see above.
    const run = firstRow(
      await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(eq(workflows.id, ctx.workflowId))
        .for('update'),
    )

    if (run === undefined) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'This workflow no longer exists.' })
    }

    const already = firstRow(
      await tx
        .select()
        .from(skillReferences)
        .where(
          and(
            eq(skillReferences.workflowId, ctx.workflowId),
            eq(skillReferences.skillName, input.skillName),
            matches(skillReferences.entryId, entryId),
            matches(skillReferences.resolvedPath, input.resolvedPath),
            matches(skillReferences.contentDigest, input.contentDigest),
            matches(skillReferences.phase, input.phase),
            matches(skillReferences.unavailableReason, input.unavailableReason),
          ),
        )
        .limit(1),
    )

    if (already !== undefined) {
      return { reference: already, recorded: false }
    }

    const inserted = firstRow(
      await tx
        .insert(skillReferences)
        .values({
          workflowId: ctx.workflowId,
          skillName: input.skillName,
          entryId,
          resolvedPath: input.resolvedPath ?? null,
          contentDigest: input.contentDigest ?? null,
          phase: input.phase ?? null,
          unavailableReason: input.unavailableReason ?? null,
        })
        .returning(),
    )

    if (inserted === undefined) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'The skill reference could not be recorded.',
      })
    }

    return { reference: inserted, recorded: true }
  })
}

/**
 * `machine.reportSkillReference` — ready to mount beside the other machine procedures.
 *
 * Exported rather than assembled in `router.ts` for the same reason `reportIterationProcedure` is:
 * the input schema, the resolver and the `machineProcedure` base belong together, and a router that
 * re-declares the schema is a second place for it to drift.
 */
export const reportSkillReferenceProcedure = machineProcedure
  .input(reportSkillReferenceInput)
  .mutation(
    async ({ ctx, input }): Promise<SkillReferenceReport> =>
      reportSkillReference(
        {
          db: ctx.db,
          workflowId: ctx.workflowId,
          credential: ctx.credential,
          dependencies: ctx.dependencies,
        },
        input,
      ),
  )

export type { SkillReference }
