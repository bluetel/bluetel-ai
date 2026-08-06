import { asc, eq } from 'drizzle-orm'

import type { SkillReference } from '../../db'
import { skillReferences } from '../../db'
import { workflowIdInput } from '../../schemas'
import { scopedProcedure } from '../procedures'
import type { ScopedReadOptions } from '../scope'
import { requireWorkflowInScope } from '../scope'

/**
 * **What a past run was actually told to do (T134, FR-059, FR-058, SC-016).**
 *
 * ## The digest is the version
 *
 * Skills are repository files. They carry no version number, no tag and no release: a skill is
 * whatever `sisyphus-dev/SKILL.md` says on the day it is read. So "which version of the convention
 * did this run follow" has exactly one answer that survives the file being edited — the hash of the
 * content that was actually resolved, recorded on the run at the moment it was read
 * (`machine.reportSkillReference`, data-model.md → `skill_references`).
 *
 * That is what makes this read different from every other one on the router. The rest of the panel
 * reads state that is still true. This reads a **claim about the past** which the present will
 * contradict: by the time anybody asks why a run behaved as it did, the skill has almost certainly
 * changed, and the question is only answerable because the run kept its own copy of the version. So
 * nothing here consults a repository, a file, or a "current" digest. Doing so would answer a
 * different question — what the skill says *now* — while looking like it had answered this one.
 *
 * Two runs weeks apart therefore report different digests for the same skill name, and both are
 * correct. `skills.test.ts` asserts exactly that, because it is the whole of FR-059.
 *
 * ## An absence is a recording, not a missing row
 *
 * FR-058 halts a run whose skill is absent, unreadable or self-contradictory — **and** records the
 * absence, with a null `resolvedPath` and a stated reason. A row that simply did not exist would be
 * indistinguishable from a run that predates the skill, so {@link readSkillReferences} returns the
 * absences alongside the resolutions and {@link summariseSkillReferences} counts them separately.
 * "This run was never given the review skill" and "this run has no record either way" are different
 * facts and the panel must be able to tell them apart.
 *
 * ## Scoping
 *
 * Through `requireWorkflowInScope`, like every other id-taking read (FR-190). `skill_references`
 * has no scope predicate of its own and must not grow one: it is reached **through** the parent
 * workflow, so an out-of-scope id and a nonexistent id leave here as the same `NOT_FOUND` with the
 * same message. A skill reference is a fact about a run, and confirming the fact would confirm the
 * run.
 */

/** One recorded skill resolution, as the panel reads it. */
export interface SkillReferenceReadout {
  readonly id: string
  readonly skillName: SkillReference['skillName']
  /** The workspace entry it was resolved from. Null for a run-wide resolution (FR-110). */
  readonly entryId: string | null
  /** Where it was found. Null when it could not be resolved at all (FR-058). */
  readonly resolvedPath: string | null
  /**
   * sha256 of the content as read. **The version**, and the only one a repository file has — never
   * recomputed from the file as it stands today.
   */
  readonly contentDigest: string | null
  /** Which part of the run resolved it. */
  readonly phase: string | null
  /** Why it could not be used, when it could not. The recorded half of FR-058. */
  readonly unavailableReason: string | null
  readonly recordedAt: Date
}

/** Whether this reference records a skill the run actually got. */
export const isResolvedSkill = (
  reference: Pick<SkillReferenceReadout, 'contentDigest' | 'resolvedPath'>,
): boolean => reference.resolvedPath !== null && reference.contentDigest !== null

/**
 * A resolution recorded **without** the digest that pins its version.
 *
 * The one shape FR-059 cannot tolerate: the run says it read a skill from a path, and the only
 * thing that would let anybody say *which* version it read is missing. Distinct from an absence,
 * which is a recorded fact with a stated reason (FR-058) and leaves the run perfectly explicable.
 */
const lacksRecordedVersion = (reference: SkillReferenceReadout): boolean =>
  reference.resolvedPath !== null && reference.contentDigest === null

/**
 * What the run's skill record adds up to.
 *
 * `explicable` is the FR-059 question stated as a boolean: does every skill this run says it read
 * carry the digest that pins which version it read? A run with an *unresolved* skill is still
 * explicable — the absence is itself the explanation, and FR-058 halted it naming the skill — so
 * the unavailable ones are listed rather than folded into the flag. What breaks the flag is a
 * resolution recorded without a digest, because that is the one case where nothing anybody can read
 * afterwards says what the run was told.
 */
export interface SkillReferenceSummary {
  readonly references: readonly SkillReferenceReadout[]
  readonly resolvedCount: number
  /** The skills that could not be resolved, named. Empty for a run that got everything it needed. */
  readonly unavailableSkills: readonly SkillReference['skillName'][]
  /** True when every recorded resolution carries the digest that pins its version. */
  readonly explicable: boolean
}

/**
 * Read the skills one run resolved, oldest first.
 *
 * Ordered by `recordedAt` then id, because the sequence is a narrative — which skill the run
 * consulted first tells a reader how it proceeded — and because ties on a coarse timestamp must
 * still come out in a stable order.
 *
 * @param options - The handle, the resolved scope, and the run.
 * @returns Every recorded reference, resolutions and absences alike.
 */
export const readSkillReferences = async (
  options: ScopedReadOptions & { readonly workflowId: string },
): Promise<readonly SkillReferenceReadout[]> => {
  const workflow = await requireWorkflowInScope(options)

  return options.db
    .select({
      id: skillReferences.id,
      skillName: skillReferences.skillName,
      entryId: skillReferences.entryId,
      resolvedPath: skillReferences.resolvedPath,
      contentDigest: skillReferences.contentDigest,
      phase: skillReferences.phase,
      unavailableReason: skillReferences.unavailableReason,
      recordedAt: skillReferences.recordedAt,
    })
    .from(skillReferences)
    .where(eq(skillReferences.workflowId, workflow.id))
    .orderBy(asc(skillReferences.recordedAt), asc(skillReferences.id))
}

/**
 * Reduce a run's references to the answer the detail view puts on screen.
 *
 * Pure, and separate from the read, so the classification can be checked against a table of
 * inputs rather than only through a database.
 *
 * @param references - As {@link readSkillReferences} returned them.
 */
export const summariseSkillReferences = (
  references: readonly SkillReferenceReadout[],
): SkillReferenceSummary => {
  const resolved = references.filter((reference) => isResolvedSkill(reference))

  return {
    references,
    resolvedCount: resolved.length,
    unavailableSkills: references
      .filter((reference) => !isResolvedSkill(reference))
      .map((reference) => reference.skillName),
    // Vacuously true for a run with no record at all, and deliberately: the flag reports whether
    // anything recorded is missing its version, not whether the run recorded anything.
    explicable: !references.some((reference) => lacksRecordedVersion(reference)),
  }
}

/**
 * `workflow.skillReferences` — why a past run did what it did (FR-059, SC-016).
 *
 * `scopedProcedure`, so a run the caller may not see answers `NOT_FOUND` rather than with an empty
 * list: an empty list would say the run exists and resolved nothing.
 */
export const skillReferencesProcedure = scopedProcedure
  .input(workflowIdInput)
  .query(
    async ({ ctx, input }): Promise<SkillReferenceSummary> =>
      summariseSkillReferences(
        await readSkillReferences({ db: ctx.db, scope: ctx.scope, workflowId: input.workflowId }),
      ),
  )
