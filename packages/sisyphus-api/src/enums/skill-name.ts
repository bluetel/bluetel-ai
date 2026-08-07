import { createEnumGuard } from './enum-guard'

/**
 * The skills a run may resolve.
 *
 * Recorded with the content digest of whatever was actually loaded, so a past run stays explicable
 * after the skill itself has moved on (FR-059). A closed set rather than free text because an
 * unresolvable skill has to be reportable as a *named* absence.
 */
export const SKILL_NAMES = ['sisyphus-dev', 'sisyphus-review', 'sisyphus-integration'] as const

export type SkillName = (typeof SKILL_NAMES)[number]

export const isSkillName = createEnumGuard(SKILL_NAMES)
