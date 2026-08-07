/**
 * Skill resolution from the primary workspace entry (T068).
 *
 * Every client- and repository-specific convention a run needs — branch naming,
 * target branches, PR content and readiness, ticket transitions, review rubric,
 * integration steps — is read from `sisyphus-dev`, `sisyphus-review` and
 * `sisyphus-integration` in the target repository, and none of it is hardcoded
 * anywhere in Sisyphus (FR-057).
 *
 * Two properties carry the weight, and both are about what this module refuses
 * to do.
 *
 * **It never guesses.** A missing, unreadable or self-contradictory skill halts
 * the workflow naming the skill and the step (FR-058). There is deliberately no
 * default branch prefix, no fallback PR template, no "sensible" ticket
 * transition anywhere in this file — not as a constant, not as an argument
 * default. An agent that invents a branch convention because the skill would
 * not parse does damage across a client's repository that is tedious to
 * unpick and, worse, looks deliberate. Halting is cheap; a wrong convention
 * applied confidently is not.
 *
 * **It records what it read.** Each resolution is reported with its content
 * digest (FR-059, SC-016). A repository file has no version other than its
 * content, so the digest is the only thing that makes a past run explicable
 * after the skills change — without it, "why did it branch like that?" has no
 * answer at all six weeks later.
 *
 * Skills come from the **primary** entry only and are never searched for in
 * other entries (FR-110). That is structural here: the resolver takes one
 * source, and {@link primarySkillSource} is the only way to derive one from a
 * workspace.
 */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { SKILL_NAMES } from '@bluetel-ai/sisyphus-api/client'

import type { ReadyWorkspace } from '../bootstrap'

export { SKILL_NAMES }

export type SkillName = (typeof SKILL_NAMES)[number]

/**
 * Where a skill is looked for beneath the entry, in order; the first hit wins.
 *
 * Both locations are real conventions rather than speculation: `.claude/skills`
 * is what the agent itself reads, and `.agents/skills` is where a repository
 * that shares skills between tools keeps the canonical copy. First-hit-wins
 * rather than "both must agree" precisely because the common arrangement is a
 * short `.claude` file pointing at the `.agents` one — treating that pair as a
 * contradiction would halt runs in repositories that are correctly set up.
 */
export const SKILL_SEARCH_PATHS = [
  '.claude/skills/{skill}/SKILL.md',
  '.agents/skills/{skill}/SKILL.md',
] as const

export const skillCandidatePaths = (skillName: SkillName): readonly string[] =>
  SKILL_SEARCH_PATHS.map((pattern) => pattern.replace('{skill}', skillName))

/** Why a skill could not be used. Each halts the run; none has a fallback. */
export type SkillFailureKind = 'missing' | 'unreadable' | 'contradictory'

/**
 * The halt (FR-058).
 *
 * It names the skill and the step because those are the two things an operator
 * needs to fix it, and it carries no suggested value of any kind: there is
 * nothing on this error a caller could mistake for a usable default.
 */
export class SkillResolutionError extends Error {
  readonly skillName: SkillName
  /** The workflow step that needed it — `develop`, `review`, `integrate`. */
  readonly step: string
  readonly kind: SkillFailureKind
  readonly reason: string
  readonly entryId: string
  /** Everywhere that was looked, so a fix does not need a guess either. */
  readonly searched: readonly string[]

  constructor(options: {
    readonly skillName: SkillName
    readonly step: string
    readonly kind: SkillFailureKind
    readonly reason: string
    readonly entryId: string
    readonly searched?: readonly string[]
  }) {
    super(
      `workflow halted at step "${options.step}": the ${options.skillName} skill is ` +
        `${options.kind} — ${options.reason}. No branch, ticket or delivery action is taken ` +
        'on a guess (FR-058); resolve the skill in the primary repository and re-run.',
    )
    this.name = 'SkillResolutionError'
    this.skillName = options.skillName
    this.step = options.step
    this.kind = options.kind
    this.reason = options.reason
    this.entryId = options.entryId
    this.searched = options.searched ?? []
  }
}

