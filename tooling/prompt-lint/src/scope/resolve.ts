/**
 * Assemble the `Scope`: what to evaluate, what the whole picture is, and the one path
 * index every rule shares.
 *
 * `targets` versus `universe` is the model's most consequential distinction, and it is
 * what makes US1 §4 work. Deleting a referenced file puts nothing in `targets` for the
 * artifact that *refers* to it — but that artifact is in `universe`, and
 * `refs/dangling-path` widens to `universe` when the diff deletes anything. Stated as
 * one rule: **per-artifact rules run over `targets`; set-scoped rules run over
 * `universe`.**
 */
import { loadArtifact, type Artifact } from '../artifact'

import { classify, skillRootOf } from './classify'
import { listAllFiles, listChangedFiles, listStagedFiles, type GitResult } from './git'
import { isDeclaredArtifact, matchesGlob, type ScopeSubset } from './patterns'

export type ScopeMode = 'diff' | 'staged' | 'all'

/**
 * Does a repo-relative path exist? Built once from the tracked file list, so it is the
 * only filesystem view a rule gets (research R2) and two runs over one tree agree.
 *
 * "Exists" means "is tracked by git". A rule's finding is a claim about this
 * repository's content, and an untracked scratch file is not that.
 */
export interface PathIndex {
  has: (path: string) => boolean
  isDirectory: (path: string) => boolean
  /** Tracked paths under a directory prefix, for the set-scoped `install/*` rules. */
  under: (prefix: string) => string[]
}

export interface Exclusion {
  path: string
  reason: string
}

export interface Scope {
  mode: ScopeMode
  /** Present for mode 'diff'. */
  baseRef?: string
  targets: Artifact[]
  universe: Artifact[]
  index: PathIndex
  exclusions: Exclusion[]
  /** Paths the comparison deleted. Empty under `--all`, which compares nothing. */
  deleted: string[]
}

export interface ResolveOptions {
  repoRoot: string
  mode: ScopeMode
  baseRef?: string
  subset?: ScopeSubset
  /** Globs never evaluated, each with a recorded reason (FR-005). */
  exclude: readonly { glob: string; reason: string }[]
}

/** Build the shared path index from the tracked file list. */
export const buildPathIndex = (trackedPaths: readonly string[]): PathIndex => {
  const files = new Set(trackedPaths)
  const directories = new Set<string>()

  for (const path of trackedPaths) {
    const segments = path.split('/')
    for (let depth = 1; depth < segments.length; depth += 1) {
      directories.add(segments.slice(0, depth).join('/'))
    }
  }

  const sorted = [...files].sort()

  return {
    has: (path) => files.has(path) || directories.has(path),
    isDirectory: (path) => directories.has(path),
    under: (prefix) => {
      const normalised = prefix.endsWith('/') ? prefix : `${prefix}/`
      return sorted.filter((path) => path.startsWith(normalised))
    },
  }
}

/** Load one declared path into an `Artifact`, classifying it on the way. */
const load = (repoRoot: string, path: string): Artifact =>
  loadArtifact(repoRoot, path, classify(path) ?? 'unclassified', skillRootOf(path))

/** Resolve the scope, or fail with the reason the scope could not be established. */
export const resolveScope = (options: ResolveOptions): GitResult<Scope> => {
  const { repoRoot, mode, baseRef, subset, exclude } = options

  const tracked = listAllFiles(repoRoot)
  if (!tracked.ok) return tracked

  const index = buildPathIndex(tracked.value)
  const declared = tracked.value.filter((path) => isDeclaredArtifact(path, subset))

  const exclusions: Exclusion[] = []
  const included: string[] = []
  for (const path of declared) {
    const rule = exclude.find((entry) => matchesGlob(entry.glob, path))
    if (rule) exclusions.push({ path, reason: rule.reason })
    else included.push(path)
  }

  const universe = included.map((path) => load(repoRoot, path))

  if (mode === 'all') {
    return {
      ok: true,
      value: { mode, targets: universe, universe, index, exclusions, deleted: [] },
    }
  }

  const comparison =
    mode === 'staged'
      ? listStagedFiles(repoRoot)
      : listChangedFiles(repoRoot, baseRef ?? 'origin/main')
  if (!comparison.ok) return comparison

  const changed = new Set(comparison.value.changed)
  return {
    ok: true,
    value: {
      mode,
      ...(mode === 'diff' ? { baseRef: baseRef ?? 'origin/main' } : {}),
      targets: universe.filter((artifact) => changed.has(artifact.path)),
      universe,
      index,
      exclusions,
      deleted: comparison.value.deleted,
    },
  }
}
