import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentAdapter, AgentFrame, AgentStartOptions } from '../agent'
import type { BootstrapPhaseFinished, BootstrapPhaseReporter } from '../bootstrap'
import { createFakeArchiveStore, runCommand, sha256Hex } from '../bootstrap'
import type { WorkflowJobEnvelope } from '../job-envelope'
import { parseJobEnvelope } from '../job-envelope'

import { bootstrapRun, setupBundleReference, workspaceEntries } from './bootstrap'

/**
 * Bootstrap phases 2–7 in sequence (FR-112, FR-145, FR-146).
 *
 * Offline and end to end: a real `tar` archive, a real `git` clone over a filesystem path, and a
 * recording agent adapter. What is under test is the *order* — that the bundle runs before the
 * checkout, that the checkout is complete before the agent starts, and that a failure anywhere
 * still names its phase.
 */

const scratchDirectories: string[] = []

const scratch = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'sisyphus-run-bootstrap-'))
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

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Sisyphus Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Sisyphus Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

const BASE_BRANCH = 'integration-line'

/** A throwaway origin on the local filesystem. Real git, no network. */
const createOrigin = async (): Promise<string> => {
  const origin = join(await scratch(), 'origin')
  const run = async (args: readonly string[]): Promise<void> => {
    const result = await runCommand({ command: 'git', args, env: GIT_ENV })

    expect(result.exitCode, `git ${args.join(' ')}: ${result.output}`).toBe(0)
  }

  await run(['init', '--initial-branch', BASE_BRANCH, origin])
  await writeFile(join(origin, 'README.md'), `# fixture\n\n${origin}\n`)
  await run(['-C', origin, 'add', '.'])
  await run(['-C', origin, 'commit', '-m', 'baseline'])

  return origin
}

const buildArchive = async (setupScript: string): Promise<Uint8Array> => {
  const source = await scratch()
  const path = join(source, 'setup.sh')

  await writeFile(path, setupScript)
  await chmod(path, 0o755)

  const archivePath = join(await scratch(), 'bundle.tar.gz')
  const packed = await runCommand({
    command: 'tar',
    args: ['-c', '-z', '-f', archivePath, '-C', source, '.'],
  })

  expect(packed.exitCode).toBe(0)

  return new Uint8Array(await readFile(archivePath))
}

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

interface RecordingAdapter extends AgentAdapter {
  readonly started: AgentStartOptions[]
}

const recordingAdapter = (): RecordingAdapter => {
  const started: AgentStartOptions[] = []

  return {
    started,
    start: async (options) => {
      started.push(options)

      return Promise.resolve()
    },
    sendTurn: async () => Promise.resolve({ acknowledged: true, latencyMs: 0 }),
    quiesce: async () =>
      Promise.resolve({ usage: { turns: 0, spendUsd: 0 }, waitedForTurn: false }),
    stop: async () => Promise.resolve({ exitCode: 0, signal: null, forced: false }),
    output: (async function* (): AsyncGenerator<AgentFrame> {
      // No frames: this suite is about bootstrap, and the adapter's own suite covers the stream.
    })(),
    usage: { turns: 0, spendUsd: 0 },
  }
}

const SETUP = '#!/bin/sh\nmkdir -p "$SISYPHUS_AGENT_CONFIG_DIR"\necho "installed"\nexit 0\n'

const envelopeFor = (options: {
  readonly origin: string
  readonly digest: string
  readonly root: string
  readonly secondOrigin?: string
}): WorkflowJobEnvelope => {
  const entries = [
    {
      entryId: '019fd631-15bf-7a03-a1c6-ff6d568c2660',
      repositoryUrl: options.origin,
      baseBranch: BASE_BRANCH,
      subdirectory: 'app',
      isPrimary: true,
    },
    ...(options.secondOrigin === undefined
      ? []
      : [
          {
            entryId: '019fd631-15bf-7a03-a1c6-ff6d568c2661',
            repositoryUrl: options.secondOrigin,
            baseBranch: BASE_BRANCH,
            subdirectory: 'lib',
            isPrimary: false,
          },
        ]),
  ]

  return parseJobEnvelope(
    JSON.stringify({
      mode: 'workflow',
      workflowId: '019fd631-15bf-7a03-a1c6-ff6d568c2654',
      sessionId: '019fd631-15bf-7a03-a1c6-ff6d568c2655',
      machineSurfaceUrl: 'https://sisyphus.test/api/machine',
      scopedCredential: 'scoped.credential.value',
      setupBundle: { s3Key: 'acme/3/bundle.tar.gz', contentDigest: options.digest, version: 3 },
      workspace: { root: '/workspace', entries },
      job: { model: 'claude-opus-5', turnCap: 40, spendCap: '5.0000', workflowType: 'delegated' },
      prompt: { assembled: 'Add a changelog entry.' },
    }),
  ) as WorkflowJobEnvelope
}

