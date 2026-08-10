import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { stripAmbientGitEnvironment } from '../git-fixture-environment'
import type { SanitisedText } from '../output'

import type { GitRunner } from './git'
import { createGitReader, FORBIDDEN_GIT_COMMANDS, READ_ONLY_GIT_COMMANDS } from './git'
import type { StalenessAssessment } from './staleness'
import {
  assessStaleness,
  createArtifactStalenessRecorder,
  REBASE_DECISION,
  recordStaleness,
} from './staleness'
import type { TestRepository } from './test-repository'
import { createTestRepository } from './test-repository'

const WORKFLOW_ID = '3f7b6d2a-1c5e-4a9b-8d3f-2e6c9a4b1d70'
const ENTRY_ID = '8c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f'

/**
 * The staleness assessment runs through the production git reader, which spawns `git` with the
 * environment it was started in — so the ambient repository is removed from this process. See the
 * same note in `./git.test.ts` and `../git-fixture-environment.ts`.
 */
const restoreGitEnvironment = stripAmbientGitEnvironment()

afterAll(restoreGitEnvironment)

let repository: TestRepository | undefined

afterEach(async () => {
  await repository?.cleanup()
  repository = undefined
})

describe('assessStaleness', () => {
  it('reports a base branch that has not moved as current', async () => {
    repository = await createTestRepository()
    const git = createGitReader({ cwd: repository.clonePath })
    const baseShaAtCheckout = await git.headSha()

    const assessment = await assessStaleness({
      entryId: ENTRY_ID,
      repository: 'https://forge.test/acme/web',
      remote: repository.remotePath,
      baseBranch: 'main',
      baseShaAtCheckout,
      git,
    })

    expect(assessment.state).toBe('current')
    expect(assessment.commitsBehind).toBe(0)
    expect(assessment.note).toContain('still at')
  })

  it('detects and measures a base branch that advanced during the run', async () => {
    repository = await createTestRepository()
    const git = createGitReader({ cwd: repository.clonePath })
    const baseShaAtCheckout = await git.headSha()

    await repository.commitOnRemote('someone else', 'x.txt', 'x\n')
    const advanced = await repository.commitOnRemote('and again', 'y.txt', 'y\n')

    const assessment = await assessStaleness({
      entryId: ENTRY_ID,
      repository: 'https://forge.test/acme/web',
      remote: repository.remotePath,
      baseBranch: 'main',
      baseShaAtCheckout,
      git,
    })

    expect(assessment.state).toBe('stale')
    expect(assessment.baseShaNow).toBe(advanced)
    expect(assessment.commitsBehind).toBe(2)
    expect(assessment.note).toContain('by 2 commits')
  })

  it('says undetermined rather than current when the base cannot be read', async () => {
    repository = await createTestRepository()
    const git = createGitReader({ cwd: repository.clonePath })

    const assessment = await assessStaleness({
      repository: 'https://forge.test/acme/web',
      remote: repository.remotePath,
      baseBranch: 'a-branch-that-does-not-exist',
      baseShaAtCheckout: await git.headSha(),
      git,
    })

    // "Not answered" must not be recorded as "the answer is no".
    expect(assessment.state).toBe('undetermined')
    expect(assessment.baseShaNow).toBeUndefined()
    expect(assessment.note).toContain('could not be determined')
  })

  it('is evaluated per entry, so one repository’s staleness is not another’s', async () => {
    repository = await createTestRepository()
    const git = createGitReader({ cwd: repository.clonePath })
    const baseShaAtCheckout = await git.headSha()

    const current = await assessStaleness({
      entryId: ENTRY_ID,
      repository: 'https://forge.test/acme/web',
      remote: repository.remotePath,
      baseBranch: 'main',
      baseShaAtCheckout,
      git,
    })

    await repository.commitOnRemote('someone else', 'x.txt', 'x\n')

    const stale = await assessStaleness({
      entryId: '11111111-2222-4333-8444-555555555555',
      repository: 'https://forge.test/acme/api',
      remote: repository.remotePath,
      baseBranch: 'main',
      baseShaAtCheckout,
      git,
    })

    expect(current.entryId).toBe(ENTRY_ID)
    expect(stale.entryId).toBe('11111111-2222-4333-8444-555555555555')
    expect(stale.state).toBe('stale')
  })

  it('takes the branch and remote from its caller and defaults neither', async () => {
    const run = vi.fn<GitRunner>(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 1 }))
    const git = createGitReader({ cwd: '/workspace', run })

    await assessStaleness({
      repository: 'https://forge.test/acme/web',
      remote: 'upstream',
      baseBranch: 'trunk',
      baseShaAtCheckout: 'a'.repeat(40),
      git,
    })

    expect(run).toHaveBeenCalledWith({
      args: ['ls-remote', 'upstream', 'refs/heads/trunk'],
      cwd: '/workspace',
    })
  })

  it('accepts a fully qualified ref without qualifying it twice', async () => {
    const run = vi.fn<GitRunner>(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 1 }))
    const git = createGitReader({ cwd: '/workspace', run })

    await assessStaleness({
      repository: 'https://forge.test/acme/web',
      remote: 'origin',
      baseBranch: 'refs/heads/release/2026-08',
      baseShaAtCheckout: 'a'.repeat(40),
      git,
    })

    expect(run.mock.calls[0][0].args).toEqual(['ls-remote', 'origin', 'refs/heads/release/2026-08'])
  })
})

