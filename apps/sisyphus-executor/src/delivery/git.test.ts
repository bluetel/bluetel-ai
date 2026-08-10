import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { stripAmbientGitEnvironment } from '../git-fixture-environment'

import type { GitCommand, GitRunner } from './git'
import {
  createGitReader,
  createGuardedGitRunner,
  createProcessGitRunner,
  FORBIDDEN_GIT_COMMANDS,
  READ_ONLY_GIT_COMMANDS,
} from './git'
import type { TestRepository } from './test-repository'
import { createTestRepository } from './test-repository'

/**
 * `createProcessGitRunner` is the **production** runner, and it spawns `git` with the environment
 * it was started in. The fixture below composes a clean one for its own calls, but the reader under
 * test cannot — so the ambient repository is removed from this process instead, or a run from
 * inside a git hook would have the reader answering about the hook's repository while the fixture
 * asserted about a temporary one. See `../git-fixture-environment.ts`.
 */
const restoreGitEnvironment = stripAmbientGitEnvironment()

afterAll(restoreGitEnvironment)

let repository: TestRepository | undefined

afterEach(async () => {
  await repository?.cleanup()
  repository = undefined
})

const recordingRunner = (): { readonly runner: GitRunner; readonly seen: GitCommand[] } => {
  const seen: GitCommand[] = []

  return {
    seen,
    runner: (command) => {
      seen.push(command)

      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
    },
  }
}

describe('createGuardedGitRunner', () => {
  it('permits every read-only command', async () => {
    const { runner, seen } = recordingRunner()
    const guarded = createGuardedGitRunner(runner)

    for (const subcommand of READ_ONLY_GIT_COMMANDS) {
      await guarded({ args: [subcommand], cwd: '/workspace' })
    }

    expect(seen).toHaveLength(READ_ONLY_GIT_COMMANDS.length)
  })

  it('refuses every command that could change a repository', async () => {
    const { runner, seen } = recordingRunner()
    const guarded = createGuardedGitRunner(runner)

    for (const subcommand of FORBIDDEN_GIT_COMMANDS) {
      await expect(guarded({ args: [subcommand], cwd: '/workspace' })).rejects.toThrow(
        `git ${subcommand} is not available to the delivery path`,
      )
    }

    expect(seen).toEqual([])
  })

  it('refuses a rebase in particular, which is FR-079’s named prohibition', async () => {
    const { runner } = recordingRunner()
    const guarded = createGuardedGitRunner(runner)

    await expect(guarded({ args: ['rebase', 'origin/main'], cwd: '/workspace' })).rejects.toThrow(
      /decided by the repository's own skills/,
    )
  })

  it('refuses a leading global flag rather than parsing past it', async () => {
    const { runner, seen } = recordingRunner()
    const guarded = createGuardedGitRunner(runner)

    await expect(
      guarded({ args: ['-c', 'core.hooksPath=/tmp/hooks', 'rev-parse', 'HEAD'], cwd: '/w' }),
    ).rejects.toThrow(/not available to the delivery path/)
    expect(seen).toEqual([])
  })

  it('refuses an empty command', async () => {
    const { runner } = recordingRunner()

    await expect(createGuardedGitRunner(runner)({ args: [], cwd: '/w' })).rejects.toThrow(
      'git (none) is not available',
    )
  })

  it('shares no command between the allowed and forbidden lists', () => {
    const allowed = new Set<string>(READ_ONLY_GIT_COMMANDS)

    expect(FORBIDDEN_GIT_COMMANDS.filter((command) => allowed.has(command))).toEqual([])
  })
})

describe('createProcessGitRunner', () => {
  it('returns a non-zero exit rather than throwing', async () => {
    repository = await createTestRepository()

    const result = await createProcessGitRunner()({
      args: ['rev-parse', '--verify', '--quiet', 'refs/heads/nope'],
      cwd: repository.clonePath,
    })

    expect(result.exitCode).not.toBe(0)
  })
})