const harness = async (options: { readonly secondOrigin?: boolean } = {}) => {
  const archive = await buildArchive(SETUP)
  const digest = sha256Hex(archive)
  const store = createFakeArchiveStore()
  store.put({ bucket: 'bundles', key: 'acme/3/bundle.tar.gz' }, archive)

  const root = join(await scratch(), 'workspace')
  const envelope = envelopeFor({
    origin: await createOrigin(),
    digest,
    root,
    ...(options.secondOrigin === true ? { secondOrigin: await createOrigin() } : {}),
  })
  const reporter = recordingReporter()
  const adapter = recordingAdapter()

  return {
    reporter,
    adapter,
    envelope,
    root,
    options: {
      envelope,
      archives: store,
      bundlesBucket: 'bundles',
      workspaceRoot: root,
      reporter,
      adapter,
      bundleDir: join(await scratch(), 'bundle'),
      env: GIT_ENV,
    },
  }
}

describe('bootstrapRun', () => {
  it('runs phases 2 through 7 in the order the protocol specifies', async () => {
    const world = await harness()

    const result = await bootstrapRun(world.options)

    expect(world.reporter.finished.map((event) => event.phase)).toStrictEqual([
      'bundle_download',
      'bundle_verify',
      'bundle_unpack',
      'setup_script',
      'entry_checkout',
      'agent_start',
    ])
    expect(world.reporter.finished.every((event) => event.outcome === 'succeeded')).toBe(true)
    expect(result.workspace.entries).toHaveLength(1)
    expect(result.source.entryId).toBe('019fd631-15bf-7a03-a1c6-ff6d568c2660')
  })

  it('starts the agent against the checked-out workspace, with the platform’s session id', async () => {
    const world = await harness()

    await bootstrapRun(world.options)

    expect(world.adapter.started).toHaveLength(1)
    expect(world.adapter.started[0]).toMatchObject({
      sessionId: '019fd631-15bf-7a03-a1c6-ff6d568c2655',
      cwd: world.root,
      model: 'claude-opus-5',
      prompt: 'Add a changelog entry.',
      turnCap: 40,
      spendCapUsd: 5,
    })
    expect(world.adapter.started[0]?.resumeSessionId).toBeUndefined()
  })

  it('passes the snapshot’s session id on a restore boot, not this run’s (FR-150)', async () => {
    const world = await harness()

    await bootstrapRun({
      ...world.options,
      envelope: {
        ...world.envelope,
        resumeFromSnapshot: {
          s3Key: 'snapshots/w/1.tar.zst',
          sessionId: '019fd631-15bf-7a03-a1c6-ff6d568c2656',
        },
      },
    })

    expect(world.adapter.started[0]?.resumeSessionId).toBe('019fd631-15bf-7a03-a1c6-ff6d568c2656')
    // Phases 2–5 still ran: the bundle is how a resumed run gets its credentials back (FR-072).
    expect(world.reporter.finished.map((event) => event.phase)).toContain('setup_script')
  })

  it('checks every entry out before the agent starts (FR-112)', async () => {
    const world = await harness({ secondOrigin: true })

    const result = await bootstrapRun(world.options)

    expect(result.workspace.entries.map((entry) => entry.subdirectory)).toStrictEqual([
      'app',
      'lib',
    ])
    expect(world.adapter.started).toHaveLength(1)
  })

  it('never starts the agent when an entry could not be checked out (FR-112)', async () => {
    const world = await harness()

    await expect(
      bootstrapRun({
        ...world.options,
        envelope: {
          ...world.envelope,
          workspace: {
            ...world.envelope.workspace,
            entries: world.envelope.workspace.entries.map((entry) => ({
              ...entry,
              repositoryUrl: join(world.root, 'no-such-origin'),
            })),
          },
        },
      }),
    ).rejects.toThrow(/entry_checkout/u)

    expect(world.adapter.started).toStrictEqual([])
  })

  it('never starts the agent when the archive digest does not match (FR-088)', async () => {
    const world = await harness()

    await expect(
      bootstrapRun({
        ...world.options,
        envelope: {
          ...world.envelope,
          setupBundle: { ...world.envelope.setupBundle, contentDigest: 'f'.repeat(64) },
        },
      }),
    ).rejects.toThrow(/bundle_verify/u)

    expect(world.adapter.started).toStrictEqual([])
    expect(world.reporter.finished.map((event) => event.phase)).not.toContain('entry_checkout')
  })
})

describe('setupBundleReference', () => {
  it('bridges the envelope’s reference onto the shape the bootstrap path takes', () => {
    expect(
      setupBundleReference(
        { s3Key: 'acme/3/bundle.tar.gz', contentDigest: 'abc', version: 3 },
        'b',
      ),
    ).toStrictEqual({
      bundleId: 'acme/3/bundle.tar.gz',
      name: 'acme/3/bundle.tar.gz',
      version: '3',
      bucket: 'b',
      s3Key: 'acme/3/bundle.tar.gz',
      contentDigest: 'abc',
    })
  })
})

describe('workspaceEntries', () => {
  it('carries every entry through unchanged, primary flag included', async () => {
    const world = await harness({ secondOrigin: true })

    expect(workspaceEntries(world.envelope).map((entry) => entry.isPrimary)).toStrictEqual([
      true,
      false,
    ])
  })
})