describe('the FR-079 division: Sisyphus records, the repository’s skills decide', () => {
  it('records the deferral on every assessment', async () => {
    repository = await createTestRepository()
    const git = createGitReader({ cwd: repository.clonePath })
    const baseShaAtCheckout = await git.headSha()

    await repository.commitOnRemote('someone else', 'x.txt', 'x\n')

    const assessment = await assessStaleness({
      repository: 'https://forge.test/acme/web',
      remote: repository.remotePath,
      baseBranch: 'main',
      baseShaAtCheckout,
      git,
    })

    expect(assessment.rebaseDecision).toBe(REBASE_DECISION)
    expect(REBASE_DECISION).toBe('deferred_to_repository_skills')
    expect(assessment.note).toContain("repository's skills")
    expect(assessment.note).toContain('Sisyphus has not changed the branch')
  })

  it('leaves the working tree, HEAD and the local branch exactly as they were', async () => {
    repository = await createTestRepository()
    const git = createGitReader({ cwd: repository.clonePath })
    const baseShaAtCheckout = await git.headSha()

    await repository.commit('local work in progress', 'work.txt', 'work\n')
    await repository.commitOnRemote('someone else', 'x.txt', 'x\n')
    await repository.commitOnRemote('and again', 'y.txt', 'y\n')

    const before = {
      head: await repository.git(repository.clonePath, 'rev-parse', 'HEAD'),
      branch: await repository.git(repository.clonePath, 'rev-parse', 'refs/heads/main'),
      tree: await repository.git(repository.clonePath, 'rev-parse', 'HEAD^{tree}'),
      log: await repository.git(repository.clonePath, 'rev-list', '--count', 'HEAD'),
      status: await repository.git(repository.clonePath, 'status', '--porcelain'),
      work: await readFile(join(repository.clonePath, 'work.txt'), 'utf8'),
    }

    const assessment = await assessStaleness({
      repository: 'https://forge.test/acme/web',
      remote: repository.remotePath,
      baseBranch: 'main',
      baseShaAtCheckout,
      git,
    })

    expect(assessment.state).toBe('stale')
    // The branch is behind, and it is left behind. A rebase here would be a
    // defect, not a courtesy (FR-079).
    expect(await repository.git(repository.clonePath, 'rev-parse', 'HEAD')).toBe(before.head)
    expect(await repository.git(repository.clonePath, 'rev-parse', 'refs/heads/main')).toBe(
      before.branch,
    )
    expect(await repository.git(repository.clonePath, 'rev-parse', 'HEAD^{tree}')).toBe(before.tree)
    expect(await repository.git(repository.clonePath, 'rev-list', '--count', 'HEAD')).toBe(
      before.log,
    )
    expect(await repository.git(repository.clonePath, 'status', '--porcelain')).toBe(before.status)
    expect(await readFile(join(repository.clonePath, 'work.txt'), 'utf8')).toBe(before.work)
  })

  it('issues only allow-listed git commands, so no rebase is expressible', async () => {
    repository = await createTestRepository()
    const issued: string[][] = []
    const git = createGitReader({
      cwd: repository.clonePath,
      run: (command) => {
        issued.push([...command.args])

        // Force the stale path so `fetch` and `rev-list` are both exercised.
        return Promise.resolve(
          command.args[0] === 'ls-remote'
            ? { stdout: `${'b'.repeat(40)}\trefs/heads/main\n`, stderr: '', exitCode: 0 }
            : { stdout: '3\n', stderr: '', exitCode: 0 },
        )
      },
    })

    const assessment = await assessStaleness({
      repository: 'https://forge.test/acme/web',
      remote: 'origin',
      baseBranch: 'main',
      baseShaAtCheckout: 'a'.repeat(40),
      git,
    })

    expect(assessment.state).toBe('stale')
    expect(issued.map(([subcommand]) => subcommand)).toEqual(['ls-remote', 'fetch', 'rev-list'])

    const allowed = new Set<string>(READ_ONLY_GIT_COMMANDS)
    const forbidden = new Set<string>(FORBIDDEN_GIT_COMMANDS)

    expect(issued.every(([subcommand]) => allowed.has(subcommand))).toBe(true)
    expect(issued.some((args) => args.some((arg) => forbidden.has(arg)))).toBe(false)
  })
})

