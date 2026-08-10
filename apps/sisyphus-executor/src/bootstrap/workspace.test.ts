import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, it } from 'vitest'

import { GIT_FIXTURE_ENVIRONMENT, stripAmbientGitEnvironment } from '../git-fixture-environment'

import { BootstrapPhaseError, nullPhaseReporter } from './phases'
import type { BootstrapPhaseFinished, BootstrapPhaseReporter } from './phases'
import { runCommand } from './run-command'
import {
  agentConfigDir,
  type CheckedOutEntry,
  checkoutWorkspace,
  PINNED_WORKSPACE_ROOT,
  prepareWorkspaceRoot,
  resolveEntryPath,
  validateEntries,
  type WorkspaceEntry,
} from './workspace'

const scratchDirectories: string[] = []

const scratch = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'sisyphus-workspace-'))

  scratchDirectories.push(directory)

  return directory
}

afterEach(async () => {
  await Promise.all(
    scratchDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

/**
 * Every fixture below shells out to real `git`, so the ambient repository has to go first — see
 * `../git-fixture-environment.ts` for what a git hook exports into this process and why an
 * inherited `GIT_DIR` makes `git init` operate on the caller's own repository.
 */
const restoreGitEnvironment = stripAmbientGitEnvironment()

afterAll(restoreGitEnvironment)

const GIT_ENV = GIT_FIXTURE_ENVIRONMENT

/**
 * A throwaway origin repository on the local filesystem.
 *
 * Real `git`, cloned over a path rather than a network protocol — the checkout
 * mechanics under test are identical and the suite stays offline.
 */
const createOriginRepository = async (branch = 'main'): Promise<string> => {
  const origin = join(await scratch(), 'origin')
  const run = async (args: readonly string[]): Promise<void> => {
    const result = await runCommand({ command: 'git', args, env: GIT_ENV })

    expect(result.exitCode, `git ${args.join(' ')}: ${result.output}`).toBe(0)
  }

  await run(['init', '--initial-branch', branch, origin])
  // The path is unique per fixture, so two origins created in the same second
  // still produce different commits — which is what lets a multi-entry test
  // assert that each entry resolved against its own repository.
  await writeFile(join(origin, 'README.md'), `# fixture\n\n${origin}\n`)
  await run(['-C', origin, 'add', '.'])
  await run(['-C', origin, 'commit', '-m', 'baseline'])

  return origin
}

const entry = (overrides: Partial<WorkspaceEntry> = {}): WorkspaceEntry => ({
  entryId: 'entry-1',
  repositoryUrl: 'unset',
  baseBranch: 'main',
  subdirectory: 'app',
  isPrimary: true,
  ...overrides,
})

interface RecordingReporter extends BootstrapPhaseReporter {
  readonly finished: BootstrapPhaseFinished[]
}

const recordingReporter = (): RecordingReporter => {
  const finished: BootstrapPhaseFinished[] = []

  return {
    finished,
    phaseStarted: () => undefined,
    phaseFinished: (event) => {
      finished.push(event)
    },
  }
}

describe('pinned paths', () => {
  it('pins the workspace root and puts the config tree inside it (R2, FR-051)', () => {
    expect(PINNED_WORKSPACE_ROOT).toBe('/workspace')
    expect(agentConfigDir(PINNED_WORKSPACE_ROOT)).toBe('/workspace/.agent-config')
  })

  it('creates the root and the config directory before the bundle needs them', async () => {
    const root = join(await scratch(), 'workspace')
    const configDir = await prepareWorkspaceRoot(root)

    expect(configDir).toBe(agentConfigDir(root))
    expect(await readdir(root)).toContain('.agent-config')
  })
})

describe('resolveEntryPath', () => {
  it('resolves a subdirectory beneath the root', () => {
    expect(resolveEntryPath('/workspace', entry({ subdirectory: 'app' }))).toBe('/workspace/app')
  })

  it.each([
    ['an absolute path', '/etc'],
    ['a parent escape', '../elsewhere'],
    ['a deep escape', 'app/../../elsewhere'],
    ['the root itself', '.'],
    ['an empty string', ''],
  ])('refuses %s (FR-111)', (_label, subdirectory) => {
    expect(() => resolveEntryPath('/workspace', entry({ subdirectory }))).toThrow(
      BootstrapPhaseError,
    )
  })

  it('names the entry in the refusal', () => {
    try {
      resolveEntryPath('/workspace', entry({ entryId: 'entry-9', subdirectory: '../out' }))
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as BootstrapPhaseError).entryId).toBe('entry-9')
      expect((error as BootstrapPhaseError).message).toContain('entry-9')
    }
  })
})

describe('validateEntries', () => {
  it('accepts the single-entry workspace, which is the common case (FR-109)', () => {
    expect(validateEntries('/workspace', [entry()])).toEqual([
      { entry: entry(), path: '/workspace/app' },
    ])
  })

  it('refuses a workspace with no entries', () => {
    expect(() => validateEntries('/workspace', [])).toThrow(BootstrapPhaseError)
  })

  it.each([0, 2])('refuses a workspace with %i primary entries (FR-110)', (primaries) => {
    const entries = [
      entry({ entryId: 'a', subdirectory: 'a', isPrimary: primaries > 0 }),
      entry({ entryId: 'b', subdirectory: 'b', isPrimary: primaries > 1 }),
    ]

    expect(() => validateEntries('/workspace', entries)).toThrow(
      /exactly one entry must be primary/,
    )
  })

  it('plans several entries into their own directories (T103, FR-109)', () => {
    const entries = [
      entry({ entryId: 'a', subdirectory: 'api', isPrimary: true }),
      entry({ entryId: 'b', subdirectory: 'web', isPrimary: false }),
      entry({ entryId: 'c', subdirectory: 'nested/infra', isPrimary: false }),
    ]

    expect(validateEntries('/workspace', entries).map(({ path }) => path)).toEqual([
      '/workspace/api',
      '/workspace/web',
      '/workspace/nested/infra',
    ])
  })

  it('refuses two entries claiming the same subdirectory (FR-111)', () => {
    const entries = [
      entry({ entryId: 'a', subdirectory: 'api', isPrimary: true }),
      entry({ entryId: 'b', subdirectory: './api', isPrimary: false }),
    ]

    expect(() => validateEntries('/workspace', entries)).toThrow(/collides with entry a/)
  })

  it.each([
    ['nested beneath an earlier entry', 'api', 'api/web'],
    ['containing an earlier entry', 'api/web', 'api'],
  ])('refuses a subdirectory %s (FR-111)', (_label, first, second) => {
    const entries = [
      entry({ entryId: 'a', subdirectory: first, isPrimary: true }),
      entry({ entryId: 'b', subdirectory: second, isPrimary: false }),
    ]

    // Distinct strings, overlapping trees: only reachable with more than one
    // entry, and the failure a collision check on exact paths would miss.
    expect(() => validateEntries('/workspace', entries)).toThrow(/one checkout would land inside/)
  })

  it('names the offending entry rather than the workspace', () => {
    const entries = [
      entry({ entryId: 'first', subdirectory: 'api', isPrimary: true }),
      entry({ entryId: 'second', subdirectory: 'api/web', isPrimary: false }),
    ]

    try {
      validateEntries('/workspace', entries)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as BootstrapPhaseError).entryId).toBe('second')
    }
  })
})

