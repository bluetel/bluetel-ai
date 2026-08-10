import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, it } from 'vitest'

import type { AgentAdapter, AgentFrame, AgentStartOptions } from '../agent'
import type { BootstrapPhaseFinished, BootstrapPhaseReporter } from '../bootstrap'
import { createFakeArchiveStore, runCommand, sha256Hex } from '../bootstrap'
import { GIT_FIXTURE_ENVIRONMENT, stripAmbientGitEnvironment } from '../git-fixture-environment'
import type { WorkflowJobEnvelope } from '../job-envelope'
import { parseJobEnvelope } from '../job-envelope'
import { createSecretRegistry, createSegmentWriter, sanitise } from '../output'

import { bootstrapRun, setupBundleReference, workspaceEntries } from './bootstrap'

/**
 * The leased seat this fixture hands out. Synthetic, and deliberately opaque: research R3 records
 * that the real on-disk format was never read, so nothing here should imply one.
 */
const AGENT_CREDENTIAL = {
  credentialId: '019fd631-15bf-7a03-a1c6-ff6d568c2670',
  fence: 4,
  material: 'not-a-real-agent-credential-0123456789-opaque\n',
}

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

/**
 * The origin below is a real repository built by real `git`, so the ambient one has to go first —
 * see `../git-fixture-environment.ts` for what a git hook exports into this process.
 */
const restoreGitEnvironment = stripAmbientGitEnvironment()

afterAll(restoreGitEnvironment)

const GIT_ENV = GIT_FIXTURE_ENVIRONMENT

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