describe('createGitReader against a real repository', () => {
  it('reads the working tree’s commit', async () => {
    repository = await createTestRepository()
    const reader = createGitReader({ cwd: repository.clonePath })

    const expected = await repository.git(repository.clonePath, 'rev-parse', 'HEAD')

    expect(await reader.headSha()).toBe(expected)
  })

  it('resolves a known ref and reports an unknown one as absent', async () => {
    repository = await createTestRepository()
    const reader = createGitReader({ cwd: repository.clonePath })

    expect(await reader.resolveSha('HEAD')).toMatch(/^[0-9a-f]{40}$/)
    expect(await reader.resolveSha('refs/heads/does-not-exist')).toBeUndefined()
  })

  it('asks the remote directly for a branch tip', async () => {
    repository = await createTestRepository()
    const reader = createGitReader({ cwd: repository.clonePath })

    const advanced = await repository.commitOnRemote('theirs', 'theirs.txt', 'theirs\n')

    expect(await reader.remoteSha(repository.remotePath, 'refs/heads/main')).toBe(advanced)
    expect(await reader.remoteSha(repository.remotePath, 'refs/heads/absent')).toBeUndefined()
  })

  it('measures a distance once the objects are present, and reports it unmeasured before', async () => {
    repository = await createTestRepository()
    const reader = createGitReader({ cwd: repository.clonePath })

    const base = await reader.headSha()
    const advanced = await repository.commitOnRemote('theirs', 'theirs.txt', 'theirs\n')

    expect(await reader.countCommitsBetween(base, advanced)).toBeUndefined()

    await reader.fetchRef(repository.remotePath, 'refs/heads/main')

    expect(await reader.countCommitsBetween(base, advanced)).toBe(1)
  })

  it('changes nothing in the repository it reads', async () => {
    repository = await createTestRepository()
    const reader = createGitReader({ cwd: repository.clonePath })

    await repository.commit('local work', 'work.txt', 'work\n')
    await repository.commitOnRemote('theirs', 'theirs.txt', 'theirs\n')

    const before = {
      head: await repository.git(repository.clonePath, 'rev-parse', 'HEAD'),
      branch: await repository.git(repository.clonePath, 'rev-parse', 'refs/heads/main'),
      status: await repository.git(repository.clonePath, 'status', '--porcelain'),
      tree: await repository.git(repository.clonePath, 'rev-parse', 'HEAD^{tree}'),
      work: await readFile(join(repository.clonePath, 'work.txt'), 'utf8'),
    }

    // The whole read-only surface, including the one command that writes.
    await reader.headSha()
    await reader.resolveSha('HEAD')
    await reader.remoteSha(repository.remotePath, 'refs/heads/main')
    await reader.fetchRef(repository.remotePath, 'refs/heads/main')
    await reader.countCommitsBetween(before.head, 'FETCH_HEAD')

    expect(await repository.git(repository.clonePath, 'rev-parse', 'HEAD')).toBe(before.head)
    expect(await repository.git(repository.clonePath, 'rev-parse', 'refs/heads/main')).toBe(
      before.branch,
    )
    expect(await repository.git(repository.clonePath, 'status', '--porcelain')).toBe(before.status)
    expect(await repository.git(repository.clonePath, 'rev-parse', 'HEAD^{tree}')).toBe(before.tree)
    expect(await readFile(join(repository.clonePath, 'work.txt'), 'utf8')).toBe(before.work)
  })

  it('cannot be handed a mutating command through the runner it was built with', async () => {
    const run = vi.fn<GitRunner>(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }))
    const reader = createGitReader({ cwd: '/workspace', run })

    await reader.resolveSha('HEAD')

    // Every argv the reader ever produces starts with an allow-listed command.
    const allowed = new Set<string>(READ_ONLY_GIT_COMMANDS)

    expect(run.mock.calls.every(([command]) => allowed.has(command.args[0]))).toBe(true)
  })
})