/** One skill, as it was actually read. */
export interface ResolvedSkill {
  readonly skillName: SkillName
  readonly entryId: string
  /** Relative to the entry checkout, which is what a reader can act on. */
  readonly resolvedPath: string
  readonly absolutePath: string
  /** Lower-case hex sha256 of the file's bytes — its only version (FR-059). */
  readonly contentDigest: string
  readonly byteSize: number
  /** The skill text below the front matter. The agent reads this, not us. */
  readonly body: string
}

/** Mirrors `reportSkillReference` on the machine surface. */
export interface SkillReferenceReport {
  readonly skillName: SkillName
  readonly entryId?: string
  readonly resolvedPath?: string
  readonly contentDigest?: string
  readonly phase?: string
  readonly unavailableReason?: string
}

export type SkillReferenceReporter = (report: SkillReferenceReport) => void | Promise<void>

/** The entry a skill may be read from. There is only ever one (FR-110). */
export interface SkillSource {
  readonly entryId: string
  /** Absolute path to the entry's checkout. */
  readonly path: string
}

/**
 * The only sanctioned way to get a {@link SkillSource} from a workspace.
 *
 * It reads `workspace.primary` and never touches `workspace.entries`, so
 * "resolved from the primary entry only" is a property of the code path rather
 * than a rule someone has to apply.
 */
export const primarySkillSource = (workspace: ReadyWorkspace): SkillSource => ({
  entryId: workspace.primary.entryId,
  path: workspace.primary.path,
})

export interface ResolveSkillOptions {
  readonly source: SkillSource
  /** The workflow step that needs it; it appears in the halt (FR-058). */
  readonly step: string
  readonly report: SkillReferenceReporter
}

export const skillDigest = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')

interface SkillDocument {
  readonly declaredName?: string
  readonly body: string
}

const FRONT_MATTER_FENCE = '---'

/**
 * Split YAML front matter from the body.
 *
 * Only the `name` key is read, and only to catch a file that says it is a
 * different skill. Nothing else in the front matter is interpreted: the skill's
 * meaning is its prose, and a resolver that started parsing conventions out of
 * metadata would be the hardcoding FR-057 forbids.
 */
