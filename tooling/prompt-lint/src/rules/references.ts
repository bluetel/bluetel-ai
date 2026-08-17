/**
 * `refs/dangling-path` — the decision the whole feature's credibility rests on.
 *
 * The naive rule ("every path in backticks must exist relative to the repo root") was
 * measured first: **65 referenced paths, 40+ reported missing, exactly one a real
 * defect** (research R2). The noise was four kinds — artifact-relative paths,
 * runtime-created files, claims about a *target* project's tree, and variable-bearing
 * templates — and each one tells you something about the algorithm.
 *
 * A reference is reported only when all four hold:
 *
 *  1. It is **path-shaped** — it contains a `/`. A bare filename is never reported:
 *     there is no way to tell "the file next to the one you are writing" from "a file in
 *     this repo", and that class was pure noise.
 *  2. It carries **no variable syntax** — handled upstream by `PathToken.literal`.
 *  3. Its **first segment resolves to a real directory** in one of three roots, tried in
 *     order: the artifact's own directory, its skill root, then the repository root.
 *  4. Given a root whose first segment matched, the **full path does not exist** there.
 *
 * Rule 3 is what does the real work. It converts "I cannot find this file" into "you are
 * making a claim about a directory that exists, and the claim is false".
 *
 * **Rule 5 was added at implementation time, and research R2 needs it.** R2 lists
 * "runtime-created" as one of its four noise classes and gives
 * `.specify/extensions.yml` as the example — but rules 1–4 do not filter it, because
 * `.specify/` *is* a real directory, so every one of its stated rules holds. Implementing
 * the algorithm exactly as written produced **80 findings, 70 of them that one path**,
 * against R2's claim of one. Every instance is inside an explicit existence check
 * ("Check if `.specify/extensions.yml` exists", "if it does not exist, skip silently").
 *
 * A reference inside a sentence that asserts the file may be absent is not a claim that
 * it is present. The test is **lexical, not semantic** — the same category of mechanical
 * comparison `conventions/config-mismatch` is bounded to — and without it the rule ships
 * at an 80:1 noise ratio, which is exactly the ratio R2 rejected the naive rule for.
 */
import type { Artifact, PathToken } from '../artifact'
import type { ArtifactKind, PathIndex } from '../scope'

import { defineRule, requireArtifact, type FindingDraft } from './define'

