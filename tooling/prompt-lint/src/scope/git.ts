/**
 * The only code in the tree that touches `git`.
 *
 * Every failure here is **typed and carries the ref name**, because the failure this
 * whole contract most needs to prevent is a shallow checkout silently producing an
 * empty changed-file list and exiting 0 (US2 §5). An unresolvable base ref is exit
 * `4` — "the tool could not establish what to look at" — and is never an empty list.
 */
import { execFileSync } from 'node:child_process'
import process from 'node:process'

export interface GitFailure {
  kind: 'no-repo' | 'unresolvable-ref' | 'git-failed'
  /** The ref that could not be resolved, when the failure is about one. */
  ref?: string
  message: string
}

export type GitResult<T> = { ok: true; value: T } | { ok: false; failure: GitFailure }

export interface ChangedFiles {
  /** Paths present now that the comparison shows as added, modified or renamed-to. */
  changed: string[]
  /** Paths the comparison shows as deleted — what widens `refs/dangling-path` (T055). */
  deleted: string[]
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'unknown error'

/**
 * The environment every git call runs under, constructed explicitly rather than inherited.
 *
 * This is not tidiness. `prompt-lint` runs from `.husky/pre-commit` (FR-043), and git sets
 * `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE` for its hooks. Inheriting them makes
 * every call below resolve against the hook's index instead of `cwd`, so the gate reads a
 * different repository than the one it was pointed at — and an inherited variable that
 * changes the answer is an unrecorded input, which is what FR-029 forbids.
 */
const gitEnvironment = (): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith('GIT_')) continue
    environment[name] = value
  }
  return environment
}

/** Run git in `repoRoot` and return stdout, or throw. */
const git = (repoRoot: string, args: string[]): string =>
  execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: gitEnvironment(),
  })

/** Is `repoRoot` inside a git repository at all? */
export const isRepository = (repoRoot: string): boolean => {
  try {
    git(repoRoot, ['rev-parse', '--git-dir'])
    return true
  } catch {
    return false
  }
}

const noRepo = (repoRoot: string): GitFailure => ({
  kind: 'no-repo',
  message: `${repoRoot} is not a git repository, so there is no diff to scope to. Use --all to evaluate the whole declared set.`,
})

/** Split NUL- or newline-delimited git output into non-empty lines. */
const lines = (output: string): string[] => output.split('\n').filter((line) => line.length > 0)

/**
 * Parse `git diff --name-status`. A rename reports both sides: the old path counts as
 * deleted, because anything that referenced it is now dangling.
 */
export const parseNameStatus = (output: string): ChangedFiles => {
  const changed: string[] = []
  const deleted: string[] = []

  for (const line of lines(output)) {
    const fields = line.split('\t')
    const status = fields[0]
    if (status.startsWith('R') || status.startsWith('C')) {
      if (fields.length >= 3) {
        deleted.push(fields[1])
        changed.push(fields[2])
      }
      continue
    }
    if (fields.length < 2) continue
    if (status.startsWith('D')) deleted.push(fields[1])
    else changed.push(fields[1])
  }

  return { changed: changed.sort(), deleted: deleted.sort() }
}

/**
 * Every file in the working tree that git would consider part of the repository:
 * tracked, plus untracked-but-not-ignored.
 *
 * The untracked half is not a convenience. A contributor who adds a new skill reference
 * and runs the gate before `git add` is exactly the case the gate exists for, and a
 * tracked-only enumeration reports a clean pass over a file it never looked at. Ignored
 * files stay out, so build output is never an artifact.
 */
export const listAllFiles = (repoRoot: string): GitResult<string[]> => {
  if (!isRepository(repoRoot)) return { ok: false, failure: noRepo(repoRoot) }
  try {
    const tracked = lines(git(repoRoot, ['ls-files']))
    const untracked = lines(git(repoRoot, ['ls-files', '--others', '--exclude-standard']))
    return { ok: true, value: [...new Set([...tracked, ...untracked])].sort() }
  } catch (error) {
    return {
      ok: false,
      failure: { kind: 'git-failed', message: `git ls-files failed: ${messageOf(error)}` },
    }
  }
}

/** Untracked, non-ignored paths — new files the diff cannot see on its own. */
const listUntracked = (repoRoot: string): string[] => {
  try {
    return lines(git(repoRoot, ['ls-files', '--others', '--exclude-standard']))
  } catch {
    return []
  }
}

/**
 * What this branch changed relative to `baseRef`, including uncommitted work.
 *
 * Compared against the merge base rather than the ref's tip, so a base branch that has
 * moved on does not report its own commits as this branch's changes.
 */
export const listChangedFiles = (repoRoot: string, baseRef: string): GitResult<ChangedFiles> => {
  if (!isRepository(repoRoot)) return { ok: false, failure: noRepo(repoRoot) }

  let mergeBase: string
  try {
    git(repoRoot, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`])
  } catch {
    return {
      ok: false,
      failure: {
        kind: 'unresolvable-ref',
        ref: baseRef,
        message: `base ref '${baseRef}' could not be resolved. On a shallow checkout, fetch it first (git fetch --no-tags --depth=… origin ${baseRef}); this is reported rather than treated as "nothing changed".`,
      },
    }
  }
  try {
    mergeBase = git(repoRoot, ['merge-base', baseRef, 'HEAD']).trim()
  } catch {
    return {
      ok: false,
      failure: {
        kind: 'unresolvable-ref',
        ref: baseRef,
        message: `no merge base between HEAD and '${baseRef}'. A shallow checkout is the usual cause; deepen it rather than accepting an empty scope.`,
      },
    }
  }

  try {
    const diffed = parseNameStatus(
      git(repoRoot, ['diff', '--name-status', '--find-renames', mergeBase]),
    )
    // `git diff` cannot see an untracked file, so a newly written artifact would be
    // silently out of scope. Fold it in: it is unambiguously something this branch added.
    const changed = [...new Set([...diffed.changed, ...listUntracked(repoRoot)])].sort()
    return { ok: true, value: { changed, deleted: diffed.deleted } }
  } catch (error) {
    return {
      ok: false,
      failure: { kind: 'git-failed', message: `git diff failed: ${messageOf(error)}` },
    }
  }
}

/** The staged set — the pre-commit path (FR-043). */
export const listStagedFiles = (repoRoot: string): GitResult<ChangedFiles> => {
  if (!isRepository(repoRoot)) return { ok: false, failure: noRepo(repoRoot) }
  try {
    return {
      ok: true,
      value: parseNameStatus(
        git(repoRoot, ['diff', '--cached', '--name-status', '--find-renames']),
      ),
    }
  } catch (error) {
    return {
      ok: false,
      failure: { kind: 'git-failed', message: `git diff --cached failed: ${messageOf(error)}` },
    }
  }
}

/**
 * A file's content at the base of the comparison, or null when it did not exist there.
 * `install/version-bump` needs it to answer "did the content change while `version`
 * stayed put", which is a question about two revisions rather than about one file.
 */
export const fileAtRef = (repoRoot: string, ref: string, path: string): string | null => {
  try {
    return git(repoRoot, ['show', `${ref}:${path}`])
  } catch {
    return null
  }
}

/** The merge base of `baseRef` and HEAD, for the rules that compare two revisions. */
export const mergeBaseOf = (repoRoot: string, baseRef: string): string | null => {
  try {
    return git(repoRoot, ['merge-base', baseRef, 'HEAD']).trim()
  } catch {
    return null
  }
}
