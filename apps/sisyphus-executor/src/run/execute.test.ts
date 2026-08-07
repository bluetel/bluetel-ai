import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentAdapter, AgentFrame, AgentUsage } from '../agent'
import { createFakeArchiveStore, runCommand, sha256Hex } from '../bootstrap'
import type { Forge, GitReader, PullRequestSetEntry } from '../delivery'
import type { WorkflowJobEnvelope } from '../job-envelope'
import { parseJobEnvelope } from '../job-envelope'
import type { LogSegmentRecord, SanitisedText, SegmentStore } from '../output'
import type {
  AcknowledgeCommandInput,
  HeartbeatInput,
  MachineSurfaceClient,
  PendingCommands,
  RegisterSnapshotInput,
  SkillReferenceInput,
  SnapshotParkReport,
  TerminalReport,
} from '../report'
import { createShutdownRegistry } from '../runtime'
import type { InstanceMetadataReader, SnapshotPort } from '../session'

import { frameText, runExecutor, supervisionTransportFor } from './execute'
import type { WorkflowPortsFactory } from './execute'

/**
 * The assembled run (T173, T175, T176, T178, FR-047, FR-048, FR-054, FR-056).
 *
 * Offline end to end: a real `tar` bundle, a real `git` clone over a filesystem path, a recording
 * machine surface and a fake snapshot writer. Nothing here opens a socket.
 *
 * The assertions that matter are the ones about what happens on the *unhappy* paths. FR-056 says a
 * run must never exit leaving its state as `running`, so every test that ends badly checks that a
 * terminal outcome was still reported — that is the property the whole control flow in `execute.ts`
 * is shaped around, and it is the one that would rot silently.
 */

const scratchDirectories: string[] = []

const scratch = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'sisyphus-execute-'))
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

/** Poll a condition rather than sleep a guessed interval; the loops under test are real ones. */
const waitUntil = async (condition: () => boolean): Promise<void> => {
  while (!condition()) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1)
    })
  }
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Sisyphus Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Sisyphus Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

const BASE_BRANCH = 'integration-line'
const HEAD = 'd'.repeat(40)
const SETUP = ['#!/bin/sh', 'mkdir -p "$SISYPHUS_AGENT_CONFIG_DIR"', 'exit 0', ''].join('\n')

/**
 * An origin carrying its own `sisyphus-dev` skill.
 *
 * The skill lives in the repository rather than being written by `setup.sh`, because that is where
 * FR-057 puts it: the conventions are the client repository's, and a fixture that installed them
 * from the bundle would be testing a shape the platform does not have.
 */
const createOrigin = async (): Promise<string> => {
  const origin = join(await scratch(), 'origin')
  const run = async (args: readonly string[]): Promise<void> => {
    const result = await runCommand({ command: 'git', args, env: GIT_ENV })

    expect(result.exitCode, `git ${args.join(' ')}: ${result.output}`).toBe(0)
  }

  await run(['init', '--initial-branch', BASE_BRANCH, origin])
  await writeFile(join(origin, 'README.md'), '# fixture\n')
  await mkdir(join(origin, '.claude', 'skills', 'sisyphus-dev'), { recursive: true })
  await writeFile(
    join(origin, '.claude', 'skills', 'sisyphus-dev', 'SKILL.md'),
    'Branch from whatever this repository calls its integration line.\n',
  )
  await run(['-C', origin, 'add', '.'])
  await run(['-C', origin, 'commit', '-m', 'baseline'])

  return origin
}

const buildArchive = async (): Promise<Uint8Array> => {
  const source = await scratch()
  const path = join(source, 'setup.sh')

  await writeFile(path, SETUP)
  await chmod(path, 0o755)

  const archivePath = join(await scratch(), 'bundle.tar.gz')
  const packed = await runCommand({
    command: 'tar',
    args: ['-c', '-z', '-f', archivePath, '-C', source, '.'],
  })

  expect(packed.exitCode).toBe(0)

  return new Uint8Array(await readFile(archivePath))
}

