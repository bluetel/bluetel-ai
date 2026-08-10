/**
 * Throwaway git repositories for the delivery tests.
 *
 * The staleness and pushed-commit logic is only worth anything if it has been
 * run against real git, so the tests build real repositories — a bare one
 * standing in for the forge's remote, and a clone standing in for `/workspace`
 * — in a temporary directory, and talk to them over a filesystem path. Nothing
 * here touches a network, and nothing here touches the repository this code
 * lives in.
 *
 * The helper deliberately uses its own unguarded runner. `createGitReader`'s
 * allow-list exists to stop the *delivery path* mutating a client's
 * repository; a fixture that has to produce a commit to detect obviously
 * cannot be built through it.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { gitFixtureEnvironment } from '../git-fixture-environment'

const execFileAsync = promisify(execFile)

/** A committer identity, so `git commit` works on a machine with no global config. */
const IDENTITY = ['-c', 'user.email=executor@sisyphus.test', '-c', 'user.name=Sisyphus Test']

export interface TestRepository {
  /** Bare repository standing in for the forge's remote. */
  readonly remotePath: string
  /** Working clone standing in for a `/workspace` entry. */
  readonly clonePath: string
  /** Run git in a directory with no guard. Returns trimmed stdout. */
  readonly git: (cwd: string, ...args: readonly string[]) => Promise<string>
  /** Commit a file in the clone and return the new commit sha. */
  readonly commit: (message: string, file: string, contents: string) => Promise<string>
  /** Commit directly on the remote's default branch, as another engineer would. */
  readonly commitOnRemote: (message: string, file: string, contents: string) => Promise<string>
  readonly cleanup: () => Promise<void>
}

export interface TestRepositoryOptions {
  readonly defaultBranch?: string
}

export const createTestRepository = async (
  options: TestRepositoryOptions = {},
): Promise<TestRepository> => {
  const defaultBranch = options.defaultBranch ?? 'main'
  const root = await mkdtemp(join(tmpdir(), 'sisyphus-delivery-'))
  const remotePath = join(root, 'remote.git')
  const clonePath = join(root, 'clone')
  const seedPath = join(root, 'seed')

  const git = async (cwd: string, ...args: readonly string[]): Promise<string> => {
    const { stdout } = await execFileAsync('git', [...IDENTITY, ...args], {
      cwd,
      encoding: 'utf8',
      // The caller's environment minus anything naming the caller's repository. Without it this
      // helper inherits `process.env` wholesale, and under a git hook that includes `GIT_DIR` and
      // `GIT_INDEX_FILE` — at which point `git init --bare` and the commits below operate on the
      // repository the hook is running in rather than on `root`. See `../git-fixture-environment.ts`.
      env: gitFixtureEnvironment(),
    })

    return stdout.trim()
  }

  await git(root, 'init', '--bare', '--initial-branch', defaultBranch, remotePath)
  await git(root, 'clone', remotePath, seedPath)
  await writeFile(join(seedPath, 'README.md'), '# fixture\n', 'utf8')
  await git(seedPath, 'add', 'README.md')
  await git(seedPath, 'commit', '--no-gpg-sign', '-m', 'initial commit')
  await git(seedPath, 'push', 'origin', `HEAD:${defaultBranch}`)
  await git(root, 'clone', remotePath, clonePath)

  const commitIn = async (
    cwd: string,
    message: string,
    file: string,
    contents: string,
  ): Promise<string> => {
    await writeFile(join(cwd, file), contents, 'utf8')
    await git(cwd, 'add', file)
    await git(cwd, 'commit', '--no-gpg-sign', '-m', message)

    return git(cwd, 'rev-parse', 'HEAD')
  }

  return {
    remotePath,
    clonePath,
    git,
    commit: async (message, file, contents) => commitIn(clonePath, message, file, contents),
    commitOnRemote: async (message, file, contents) => {
      const sha = await commitIn(seedPath, message, file, contents)

      await git(seedPath, 'push', 'origin', `HEAD:${defaultBranch}`)

      return sha
    },
    cleanup: async () => rm(root, { recursive: true, force: true }),
  }
}