/** Join path segments POSIX-style and collapse `.` / `..`, without touching the disk. */
const normalise = (base: string, reference: string): string => {
  const segments = base.length === 0 ? [] : base.split('/')
  for (const segment of reference.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return segments.join('/')
}

/** The directory an artifact sits in, repo-relative. Empty string at the repo root. */
const directoryOf = (path: string): string => {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

/**
 * The three roots a reference resolves against, in order. Deduplicated so an artifact at
 * its own skill root does not get checked twice.
 */
const rootsFor = (artifact: Artifact): string[] => {
  const roots = [directoryOf(artifact.path), artifact.skillRoot ?? '', '']
  return [...new Set(roots)]
}

interface Resolution {
  /** True when some root's first segment matched, so the reference is a claim about us. */
  claimed: boolean
  /** True when the full path exists under one of those roots. */
  exists: boolean
  /** The candidate path under the first root that claimed the reference, for the message. */
  candidate: string | null
}

/** Resolve a reference against the three roots. */
export const resolveReference = (
  artifact: Artifact,
  reference: string,
  index: PathIndex,
): Resolution => {
  const firstSegment = reference.split('/')[0]
  let claimed = false
  let candidate: string | null = null

  for (const root of rootsFor(artifact)) {
    // `..` walks out of the root before the first segment is meaningful, so let
    // normalisation decide what the claim is about.
    const anchor = firstSegment === '..' ? root : normalise(root, firstSegment)
    if (!index.isDirectory(anchor)) continue

    claimed = true
    const full = normalise(root, reference)
    if (index.has(full)) return { claimed: true, exists: true, candidate: full }
    candidate ??= full
  }

  return { claimed, exists: false, candidate }
}

/**
 * Rule 5: the line does not actually claim the path is there right now. Three lexical
 * shapes, each one of research R2's own noise classes that rules 1–4 fail to filter:
 *
 *  - **an existence check** — "Check if `.specify/extensions.yml` exists", "skip silently
 *    if it does not". 70 of the 80 findings on the first real run.
 *  - **the procedure creating it** — "Persist the resolved path to `.specify/feature.json`".
 *    A file the skill writes cannot be expected to exist before the skill has run.
 *  - **an illustration** — "for example, `specs/003-user-auth`", "e.g. in `.github/agents/`".
 *    An example of a value's *shape*, or an enumeration of where other agents keep their
 *    commands, is not a claim about this repository.
 *
 * Lexical, not semantic: it matches the words, the same bound `conventions/config-mismatch`
 * works under. The cost of the bound is a missed defect on a line that happens to contain
 * "for example"; the cost of not having it is an 80:1 noise ratio, and R2 rejected the
 * naive rule at 40:1.
 */
const NOT_A_PRESENT_TENSE_CLAIM =
  /\b(?:exists?|existence|absent|missing|optional|present|if there is|if any|when none|not found|skip silently|for example|for instance|such as|persists?|persisted|writes? (?:the|to)|creates?|created|generates?|generated|seeds?|seeded|saves? (?:the|to))\b|e\.g\./i

const assertsPossibleAbsence = (line: string): boolean => NOT_A_PRESENT_TENSE_CLAIM.test(line)

const APPLIES_TO: ArtifactKind[] = [
  'catalog-skill',
  'catalog-reference',
  'installed-skill',
  'agent-pointer',
  'guidance',
  'constitution',
]

/**
 * Is this token worth resolving at all? Everything rejected here is a reference to
 * somewhere else — a target project, a runtime tree, a template — rather than a broken
 * reference to something here.
 */
const isCandidate = (token: PathToken): boolean =>
  token.literal &&
  !token.inFence &&
  !token.inHtmlComment &&
  // Rule 1: path-shaped means it contains a separator.
  token.raw.includes('/') &&
  // A bare protocol or anchor is not a path claim about this repository.
  !token.raw.includes('://') &&
  !token.raw.startsWith('#')

export const danglingPath = defineRule(
  {
    id: 'refs/dangling-path',
    defaultSeverity: 'error',
    statement:
      'Every literal, path-shaped reference resolves against one of three roots: the artifact’s directory, its skill root, or the repository root.',
    rationale:
      'This is the defect class with the worst failure mode — the agent follows the instruction, cannot read the file, and continues without the content. Nothing errors; the procedure just silently loses a step.',
    appliesTo: APPLIES_TO,
    dimension: 'correctness',
    scope: 'artifact',
    needs: ['view'],
  },
  (input) => {
    const artifact = requireArtifact(input)
    const view = artifact.view
    if (view === null) return []

    const findings: FindingDraft[] = []
    const reported = new Set<string>()

    for (const token of view.pathTokens) {
      if (!isCandidate(token)) continue
      if (assertsPossibleAbsence(view.lines[token.line])) continue

      const { claimed, exists, candidate } = resolveReference(artifact, token.raw, input.index)
      // Rule 3: no root claimed it, so the reference is about somewhere else entirely and
      // is not this validator's business.
      if (!claimed || exists) continue

      const key = `${String(token.line)}:${token.raw}`
      if (reported.has(key)) continue
      reported.add(key)

      findings.push({
        line: token.line + 1,
        column: token.column,
        message: `References \`${token.raw}\`, which does not exist relative to this artifact, its skill root, or the repository root${candidate === null ? '' : ` (looked for \`${candidate}\`)`}.`,
        remediation:
          'Correct the path, create the file, or remove the reference. If it is created at runtime or lives in a target project, suppress it with a reason: `<!-- prompt-lint-disable-next-line refs/dangling-path — created by step 3 at runtime -->`.',
      })
    }

    return findings
  },
)