describe('createArtifactStalenessRecorder', () => {
  const assessment: StalenessAssessment = {
    entryId: ENTRY_ID,
    repository: 'https://forge.test/acme/web',
    baseBranch: 'main',
    baseShaAtCheckout: 'a'.repeat(40),
    baseShaNow: 'b'.repeat(40),
    state: 'stale',
    commitsBehind: 2,
    note: 'main advanced.',
    rebaseDecision: REBASE_DECISION,
  }

  it('stores the assessment before registering the row that names it', async () => {
    const order: string[] = []
    const stored: { key: string; body: SanitisedText }[] = []
    const registerArtifact = vi.fn(async () => {
      order.push('register')

      await Promise.resolve()
    })

    const recorder = createArtifactStalenessRecorder({
      workflowId: WORKFLOW_ID,
      client: { registerArtifact },
      store: {
        put: async (input) => {
          order.push('put')
          stored.push(input)

          await Promise.resolve()
        },
      },
    })

    await recorder.record(assessment)

    expect(order).toEqual(['put', 'register'])
    expect(stored[0].key).toBe(`workflows/${WORKFLOW_ID}/entries/${ENTRY_ID}/staleness.json`)
    expect(JSON.parse(stored[0].body)).toMatchObject({
      state: 'stale',
      commitsBehind: 2,
      rebaseDecision: 'deferred_to_repository_skills',
    })
    expect(registerArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'report', entryId: ENTRY_ID }),
    )
  })

  it('files an entry-less assessment under the primary entry', async () => {
    const stored: string[] = []
    const recorder = createArtifactStalenessRecorder({
      workflowId: WORKFLOW_ID,
      client: { registerArtifact: () => Promise.resolve() },
      store: {
        put: async ({ key }) => {
          stored.push(key)

          await Promise.resolve()
        },
      },
    })

    const withoutEntry: StalenessAssessment = {
      repository: assessment.repository,
      baseBranch: assessment.baseBranch,
      baseShaAtCheckout: assessment.baseShaAtCheckout,
      state: assessment.state,
      note: assessment.note,
      rebaseDecision: assessment.rebaseDecision,
    }

    await recorder.record(withoutEntry)

    expect(stored).toEqual([`workflows/${WORKFLOW_ID}/entries/primary/staleness.json`])
  })
})

describe('recordStaleness', () => {
  it('assesses, records, and does nothing else', async () => {
    repository = await createTestRepository()
    const git = createGitReader({ cwd: repository.clonePath })
    const baseShaAtCheckout = await git.headSha()

    await repository.commitOnRemote('someone else', 'x.txt', 'x\n')

    const recorded: StalenessAssessment[] = []
    const assessment = await recordStaleness(
      {
        record: async (value) => {
          recorded.push(value)

          await Promise.resolve()
        },
      },
      {
        repository: 'https://forge.test/acme/web',
        remote: repository.remotePath,
        baseBranch: 'main',
        baseShaAtCheckout,
        git,
      },
    )

    expect(recorded).toEqual([assessment])
    expect(assessment.state).toBe('stale')
    expect(await repository.git(repository.clonePath, 'rev-parse', 'HEAD')).toBe(baseShaAtCheckout)
  })
})