export const parseSkillDocument = (text: string): SkillDocument => {
  const lines = text.split('\n')

  if (lines[0]?.trim() !== FRONT_MATTER_FENCE) {
    return { body: text.trim() }
  }

  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === FRONT_MATTER_FENCE)

  if (closing === -1) {
    return { body: text.trim() }
  }

  const nameLine = lines
    .slice(1, closing)
    .find((line) => line.trimStart().toLowerCase().startsWith('name:'))
  const declaredName = nameLine
    ?.slice(nameLine.indexOf(':') + 1)
    .trim()
    .replace(/^["']|["']$/gu, '')

  return {
    ...(declaredName === undefined || declaredName === '' ? {} : { declaredName }),
    body: lines
      .slice(closing + 1)
      .join('\n')
      .trim(),
  }
}

interface Candidate {
  readonly relativePath: string
  readonly absolutePath: string
}

const firstExistingCandidate = async (
  source: SkillSource,
  skillName: SkillName,
): Promise<Candidate | undefined> => {
  for (const relativePath of skillCandidatePaths(skillName)) {
    const absolutePath = join(source.path, relativePath)
    const entry = await stat(absolutePath).catch(() => undefined)

    if (entry?.isFile() === true) {
      return { relativePath, absolutePath }
    }
  }

  return undefined
}

/**
 * Resolve one skill, report it, or halt.
 *
 * Reporting happens on both paths and **before** the throw: a run that halted
 * because a skill was unreadable is only explicable if the attempt was recorded
 * (FR-059). A halt that leaves no trace of what it was looking for is a halt
 * someone has to reproduce to understand.
 */
export const resolveSkill = async (
  skillName: SkillName,
  options: ResolveSkillOptions,
): Promise<ResolvedSkill> => {
  const { source, step } = options
  const searched = skillCandidatePaths(skillName)

  const halt = async (kind: SkillFailureKind, reason: string): Promise<never> => {
    const error = new SkillResolutionError({
      skillName,
      step,
      kind,
      reason,
      entryId: source.entryId,
      searched,
    })

    await options.report({
      skillName,
      entryId: source.entryId,
      phase: step,
      unavailableReason: `${kind}: ${reason}`,
    })

    throw error
  }

  const candidate = await firstExistingCandidate(source, skillName)

  if (candidate === undefined) {
    return halt(
      'missing',
      `no skill file was found in the primary entry (looked at ${searched.join(', ')})`,
    )
  }

  const bytes = await readFile(candidate.absolutePath).catch((cause: unknown) => cause)

  if (!(bytes instanceof Uint8Array)) {
    return halt(
      'unreadable',
      `${candidate.relativePath} exists but could not be read (${
        bytes instanceof Error ? bytes.message : String(bytes)
      })`,
    )
  }

  const document = parseSkillDocument(new TextDecoder().decode(bytes))

  if (document.body === '') {
    return halt(
      'unreadable',
      `${candidate.relativePath} has no content below its front matter, so it states no convention`,
    )
  }

  // A file that declares itself to be a different skill contradicts the
  // location it was found in. Which of the two to believe is exactly the kind
  // of guess FR-058 forbids.
  if (document.declaredName !== undefined && document.declaredName !== skillName) {
    return halt(
      'contradictory',
      `${candidate.relativePath} declares itself to be "${document.declaredName}", ` +
        `but it was resolved as ${skillName}`,
    )
  }

  const resolved: ResolvedSkill = {
    skillName,
    entryId: source.entryId,
    resolvedPath: candidate.relativePath,
    absolutePath: candidate.absolutePath,
    contentDigest: skillDigest(bytes),
    byteSize: bytes.byteLength,
    body: document.body,
  }

  await options.report({
    skillName,
    entryId: resolved.entryId,
    resolvedPath: resolved.resolvedPath,
    contentDigest: resolved.contentDigest,
    phase: step,
  })

  return resolved
}

export type ResolvedSkillSet = ReadonlyMap<SkillName, ResolvedSkill>

/**
 * Resolve several skills, halting on the first that cannot be used.
 *
 * Sequential and fail-fast: the skills that follow a missing one are not worth
 * reading, and a report listing three failures where the run stopped at the
 * first is a report that describes something that did not happen.
 */
export const resolveSkills = async (
  skillNames: readonly SkillName[],
  options: ResolveSkillOptions,
): Promise<ResolvedSkillSet> => {
  const resolved = new Map<SkillName, ResolvedSkill>()

  for (const skillName of skillNames) {
    resolved.set(skillName, await resolveSkill(skillName, options))
  }

  return resolved
}

/**
 * Halt on a contradiction discovered while *using* a skill.
 *
 * Structural contradictions — a file declaring a different name, a file with no
 * content — are caught above. A skill whose prose says two incompatible things
 * about a branch convention can only be found by the step that tries to follow
 * it, and that step must halt the same way rather than picking whichever
 * instruction it read last. This is the seam that lets it, so there is no
 * reason for a caller to invent its own error and no route to a quiet default.
 */
export const haltForSkill = async (
  skillName: SkillName,
  options: ResolveSkillOptions & { readonly reason: string; readonly resolvedPath?: string },
): Promise<never> => {
  await options.report({
    skillName,
    entryId: options.source.entryId,
    ...(options.resolvedPath === undefined ? {} : { resolvedPath: options.resolvedPath }),
    phase: options.step,
    unavailableReason: `contradictory: ${options.reason}`,
  })

  throw new SkillResolutionError({
    skillName,
    step: options.step,
    kind: 'contradictory',
    reason: options.reason,
    entryId: options.source.entryId,
  })
}
