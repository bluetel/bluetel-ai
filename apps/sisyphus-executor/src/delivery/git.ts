/**
 * The read-only git seam the delivery path is built on (T069, T070, FR-079).
 *
 * ## Why this is an allow-list and not a convention
 *
 * FR-079 says staleness is **recorded**, and whether to rebase is decided by
 * the repository's skills rather than by Sisyphus. That is easy to agree with
 * and easy to erode: the code that has just discovered a branch is forty
 * commits behind is exactly the code most tempted to fix it, and a helpful
 * auto-rebase would look like an improvement in review. It is not an
 * improvement, it is a defect — it takes a decision that belongs to the
 * client's repository and makes it silently, on their branch, in a process
 * they are not watching.
 *
 * So the delivery path is given a git port that **cannot** do it. Every
 * command goes through {@link createGuardedGitRunner}, which refuses any
 * subcommand outside {@link READ_ONLY_GIT_COMMANDS} and names the offender.
 * There is no expression in this directory that rebases, merges, resets or
 * pushes, because there is no runner that would carry one.
 *
 * ## The one command here that writes anything
 *
 * `fetch`. It updates remote-tracking refs and the object store, which is what
 * makes "how far behind is this branch" answerable at all. It cannot advance a
 * local branch, move `HEAD`, touch the index, or modify a single file in the
 * working tree — those are `pull`, `merge`, `reset` and `checkout`, all of
 * which are on the forbidden list. `git.test.ts` proves the distinction against
 * a real repository rather than asserting it.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface GitCommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export interface GitCommand {
  readonly args: readonly string[]
  readonly cwd: string
}

export type GitRunner = (command: GitCommand) => Promise<GitCommandResult>

/**
 * Everything the delivery path is allowed to run.
 *
 * Each entry either reads local state, asks a remote a question without
 * changing anything (`ls-remote`), or populates the object store (`fetch`).
 * None of them can change what a branch points at or what is on disk.
 */
export const READ_ONLY_GIT_COMMANDS = [
  'cat-file',
  'fetch',
  'ls-remote',
  'merge-base',
  'rev-list',
  'rev-parse',
  'status',
  'symbolic-ref',
] as const

/**
 * Named explicitly, so the refusal message can say *why* rather than only
 * that the command is not on a list. This is documentation that executes.
 */
export const FORBIDDEN_GIT_COMMANDS = [
  'am',
  'apply',
  'branch',
  'checkout',
  'cherry-pick',
  'clean',
  'commit',
  'merge',
  'pull',
  'push',
  'rebase',
  'reset',
  'restore',
  'revert',
  'stash',
  'switch',
  'tag',
  'update-ref',
  'worktree',
] as const

export const mutatingGitCommandError = (subcommand: string): Error =>
  new Error(
    `git ${subcommand} is not available to the delivery path. Sisyphus records the state of a ` +
      'repository and never changes it; whether to rebase, merge or push is decided by the ' +
      "repository's own skills (FR-079).",
  )

/**
 * The subcommand, which must be the very first argument.
 *
 * Leading global flags are refused rather than skipped past. `git -c
 * core.hooksPath=… rebase` would otherwise arrive as something whose
 * subcommand needs parsing to find, and a guard that has to parse its input to
 * know what it is guarding is a guard with a bypass in it.
 */
const subcommandOf = (args: readonly string[]): string | undefined => {
  if (args.length === 0) {
    return undefined
  }

  const first = args[0]

  return first.startsWith('-') ? undefined : first
}

export const createGuardedGitRunner = (run: GitRunner): GitRunner => {
  const allowed = new Set<string>(READ_ONLY_GIT_COMMANDS)

  return async (command: GitCommand): Promise<GitCommandResult> => {
    const subcommand = subcommandOf(command.args)

    if (subcommand === undefined || !allowed.has(subcommand)) {
      throw mutatingGitCommandError(subcommand ?? '(none)')
    }

    return run(command)
  }
}

interface ExecFailure {
  readonly code?: number
  readonly stdout?: string
  readonly stderr?: string
}

const asExecFailure = (thrown: unknown): ExecFailure | undefined =>
  typeof thrown === 'object' && thrown !== null ? (thrown as ExecFailure) : undefined

/** Runs the real binary. Non-zero exits are returned, not thrown. */
export const createProcessGitRunner = (): GitRunner => async (command) => {
  try {
    const { stdout, stderr } = await execFileAsync('git', [...command.args], {
      cwd: command.cwd,
      encoding: 'utf8',
    })

    return { stdout, stderr, exitCode: 0 }
  } catch (thrown) {
    const failure = asExecFailure(thrown)

    return {
      stdout: failure?.stdout ?? '',
      stderr: failure?.stderr ?? String(thrown),
      exitCode: failure?.code ?? 1,
    }
  }
}

/**
 * The questions the delivery path asks. Every answer is a fact; none of them
 * is an action.
 */
export interface GitReader {
  /** The commit the working tree is on. */
  readonly headSha: () => Promise<string>
  /** Resolve a ref locally, or `undefined` if this repository has never seen it. */
  readonly resolveSha: (ref: string) => Promise<string | undefined>
  /**
   * The commit a remote currently has at a ref, asked of the remote directly.
   * Reads nothing local and writes nothing anywhere.
   */
  readonly remoteSha: (remote: string, ref: string) => Promise<string | undefined>
  /** Populate the object store so a distance can be measured. */
  readonly fetchRef: (remote: string, ref: string) => Promise<void>
  /**
   * Commits reachable from `to` but not from `from`, or `undefined` when the
   * objects are not present locally — an unmeasured distance is reported as
   * unmeasured rather than as zero.
   */
  readonly countCommitsBetween: (from: string, to: string) => Promise<number | undefined>
}

export interface GitReaderOptions {
  readonly cwd: string
  /** Defaults to the guarded process runner. */
  readonly run?: GitRunner
}

const firstLine = (text: string): string => text.split('\n')[0].trim()

export const createGitReader = (options: GitReaderOptions): GitReader => {
  const run = createGuardedGitRunner(options.run ?? createProcessGitRunner())
  const git = async (...args: readonly string[]): Promise<GitCommandResult> =>
    run({ args, cwd: options.cwd })

  return {
    headSha: async (): Promise<string> => {
      const result = await git('rev-parse', 'HEAD')

      if (result.exitCode !== 0) {
        throw new Error(`git rev-parse HEAD failed in ${options.cwd}: ${result.stderr.trim()}`)
      }

      return firstLine(result.stdout)
    },

    resolveSha: async (ref: string): Promise<string | undefined> => {
      const result = await git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`)

      return result.exitCode === 0 && result.stdout.trim() !== ''
        ? firstLine(result.stdout)
        : undefined
    },

    remoteSha: async (remote: string, ref: string): Promise<string | undefined> => {
      const result = await git('ls-remote', remote, ref)

      if (result.exitCode !== 0 || result.stdout.trim() === '') {
        return undefined
      }

      return firstLine(result.stdout).split(/\s+/)[0]
    },

    fetchRef: async (remote: string, ref: string): Promise<void> => {
      // `--no-tags` and one explicitly named ref keep this to the ref asked
      // for; nothing local is moved by either.
      await git('fetch', '--no-tags', '--quiet', remote, ref)
    },

    countCommitsBetween: async (from: string, to: string): Promise<number | undefined> => {
      const result = await git('rev-list', '--count', `${from}..${to}`)

      if (result.exitCode !== 0) {
        return undefined
      }

      const count = Number.parseInt(firstLine(result.stdout), 10)

      return Number.isNaN(count) ? undefined : count
    },
  }
}