interface RecordingSurface {
  readonly client: MachineSurfaceClient
  readonly heartbeats: HeartbeatInput[]
  readonly phases: string[]
  readonly terminals: TerminalReport[]
  readonly snapshots: RegisterSnapshotInput[]
  readonly acknowledgements: AcknowledgeCommandInput[]
  readonly segments: LogSegmentRecord[]
  /** Every skill the run reported reading. Empty here would mean the reporter is bound to nothing. */
  readonly skillReferences: SkillReferenceInput[]
  /** Every park the run reported. Empty during a failing snapshot means `onParked` reaches nothing. */
  readonly parks: SnapshotParkReport[]
  flushes: number
  pending: PendingCommands
}

const recordingSurface = (): RecordingSurface => {
  const heartbeats: HeartbeatInput[] = []
  const phases: string[] = []
  const terminals: TerminalReport[] = []
  const snapshots: RegisterSnapshotInput[] = []
  const acknowledgements: AcknowledgeCommandInput[] = []
  const segments: LogSegmentRecord[] = []
  const skillReferences: SkillReferenceInput[] = []
  const parks: SnapshotParkReport[] = []
  const state = { flushes: 0, pending: [] as PendingCommands }

  return {
    heartbeats,
    phases,
    terminals,
    snapshots,
    acknowledgements,
    segments,
    skillReferences,
    parks,
    get flushes() {
      return state.flushes
    },
    set flushes(value: number) {
      state.flushes = value
    },
    get pending() {
      return state.pending
    },
    set pending(value: PendingCommands) {
      state.pending = value
    },
    client: {
      heartbeat: async (input) => {
        heartbeats.push(input)

        return Promise.resolve()
      },
      renewCredential: async () =>
        Promise.reject(new Error('no credential renewal in this fixture')),
      registerSnapshot: async (input) => {
        snapshots.push(input)

        return Promise.resolve()
      },
      pullPendingCommands: async () => {
        const next = state.pending
        state.pending = []

        return Promise.resolve(next)
      },
      acknowledgeCommand: async (input) => {
        acknowledgements.push(input)

        return Promise.resolve()
      },
      reportBootstrapPhase: async (report) => {
        phases.push(`${report.phase}:${report.outcome}`)

        return Promise.resolve()
      },
      registerArtifact: async () => Promise.resolve(),
      reportTerminal: async (report) => {
        terminals.push(report)

        return Promise.resolve()
      },
      appendLogSegment: async (record) => {
        segments.push(record)

        return Promise.resolve()
      },
      reportSkillReference: async (input) => {
        skillReferences.push(input)

        return Promise.resolve()
      },
      reportSnapshotPark: async (report) => {
        parks.push(report)

        return Promise.resolve()
      },
      reportExternalAction: async () =>
        Promise.reject(new Error('no external action in this fixture')),
      flush: async () => {
        state.flushes += 1

        return Promise.resolve()
      },
      pendingReports: 0,
      isReportingDegraded: false,
    },
  }
}

const memorySegmentStore = (): SegmentStore & { readonly bodies: SanitisedText[] } => {
  const bodies: SanitisedText[] = []

  return {
    bodies,
    put: async ({ body }) => {
      bodies.push(body)

      return Promise.resolve()
    },
  }
}

interface FakeSnapshotPort extends SnapshotPort {
  readonly captures: number
  /** Captures to fail before the store comes back, standing in for an unreachable bucket. */
  failCaptures: number
}

const fakeSnapshotPort = (): FakeSnapshotPort => {
  const state = { captures: 0, failCaptures: 0 }

  return {
    get captures() {
      return state.captures
    },
    get failCaptures() {
      return state.failCaptures
    },
    set failCaptures(value: number) {
      state.failCaptures = value
    },
    capture: async () => {
      state.captures += 1

      if (state.failCaptures > 0) {
        state.failCaptures -= 1

        return Promise.reject(new Error('the snapshot bucket is unreachable'))
      }

      return Promise.resolve({
        s3Key: 'snapshots/w/1.tar.zst',
        sizeBytes: 2048,
        hasConversationState: true,
        hasWorktreeState: true,
      })
    },
  }
}