describe('checkoutWorkspace', () => {
  it('checks the entry out at its branch and records the resolved commit (FR-114)', async () => {
    const origin = await createOriginRepository()
    const root = join(await scratch(), 'workspace')
    const reporter = recordingReporter()

    const workspace = await checkoutWorkspace({
      root,
      entries: [entry({ repositoryUrl: origin })],
      reporter,
      env: GIT_ENV,
    })

    expect(workspace.root).toBe(root)
    expect(workspace.entries).toHaveLength(1)
    expect(workspace.primary.entryId).toBe('entry-1')
    expect(workspace.primary.path).toBe(join(root, 'app'))
    expect(workspace.primary.resolvedCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(await readdir(workspace.primary.path)).toContain('README.md')
    expect(reporter.finished).toEqual([
      expect.objectContaining({ phase: 'entry_checkout', outcome: 'succeeded' }),
    ])
  }, 60_000)

  it('checks out the declared branch, not whatever HEAD happens to be', async () => {
    const origin = await createOriginRepository('release')
    const root = join(await scratch(), 'workspace')

    const workspace = await checkoutWorkspace({
      root,
      entries: [entry({ repositoryUrl: origin, baseBranch: 'release' })],
      reporter: nullPhaseReporter,
      env: GIT_ENV,
    })

    const branch = await runCommand({
      command: 'git',
      args: ['-C', workspace.primary.path, 'rev-parse', '--abbrev-ref', 'HEAD'],
      env: GIT_ENV,
    })

    expect(branch.output.trim()).toBe('release')
  }, 60_000)

  it('brings .git across, so uncommitted work can survive a snapshot later', async () => {
    const origin = await createOriginRepository()
    const root = join(await scratch(), 'workspace')

    const workspace = await checkoutWorkspace({
      root,
      entries: [entry({ repositoryUrl: origin })],
      reporter: nullPhaseReporter,
      env: GIT_ENV,
    })

    expect(await readdir(workspace.primary.path)).toContain('.git')
  }, 60_000)

  it('fails naming the entry when the branch does not exist (FR-112)', async () => {
    const origin = await createOriginRepository()
    const root = join(await scratch(), 'workspace')
    const reporter = recordingReporter()

    const failure = await checkoutWorkspace({
      root,
      entries: [
        entry({ entryId: 'entry-42', repositoryUrl: origin, baseBranch: 'no-such-branch' }),
      ],
      reporter,
      env: GIT_ENV,
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(BootstrapPhaseError)
    expect(failure).toMatchObject({ phase: 'entry_checkout', entryId: 'entry-42' })
    expect((failure as BootstrapPhaseError).message).toContain('entry-42')
    expect(reporter.finished[0]).toMatchObject({
      phase: 'entry_checkout',
      outcome: 'failed',
      entryId: 'entry-42',
    })
  }, 60_000)

  it('leaves no partial workspace behind when an entry fails (FR-112)', async () => {
    const root = join(await scratch(), 'workspace')

    await checkoutWorkspace({
      root,
      entries: [entry({ repositoryUrl: join(root, 'not-a-repository') })],
      reporter: nullPhaseReporter,
      env: GIT_ENV,
    }).catch(() => undefined)

    // The config tree survives — `setup.sh` populated it in phase 5 — but the
    // entry directory does not.
    expect(await readdir(root)).toEqual(['.agent-config'])
  }, 60_000)

  it('checks out every entry of a multi-repository workspace (T103, FR-112)', async () => {
    const first = await createOriginRepository()
    const second = await createOriginRepository()
    const root = join(await scratch(), 'workspace')
    const recorded: CheckedOutEntry[] = []

    const workspace = await checkoutWorkspace({
      root,
      entries: [
        entry({ entryId: 'api', repositoryUrl: first, subdirectory: 'api', isPrimary: true }),
        entry({ entryId: 'web', repositoryUrl: second, subdirectory: 'web', isPrimary: false }),
      ],
      reporter: nullPhaseReporter,
      reportEntry: (checked) => {
        recorded.push(checked)
      },
      env: GIT_ENV,
    })

    expect(workspace.entries).toHaveLength(2)
    expect(workspace.primary.entryId).toBe('api')
    expect(await readdir(join(root, 'api'))).toContain('README.md')
    expect(await readdir(join(root, 'web'))).toContain('README.md')
    // FR-114: every entry's commit, recorded at checkout time rather than at
    // the end of the run, and each one resolved against its own repository.
    expect(recorded.map(({ entryId }) => entryId)).toEqual(['api', 'web'])
    expect(recorded.every(({ resolvedCommit }) => /^[0-9a-f]{40}$/.test(resolvedCommit))).toBe(true)
    expect(recorded[0]?.resolvedCommit).not.toBe(recorded[1]?.resolvedCommit)
  }, 90_000)

  it('fails naming the second entry and leaves no partial workspace (FR-112)', async () => {
    const good = await createOriginRepository()
    const root = join(await scratch(), 'workspace')
    const recorded: CheckedOutEntry[] = []

    const failure = await checkoutWorkspace({
      root,
      entries: [
        entry({ entryId: 'api', repositoryUrl: good, subdirectory: 'api', isPrimary: true }),
        entry({
          entryId: 'web',
          repositoryUrl: join(root, 'not-a-repository'),
          subdirectory: 'web',
          isPrimary: false,
        }),
      ],
      reporter: nullPhaseReporter,
      reportEntry: (checked) => {
        recorded.push(checked)
      },
      env: GIT_ENV,
    }).catch((error: unknown) => error)

    expect(failure).toMatchObject({ phase: 'entry_checkout', entryId: 'web' })
    // The first entry checked out and was recorded, and it is still removed:
    // an agent must never see one of two repositories.
    expect(recorded.map(({ entryId }) => entryId)).toEqual(['api'])
    expect(await readdir(root)).toEqual(['.agent-config'])
  }, 90_000)

  it('fails the checkout when an entry’s commit cannot be recorded (FR-114)', async () => {
    const origin = await createOriginRepository()
    const root = join(await scratch(), 'workspace')

    const failure = await checkoutWorkspace({
      root,
      entries: [entry({ entryId: 'api', repositoryUrl: origin, subdirectory: 'api' })],
      reporter: nullPhaseReporter,
      reportEntry: () => {
        throw new Error('the machine surface refused the checkout report')
      },
      env: GIT_ENV,
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(BootstrapPhaseError)
    expect((failure as BootstrapPhaseError).message).toContain('the machine surface refused')
    expect(await readdir(root)).toEqual(['.agent-config'])
  }, 60_000)

  it('reports a residue it could not remove instead of hiding it (FR-112)', async () => {
    const good = await createOriginRepository()
    const root = join(await scratch(), 'workspace')

    const failure = await checkoutWorkspace({
      root,
      entries: [
        entry({ entryId: 'api', repositoryUrl: good, subdirectory: 'api', isPrimary: true }),
        entry({
          entryId: 'web',
          repositoryUrl: join(root, 'not-a-repository'),
          subdirectory: 'web',
          isPrimary: false,
        }),
      ],
      reporter: nullPhaseReporter,
      remove: () => Promise.reject(new Error('EACCES')),
      env: GIT_ENV,
    }).catch((error: unknown) => error)

    // Still names the entry that failed, and now also says the retry will not
    // start from a clean tree — which the next attempt would otherwise report
    // as "destination path already exists" against the wrong entry.
    expect(failure).toMatchObject({ phase: 'entry_checkout', entryId: 'web', retryable: false })
    expect((failure as BootstrapPhaseError).message).toContain(join(root, 'api'))
    expect((failure as BootstrapPhaseError).message).toContain('could not be removed')
  }, 90_000)

  it('fails on its own timeout, naming entry_checkout (FR-146)', async () => {
    const root = join(await scratch(), 'workspace')
    const failure = await checkoutWorkspace({
      root,
      entries: [entry({ repositoryUrl: 'ssh://git@localhost/repo.git' })],
      reporter: nullPhaseReporter,
      timeoutMs: 300,
      // The clone hangs without touching the network: git shells out to
      // `GIT_SSH_COMMAND`, and this one just sleeps.
      env: { ...GIT_ENV, GIT_SSH_COMMAND: 'sleep 30', GIT_TERMINAL_PROMPT: '0' },
    }).catch((error: unknown) => error)

    expect(failure).toMatchObject({ phase: 'entry_checkout' })
  }, 60_000)
})
