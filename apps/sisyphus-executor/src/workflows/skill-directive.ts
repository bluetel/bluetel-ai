/**
 * The record that a convention this run is about to act on came from a skill (T123, FR-057,
 * FR-058, FR-059).
 *
 * FR-057 is the requirement most easily broken by a helpful default. Every module in this
 * directory is one `??` away from being wrong in a way nothing catches: a fallback base branch, a
 * pull request template with a heading Sisyphus invented, a "sensible" ticket state to move to
 * when the skill did not say. None of those fails a test, none of them throws, and each of them
 * quietly applies one client's habits to another client's repository.
 *
 * So the convention-bearing values in this directory do not travel as bare strings. They travel
 * attached to a {@link SkillDirective}, which names the skill that stated them, the step that
 * needed them, and the **content digest** of the file as it was actually read (FR-059). Three
 * consequences, and the third is the one that matters:
 *
 * 1. A value with no directive cannot be constructed, so "where did this branch name come from?"
 *    always has an answer.
 * 2. The digest travels with the action, so a run stays explicable after the skills change.
 * 3. **There is no way to make one up.** {@link directiveFrom} takes a {@link ResolvedSkill} —
 *    which only `src/skills` can produce, and only by reading a real file off the primary entry.
 *    A module that wanted to invent a convention would have to invent a skill resolution first,
 *    and that is a conspicuous thing to write.
 */

import type { ResolvedSkill, SkillName } from '../skills'

/** A convention, and the skill that stated it. */
export interface SkillDirective {
  readonly skillName: SkillName
  /** The entry the skill was read from. Always the primary one (FR-110). */
  readonly entryId: string
  /** Relative to the entry checkout, so a reader can open the file. */
  readonly resolvedPath: string
  /** The file's only version (FR-059). */
  readonly contentDigest: string
  /** The workflow step that needed it, named in any halt (FR-058). */
  readonly step: string
  /**
   * What the skill said to do, in the words the run acted on. Free text on purpose: the platform
   * has no vocabulary for a client's branch rules or ticket states, and inventing one would be
   * the hardcoding FR-057 forbids wearing a type's clothes.
   */
  readonly instruction: string
}

/**
 * Attach a resolved skill to the convention it stated.
 *
 * @param skill - The skill as `resolveSkill` actually read it.
 * @param options - The step being taken and what the skill said to do.
 */
export const directiveFrom = (
  skill: ResolvedSkill,
  options: { readonly step: string; readonly instruction: string },
): SkillDirective => ({
  skillName: skill.skillName,
  entryId: skill.entryId,
  resolvedPath: skill.resolvedPath,
  contentDigest: skill.contentDigest,
  step: options.step,
  instruction: options.instruction,
})

/**
 * The halt for an action nothing prescribed.
 *
 * Carries no suggested value, in keeping with `SkillResolutionError`: there is nothing on this
 * error a caller could mistake for a usable default.
 */
export const undirectedActionError = (action: string, step: string): Error =>
  new Error(
    `The ${step} step will not ${action}: no skill prescribed it. Sisyphus holds no convention ` +
      'of its own for branches, pull request content or ticket states (FR-057), so the workflow ' +
      'stops here rather than choosing one.',
  )

/**
 * Insist an action was prescribed before it is taken.
 *
 * @param directive - What the run believes it was told to do, possibly nothing.
 * @param action - The action, phrased to follow "will not" in the halt.
 * @param step - The workflow step, named per FR-058.
 * @throws When there is no directive, or when the directive states nothing.
 */
export const requireDirective = (
  directive: SkillDirective | undefined,
  action: string,
  step: string,
): SkillDirective => {
  if (directive === undefined || directive.instruction.trim() === '') {
    throw undirectedActionError(action, step)
  }

  return directive
}

/** The digests a run acted on, oldest first — what makes a past run explicable (FR-059). */
export const directiveDigests = (
  directives: readonly SkillDirective[],
): readonly { readonly skillName: SkillName; readonly contentDigest: string }[] =>
  directives.map((directive) => ({
    skillName: directive.skillName,
    contentDigest: directive.contentDigest,
  }))