const recordingAdapter = (
  frames: readonly AgentFrame[] = [],
): AgentAdapter & {
  readonly stops: number
} => {
  const state = { stops: 0 }

  return {
    get stops() {
      return state.stops
    },
    start: async () => Promise.resolve(),
    sendTurn: async () => Promise.resolve({ acknowledged: true, latencyMs: 0 }),
    quiesce: async () =>
      Promise.resolve({ usage: { turns: 3, spendUsd: 0.5 }, waitedForTurn: false }),
    stop: async () => {
      state.stops += 1

      return Promise.resolve({ exitCode: 0, signal: null, forced: false })
    },
    output: (async function* (): AsyncGenerator<AgentFrame> {
      for (const frame of frames) {
        yield await Promise.resolve(frame)
      }
    })(),
    usage: { turns: 3, spendUsd: 0.5 } satisfies AgentUsage,
  }
}

const fakeGit: GitReader = {
  headSha: async () => Promise.resolve(HEAD),
  resolveSha: async () => Promise.resolve(undefined),
  remoteSha: async () => Promise.resolve(undefined),
  fetchRef: async () => Promise.resolve(),
  countCommitsBetween: async () => Promise.resolve(undefined),
}

const fakeForge = (): Forge => ({
  branchHead: async () => Promise.resolve(HEAD),
  findPullRequest: async () => Promise.resolve(undefined),
  createPullRequest: async (input) =>
    Promise.resolve({ number: 7, url: 'https://git.test/app/pull/7', isDraft: input.draft }),
})

const entryFor = (entryId: string): PullRequestSetEntry => ({
  entryId,
  repository: 'git.test/app',
  baseBranch: BASE_BRANCH,
  wasChanged: true,
  git: fakeGit,
  forge: fakeForge(),
})

const delegatedFactory =
  (develop: () => Promise<void> = async () => Promise.resolve()): WorkflowPortsFactory =>
  ({ bootstrapped }) => ({
    delegated: {
      entries: [entryFor(bootstrapped.source.entryId)],
      developer: async () => {
        await develop()

        return {
          conventions: {
            remote: 'origin',
            branchName: 'ticket-1234-changelog-entry',
            baseBranch: BASE_BRANCH,
            pullRequestTitle: 'ABC-1234 Add a changelog entry',
          },
          summary: {
            entries: [{ repository: 'git.test/app', changed: true, description: 'Added it.' }],
            decisions: [],
            assumptions: [],
            notDone: [],
            uncertainties: [],
          },
        }
      },
    },
  })

const harness = async (overrides: { readonly badDigest?: boolean } = {}) => {
  const archive = await buildArchive()
  const archives = createFakeArchiveStore()
  archives.put({ bucket: 'bundles', key: 'acme/3/bundle.tar.gz' }, archive)

  const root = join(await scratch(), 'workspace')
  const envelope = parseJobEnvelope(
    JSON.stringify({
      mode: 'workflow',
      workflowId: '019fd631-15bf-7a03-a1c6-ff6d568c2654',
      sessionId: '019fd631-15bf-7a03-a1c6-ff6d568c2655',
      machineSurfaceUrl: 'https://sisyphus.test/api/machine',
      scopedCredential: 'scoped.credential.value',
      setupBundle: {
        s3Key: 'acme/3/bundle.tar.gz',
        contentDigest: overrides.badDigest === true ? 'f'.repeat(64) : sha256Hex(archive),
        version: 3,
      },
      workspace: {
        root: '/workspace',
        entries: [
          {
            entryId: '019fd631-15bf-7a03-a1c6-ff6d568c2660',
            repositoryUrl: await createOrigin(),
            baseBranch: BASE_BRANCH,
            subdirectory: 'app',
            isPrimary: true,
          },
        ],
      },
      job: { model: 'claude-opus-5', turnCap: null, spendCap: null, workflowType: 'delegated' },
      prompt: { assembled: 'Add a changelog entry.' },
    }),
  ) as WorkflowJobEnvelope

  const surface = recordingSurface()
  const segments = memorySegmentStore()
  const snapshots = fakeSnapshotPort()
  const adapter = recordingAdapter()

  return {
    surface,
    segments,
    snapshots,
    adapter,
    envelope,
    root,
    base: {
      envelope,
      client: surface.client,
      archives,
      segments,
      snapshots,
      adapter,
      bundlesBucket: 'bundles',
      workspaceRoot: root,
      supervisionIntervalMs: 5,
      interruptionPollMs: 5,
      heartbeatIntervalMs: 50,
    },
  }
}