const harness = async (
  options: { readonly secondOrigin?: boolean; readonly setup?: string } = {},
) => {
  const archive = await buildArchive(options.setup ?? SETUP)
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
  const fetches: number[] = []
  const credentialSecrets = createSecretRegistry()
  const setupOutput: string[] = []

  return {
    reporter,
    adapter,
    envelope,
    root,
    fetches,
    credentialSecrets,
    setupOutput,
    options: {
      onSetupOutput: (text: string) => {
        setupOutput.push(text)
      },
      envelope,
      archives: store,
      bundlesBucket: 'bundles',
      workspaceRoot: root,
      reporter,
      adapter,
      credentials: {
        fetchAgentCredential: () => {
          fetches.push(fetches.length + 1)

          return Promise.resolve(AGENT_CREDENTIAL)
        },
      },
      credentialSecrets,
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
      // After the bundle, because the bundle is what puts the agent CLI on the box; before the
      // checkout, because there is no reason to clone anything for a run that cannot authenticate
      // (003/FR-049).
      'credential_install',
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
    // Phases 2–5 still ran: the bundle is how a resumed run gets its repository-host and
    // third-party credentials back (FR-072).
    expect(world.reporter.finished.map((event) => event.phase)).toContain('setup_script')
  })

  /**
   * **003/T056, FR-050.** The phase existed and was individually timed before this; what did not
   * exist was a caller, so it ran on no boot at all. These are the assertions that it now runs on
   * every one — and they are made against the *envelope shapes* the three boots differ by, because
   * that is where a conditional would have to live if anybody added one.
   */
  describe('the credential install runs on every boot (003/FR-050)', () => {
    it('runs on a first boot', async () => {
      const world = await harness()

      const result = await bootstrapRun(world.options)

      expect(world.fetches).toHaveLength(1)
      expect(result.credential).toStrictEqual({
        credentialId: AGENT_CREDENTIAL.credentialId,
        fence: AGENT_CREDENTIAL.fence,
        path: join(world.root, '.agent-config', 'credentials', '.credentials.json'),
      })
      await expect(readFile(result.credential.path, 'utf8')).resolves.toBe(
        AGENT_CREDENTIAL.material,
      )
    })

    it('runs on a restore boot, where the snapshot carried no credential (FR-013)', async () => {
      const world = await harness()

      const result = await bootstrapRun({
        ...world.options,
        envelope: {
          ...world.envelope,
          resumeFromSnapshot: {
            s3Key: 'snapshots/w/1.tar.zst',
            sessionId: '019fd631-15bf-7a03-a1c6-ff6d568c2656',
          },
        },
      })

      expect(world.fetches).toHaveLength(1)
      expect(world.reporter.finished.map((event) => event.phase)).toContain('credential_install')
      await expect(readFile(result.credential.path, 'utf8')).resolves.toBe(
        AGENT_CREDENTIAL.material,
      )
    })

    it('runs on a resumed-instance boot, over material the previous boot left on the disk', async () => {
      const world = await harness()

      // The disk state a stopped instance boots back into: the previous boot's credential file is
      // still there. It may nevertheless be stale — the credential can have rotated while the
      // instance was not running — which is why there is no "already installed, skip it" branch
      // anywhere in this sequence (003/FR-050).
      const stale = 'not-a-real-agent-credential-from-before-the-stop\n'
      const credentialDir = join(world.root, '.agent-config', 'credentials')

      await mkdir(credentialDir, { recursive: true })
      await writeFile(join(credentialDir, '.credentials.json'), stale)

      const result = await bootstrapRun({
        ...world.options,
        credentials: {
          fetchAgentCredential: () => Promise.resolve({ ...AGENT_CREDENTIAL, fence: 5 }),
        },
      })

      expect(result.credential.fence).toBe(5)
      await expect(readFile(result.credential.path, 'utf8')).resolves.toBe(
        AGENT_CREDENTIAL.material,
      )
    })

    it('registers the material as a known redaction value (FR-014)', async () => {
      const world = await harness()

      await bootstrapRun(world.options)

      const sanitised = sanitise(`echo ${AGENT_CREDENTIAL.material}`, {
        secrets: world.credentialSecrets.current,
      })

      expect(sanitised).not.toContain(AGENT_CREDENTIAL.material.trim())
      expect(sanitised).toContain('[redacted:agent-credential]')
    })

    it('never starts the agent when the credential could not be installed (FR-051)', async () => {
      const world = await harness()

      await expect(
        bootstrapRun({
          ...world.options,
          credentials: {
            fetchAgentCredential: () => Promise.reject(new Error('machine surface returned 503')),
          },
        }),
      ).rejects.toThrow(/credential_install/u)

      // And nothing was cloned either: the phase sits before the checkout precisely so a run that
      // cannot authenticate does not pull a customer's repositories onto the box first.
      expect(world.adapter.started).toHaveLength(0)
      expect(world.reporter.finished.map((event) => event.phase)).not.toContain('entry_checkout')
    })
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

/**
 * **T239 (the residue of T231), FR-045, FR-072, FR-089, 003/FR-014.**
 *
 * The assertion that matters is the last one in the first test, and it is written the way it is on
 * purpose. It plants a credential in the bundle, runs the real bootstrap sequence, and then puts
 * that credential through the **segment writer** — the one thing in the executor that writes agent
 * output anywhere durable — rather than through the registry or the index directly. A test that
 * checked the registry's contents would still have passed on the day `assembleRun` passed no
 * `secrets` at all, because the registry existed and was empty and nothing downstream noticed.
 *
 * The planted value is deliberately in no format `output/secret-patterns.ts` recognises — no
 * `ghp_`, no `sk-`, no JWT — and the line it is written on names no credential-ish key. Both are
 * required for the test to be evidence about this mechanism: with either one relaxed the pattern
 * stage would redact the line on its own and the test would pass with the seeding removed, which
 * is exactly the class of test this task exists because of.
 */
const PLANTED_CREDENTIAL = 'Zq7-K2mv9RtL4xPw8Nc3'

/** A client's bundle installing its repository-host credential, in the commonest shape there is. */
const SETUP_INSTALLING_A_CREDENTIAL = [
  '#!/bin/sh',
  'mkdir -p "$SISYPHUS_AGENT_CONFIG_DIR/credentials"',
  `printf '%s\\n' "${PLANTED_CREDENTIAL}" > "$SISYPHUS_AGENT_CONFIG_DIR/credentials/forge-token"`,
  'echo "installed"',
  'exit 0',
  '',
].join('\n')

describe('the credentials the setup bundle installs at phase 5 (T239)', () => {
  const segments = (registry: ReturnType<typeof createSecretRegistry>, workflowId: string) => {
    const stored: string[] = []

    return {
      stored,
      writer: createSegmentWriter({
        workflowId,
        store: {
          put: (input) => {
            stored.push(input.body)

            return Promise.resolve()
          },
        },
        reporter: { appendLogSegment: () => Promise.resolve() },
        secrets: registry.current,
      }),
    }
  }

  it('are removed from a log segment written after bootstrap', async () => {
    const world = await harness({ setup: SETUP_INSTALLING_A_CREDENTIAL })
    const log = segments(world.credentialSecrets, world.envelope.workflowId)

    await bootstrapRun(world.options)

    // The shape of the leak this closes: something on the instance — the agent reading a file, git
    // reporting a failure, a delivery step quoting a response — puts the value into the run's
    // output long after `setup.sh` has finished.
    await log.writer.write(`the agent printed this while listing a file: ${PLANTED_CREDENTIAL}\n`)
    await log.writer.flush()

    expect(log.stored.join('')).not.toContain(PLANTED_CREDENTIAL)
    expect(log.stored.join('')).toContain('[redacted:bundle.forge-token]')
  })

  it('are known to the registry under the file the bundle installed them in', async () => {
    const world = await harness({ setup: SETUP_INSTALLING_A_CREDENTIAL })

    await bootstrapRun(world.options)

    expect(world.credentialSecrets.current()).toContainEqual({
      name: 'bundle.forge-token',
      value: PLANTED_CREDENTIAL,
    })
  })

  it('are announced to the log as a count and a file, never as a value', async () => {
    const world = await harness({ setup: SETUP_INSTALLING_A_CREDENTIAL })

    await bootstrapRun(world.options)

    const note = world.setupOutput.find((text) => text.startsWith('[bundle]'))

    expect(note).toContain('.agent-config/credentials')
    expect(note).toContain('1 value')
    expect(world.setupOutput.join('')).not.toContain(PLANTED_CREDENTIAL)
  })

  it('says so when the bundle installed none, because that is when the log is least protected', async () => {
    const world = await harness()

    await bootstrapRun(world.options)

    expect(world.setupOutput.find((text) => text.startsWith('[bundle]'))).toContain(
      'no credential values were found',
    )
    expect(world.credentialSecrets.current()).toHaveLength(1)
  })

  /**
   * A **stopped** instance still has the previous boot's agent credential on its disk when phase 5
   * runs. It is the platform's material and phase 5a registers it under its own name; picking it up
   * here would label an operator's placeholder with a bundle file it did not come from.
   */
  it('leaves the agent’s own credential to phase 5a, even when it is already on the disk', async () => {
    const world = await harness({
      setup: [
        '#!/bin/sh',
        'mkdir -p "$SISYPHUS_AGENT_CONFIG_DIR/credentials"',
        `printf '%s' '${AGENT_CREDENTIAL.material.trim()}' ` +
          '> "$SISYPHUS_AGENT_CONFIG_DIR/credentials/.credentials.json"',
        'exit 0',
        '',
      ].join('\n'),
    })

    await bootstrapRun(world.options)

    expect(world.credentialSecrets.current()).toStrictEqual([
      { name: 'agent-credential', value: AGENT_CREDENTIAL.material },
    ])
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
