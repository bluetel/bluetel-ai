/**
 * Skill resolution — `sisyphus-dev`, `sisyphus-review`, `sisyphus-integration`
 * read from the primary workspace entry (T068).
 *
 * Consumers import from here and never from the module behind it. Note what is
 * deliberately **not** exported, because it does not exist: no default branch
 * convention, no fallback template, no substitute for a skill that could not be
 * read. A step that cannot resolve its skill halts (FR-058) — there is no
 * second-best value anywhere in this directory for it to reach for.
 */

export {
  haltForSkill,
  parseSkillDocument,
  primarySkillSource,
  resolveSkill,
  resolveSkills,
  skillCandidatePaths,
  skillDigest,
  SKILL_NAMES,
  SKILL_SEARCH_PATHS,
  SkillResolutionError,
} from './resolve'
export type {
  ResolvedSkill,
  ResolvedSkillSet,
  ResolveSkillOptions,
  SkillFailureKind,
  SkillName,
  SkillReferenceReport,
  SkillReferenceReporter,
  SkillSource,
} from './resolve'