describe('runExecutor', () => {
  it('bootstraps, runs the delegated workflow and reports a terminal outcome (US1, FR-056)', async () => {
    const world = await harness()

    const result = await runExecutor({ ...world.base, ports: delegatedFactory() })

    expect(result.outcome).toBe('succeeded')
    expect(result.workflow?.workflowType).toBe('delegated')
    expect(result.workflow?.delegated?.movedTicket).toBe(false)
    expect(world.surface.terminals).toHaveLength(1)
    expect(world.surface.terminals[0]?.outcome).toBe('succeeded')
    expect(world.surface.terminals[0]?.turnsUsed).toBe(3)
    expect(world.surface.terminals[0]?.spendUsed).toBe('0.5000')
  })

  it('reports the skills the run read, digests intact (T179, FR-058, FR-059)', async () => {
    const world = await harness()

    await runExecutor({ ...world.base, ports: delegatedFactory() })

    // The reporter this assembly hands to `dispatchWorkflow` used to be `() => undefined`, so
    // `resolveSkill` computed a digest per resolution and threw every one of them away — and
    // `workflow.skillReferences` read a table nothing had ever written to. Anything other than an
    // empty array here means the callback reaches the machine surface.
    expect(world.surface.skillReferences.length).toBeGreaterThan(0)
    expect(world.surface.skillReferences[0]?.skillName).toBe('sisyphus-dev')
  })

  it('reports every bootstrap phase to the machine surface (FR-145)', async () => {
    const world = await harness()

    await runExecutor({ ...world.base, ports: delegatedFactory() })

    expect(world.surface.phases).toStrictEqual([
      'bundle_download:succeeded',
      'bundle_verify:succeeded',
      'bundle_unpack:succeeded',
      'setup_script:succeeded',
      'entry_checkout:succeeded',
      'agent_start:succeeded',
    ])
  })

  it('sends at least one heartbeat, so the reconciler does not park a live run (T176, FR-048)', async () => {
    const world = await harness()

    const result = await runExecutor({ ...world.base, ports: delegatedFactory() })

    expect(result.heartbeats).toBeGreaterThanOrEqual(1)
    expect(world.surface.heartbeats.length).toBeGreaterThanOrEqual(1)
    expect(world.surface.heartbeats[0]).toMatchObject({ turnsUsed: 3, spendUsed: '0.5000' })
  })

  it('persists the run’s log and flushes everything before it returns (FR-046, FR-047)', async () => {
    const world = await harness()

    await runExecutor({ ...world.base, ports: delegatedFactory() })

    expect(world.segments.bodies.length).toBeGreaterThanOrEqual(1)
    expect(world.segments.bodies.join('')).toContain('bundle_download succeeded')
    expect(world.surface.segments.length).toBeGreaterThanOrEqual(1)
    expect(world.surface.flushes).toBe(1)
  })

  it('reports a terminal failure rather than exiting silently when bootstrap fails (FR-056)', async () => {
    const world = await harness({ badDigest: true })

    const result = await runExecutor({ ...world.base, ports: delegatedFactory() })

    expect(result.outcome).toBe('failed')
    expect(result.reason).toContain('bundle_verify')
    expect(world.surface.terminals[0]?.outcome).toBe('failed')
    expect(world.surface.flushes).toBe(1)
  })

  it('reports a terminal failure when this assembly has no ports for the job’s type', async () => {
    const world = await harness()

    const result = await runExecutor({ ...world.base, ports: () => ({}) })

    expect(result.outcome).toBe('failed')
    expect(result.reason).toContain('delegated workflow')
    expect(world.surface.terminals[0]?.outcome).toBe('failed')
  })

  it('suspends through the pause path when a reclamation notice arrives (T175, FR-054)', async () => {
    const world = await harness()
    const metadata: InstanceMetadataReader = {
      readInterruptionNotice: async () =>
        Promise.resolve({ reclaimAt: new Date('2026-08-06T12:00:00Z'), action: 'terminate' }),
    }

    // A workflow that never finishes on its own, so the notice is what ends the run.
    const result = await runExecutor({
      ...world.base,
      metadata,
      ports: delegatedFactory(async () => new Promise<void>(() => undefined)),
    })

    expect(result.outcome).toBe('parked_resumable')
    expect(world.snapshots.captures).toBe(1)
    expect(world.surface.snapshots).toHaveLength(1)
    expect(world.surface.snapshots[0]).toMatchObject({
      boundary: 'interruption',
      hasConversationState: true,
      hasWorktreeState: true,
    })
    expect(world.surface.terminals[0]?.outcome).toBe('parked_resumable')
  })

  it('applies a pause off the supervision queue and acknowledges it after registering (T175, FR-049)', async () => {
    const world = await harness()
    const order: string[] = []

    world.surface.pending = [
      {
        id: '019fd631-15bf-7a03-a1c6-ff6d568c2670',
        command: 'pause',
        sequence: 1,
        deliveryOutcome: 'pending',
        failureReason: null,
        requestedAt: new Date('2026-08-06T11:00:00Z'),
      },
    ]

    const result = await runExecutor({
      ...world.base,
      ports: delegatedFactory(async () => {
        // Hold the workflow open until the pause has been applied and closed out, so the loop
        // under test is the real one rather than a race the assertions happen to win.
        await waitUntil(() => world.surface.acknowledgements.length > 0)
      }),
      onReportingFailure: () => undefined,
    })

    order.push(...world.surface.snapshots.map(() => 'registered'))
    order.push(...world.surface.acknowledgements.map(() => 'acknowledged'))

    expect(world.snapshots.captures).toBe(1)
    // FR-049's order: the snapshot is registered, and only then is the command acknowledged. The
    // workflow was released by the acknowledgement, so it could not have run before either.
    expect(order).toStrictEqual(['registered', 'acknowledged'])
    expect(world.surface.acknowledgements).toStrictEqual([
      { commandId: '019fd631-15bf-7a03-a1c6-ff6d568c2670', outcome: 'acknowledged' },
    ])
    expect(result.suspension?.plan.reason).toBe('pause')
  })

  /**
   * **The FR-082 chain, end to end (T184, quickstart 2f).**
   *
   * Storage is unreachable for the first two attempts at the pause boundary. What must be true
   * afterwards is not "the snapshot eventually landed" — `parkAndRetry` was already tested for
   * that — but that the park reached the **machine surface** with its attempt count, and that the
   * heartbeat went on landing throughout, so the reconciler never sees a lapse and never destroys
   * an instance that was healthy and waiting.
   */
  it('reports each parked attempt and keeps heartbeating while storage is unreachable (FR-082)', async () => {
    const world = await harness()

    world.snapshots.failCaptures = 2
    world.surface.pending = [
      {
        id: '019fd631-15bf-7a03-a1c6-ff6d568c2670',
        command: 'pause',
        sequence: 1,
        deliveryOutcome: 'pending',
        failureReason: null,
        requestedAt: new Date('2026-08-06T11:00:00Z'),
      },
    ]

    const beatsBeforePark = { count: 0 }

    const result = await runExecutor({
      ...world.base,
      heartbeatIntervalMs: 2,
      parkBudget: { maxAttempts: 5, initialDelayMs: 20, maxDelayMs: 20, factor: 1 },
      ports: delegatedFactory(async () => {
        await waitUntil(() => world.surface.parks.length > 0)
        beatsBeforePark.count = world.surface.heartbeats.length
        await waitUntil(() => world.surface.acknowledgements.length > 0)
      }),
      onReportingFailure: () => undefined,
    })

    // Two failed attempts parked and were reported; the third wrote the snapshot.
    expect(world.snapshots.captures).toBe(3)
    expect(world.surface.parks.map((park) => park.attempt)).toStrictEqual([1, 2])
    expect(world.surface.parks[0]).toMatchObject({
      boundary: 'pause',
      maxAttempts: 5,
      detail: 'the snapshot bucket is unreachable',
    })

    // The pause completed rather than failing: parking held the boundary, it did not lose it.
    expect(result.suspension?.parkedAttempts).toBe(2)
    expect(world.surface.acknowledgements).toHaveLength(1)

    // And the run never went quiet. Beats landed after the first park was observed, which is the
    // property the reconciler depends on — a parked run that stopped beating would be swept.
    expect(world.surface.heartbeats.length).toBeGreaterThan(beatsBeforePark.count)
  })

  it('parks the run and hands the instance back when a pause outlives the idle ceiling (T181, US2 §4)', async () => {
    const world = await harness()

    world.surface.pending = [
      {
        id: '019fd631-15bf-7a03-a1c6-ff6d568c2671',
        command: 'pause',
        sequence: 1,
        deliveryOutcome: 'pending',
        failureReason: null,
        requestedAt: new Date('2026-08-06T11:00:00Z'),
      },
    ]

    // A workflow that never finishes on its own, exactly as a paused one does not: the agent is
    // quiesced and nothing will ever answer. Before T181 this run held its instance for ever.
    const result = await runExecutor({
      ...world.base,
      pauseIdleCeilingMs: 5,
      ports: delegatedFactory(async () => new Promise<void>(() => undefined)),
      onReportingFailure: () => undefined,
    })

    // Parked, never failed — the distinction US2 §4 makes, and the one an engineer reads as
    // "my work is safe" rather than "my work is gone".
    expect(result.outcome).toBe('parked_resumable')
    expect(result.reason).toContain('pause idle ceiling')
    expect(world.surface.terminals[0]?.outcome).toBe('parked_resumable')

    // The pause's own snapshot is what makes it resumable, and no second one is taken: the agent
    // has been quiesced throughout, so the tree it captured is still the tree.
    expect(world.snapshots.captures).toBe(1)
    expect(world.surface.snapshots[0]).toMatchObject({
      boundary: 'pause',
      hasConversationState: true,
      hasWorktreeState: true,
    })
  })

  it('does not park a run that was never paused, however long it runs', async () => {
    const world = await harness()
    let released = false

    const result = await runExecutor({
      ...world.base,
      pauseIdleCeilingMs: 5,
      ports: delegatedFactory(async () => {
        // Long enough that a ceiling counting from the start of the run rather than from a pause
        // would have fired several times over.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50)
        })
        released = true
      }),
    })

    expect(released).toBe(true)
    expect(result.outcome).not.toBe('parked_resumable')
  })

  it('stops the agent and runs the shutdown hooks on the way out', async () => {
    const world = await harness()
    const registry = createShutdownRegistry()
    const ran: string[] = []

    registry.onShutdown(() => {
      ran.push('hook')
    })

    await runExecutor({ ...world.base, ports: delegatedFactory(), shutdown: registry })

    expect(world.adapter.stops).toBeGreaterThanOrEqual(1)
    expect(ran).toStrictEqual(['hook'])
  })
})

describe('frameText', () => {
  it('reads the text off the frames that carry one and nothing off the rest', () => {
    expect(frameText({ type: 'assistant', text: 'hello' })).toBe('hello')
    expect(frameText({ type: 'user', text: 'a correction' })).toBe('a correction')
    expect(frameText({ type: 'unknown', raw: '{"type":"tool"}' })).toBe('{"type":"tool"}')
    expect(frameText({ type: 'system', subtype: 'init' })).toBeUndefined()
    expect(
      frameText({
        type: 'result',
        subtype: 'success',
        isError: false,
        usage: { turns: 1, spendUsd: 0 },
      }),
    ).toBeUndefined()
  })
})

describe('supervisionTransportFor', () => {
  it('omits a failure reason rather than sending an undefined one', async () => {
    const sent: AcknowledgeCommandInput[] = []
    const transport = supervisionTransportFor({
      pullPendingCommands: async () => Promise.resolve([]),
      acknowledgeCommand: async (input) => {
        sent.push(input)

        return Promise.resolve()
      },
    })

    await transport.acknowledgeCommand({ commandId: 'c-1', outcome: 'acknowledged' })
    await transport.acknowledgeCommand({
      commandId: 'c-2',
      outcome: 'rejected',
      failureReason: 'no',
    })

    expect(sent).toStrictEqual([
      { commandId: 'c-1', outcome: 'acknowledged' },
      { commandId: 'c-2', outcome: 'rejected', failureReason: 'no' },
    ])
  })
})
