import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, it } from 'vitest'

import type {
  AgentAdapter,
  AgentQuiescedState,
  AgentStartOptions,
  AgentStopResult,
  AgentTurnDelivery,
} from '../agent'
import { GIT_FIXTURE_ENVIRONMENT, stripAmbientGitEnvironment } from '../git-fixture-environment'

import { startAgentPhase } from './agent-start'
import { BootstrapPhaseError, nullPhaseReporter } from './phases'
import type { BootstrapPhaseFinished, BootstrapPhaseReporter } from './phases'
import { runCommand } from './run-command'
import { checkoutWorkspace, type ReadyWorkspace } from './workspace'

const scratchDirectories: string[] = []

const scratch = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'sisyphus-agent-start-'))

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
 * `readyWorkspace` builds a real repository with real `git`, so the ambient one has to go first —
 * see `../git-fixture-environment.ts` for what a git hook exports into this process.
 */
const restoreGitEnvironment = stripAmbientGitEnvironment()

afterAll(restoreGitEnvironment)

interface FakeAdapter extends AgentAdapter {
  readonly starts: AgentStartOptions[]
}

const fakeAdapter = (startImpl?: () => Promise<void>): FakeAdapter => {
  const starts: AgentStartOptions[] = []

  return {
    starts,
    start: (options: AgentStartOptions): Promise<void> => {
      starts.push(options)

      return startImpl?.() ?? Promise.resolve()
    },
    sendTurn: (): Promise<AgentTurnDelivery> =>
      Promise.resolve({ acknowledged: true, latencyMs: 0 }),
    quiesce: (): Promise<AgentQuiescedState> =>
      Promise.resolve({ usage: { turns: 0, spendUsd: 0 }, waitedForTurn: false }),
    stop: (): Promise<AgentStopResult> =>
      Promise.resolve({ exitCode: 0, signal: null, forced: false }),
    output: {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true as const, value: undefined }),
      }),
    },
    usage: { turns: 0, spendUsd: 0 },
  }
}

/**
 * A `ReadyWorkspace` obtained the only way there is: a real, complete checkout.
 *
 * There is deliberately no shortcut. Constructing one by hand would defeat the
 * mechanism the test exists to check.
 */
const readyWorkspace = async (): Promise<ReadyWorkspace> => {
  const root = join(await scratch(), 'workspace')
  const origin = join(await scratch(), 'origin')

  const git = async (args: readonly string[]): Promise<void> => {
    const result = await runCommand({ command: 'git', args, env: GIT_FIXTURE_ENVIRONMENT })

    expect(result.exitCode, result.output).toBe(0)
  }

  await git(['init', '--initial-branch', 'main', origin])
  await git(['-C', origin, 'commit', '--allow-empty', '-m', 'baseline'])

  return checkoutWorkspace({
    root,
    entries: [
      {
        entryId: 'entry-1',
        repositoryUrl: origin,
        baseBranch: 'main',
        subdirectory: 'app',
        isPrimary: true,
      },
    ],
    reporter: nullPhaseReporter,
  })
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

describe('startAgentPhase', () => {
  it('derives the working directory from the completed workspace (FR-113)', async () => {
    const workspace = await readyWorkspace()
    const adapter = fakeAdapter()

    const started = await startAgentPhase({
      adapter,
      workspace,
      sessionId: 'session-1',
      model: 'claude-sonnet-4-5',
      prompt: 'assembled prompt',
      reporter: nullPhaseReporter,
    })

    expect(started.cwd).toBe(workspace.root)
    expect(adapter.starts[0]).toMatchObject({
      cwd: workspace.root,
      configDir: workspace.configDir,
      sessionId: 'session-1',
      prompt: 'assembled prompt',
    })
  }, 60_000)

  it('reports agent_start as its own phase (FR-145)', async () => {
    const workspace = await readyWorkspace()
    const reporter = recordingReporter()

    await startAgentPhase({
      adapter: fakeAdapter(),
      workspace,
      sessionId: 'session-1',
      model: 'claude-sonnet-4-5',
      prompt: 'assembled prompt',
      reporter,
    })

    expect(reporter.finished).toEqual([
      expect.objectContaining({ phase: 'agent_start', outcome: 'succeeded' }),
    ])
  }, 60_000)

  it('passes the caps and the restore session id straight through', async () => {
    const workspace = await readyWorkspace()
    const adapter = fakeAdapter()

    await startAgentPhase({
      adapter,
      workspace,
      sessionId: 'successor-session',
      model: 'claude-sonnet-4-5',
      prompt: 'p',
      turnCap: 30,
      spendCapUsd: 5,
      resumeSessionId: 'predecessor-session',
      reporter: nullPhaseReporter,
    })

    expect(adapter.starts[0]).toMatchObject({
      turnCap: 30,
      spendCapUsd: 5,
      sessionId: 'successor-session',
      resumeSessionId: 'predecessor-session',
    })
  }, 60_000)

  it('fails naming agent_start when the relocated config tree is missing (FR-051)', async () => {
    const workspace = await readyWorkspace()

    await rm(workspace.configDir, { recursive: true, force: true })

    const adapter = fakeAdapter()
    const failure = await startAgentPhase({
      adapter,
      workspace,
      sessionId: 'session-1',
      model: 'claude-sonnet-4-5',
      prompt: 'p',
      reporter: nullPhaseReporter,
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(BootstrapPhaseError)
    expect(failure).toMatchObject({ phase: 'agent_start' })
    // And the agent was never asked to start.
    expect(adapter.starts).toHaveLength(0)
  }, 60_000)

  it('turns an adapter spawn failure into a named agent_start failure (FR-145)', async () => {
    const workspace = await readyWorkspace()
    const reporter = recordingReporter()
    const failure = await startAgentPhase({
      adapter: fakeAdapter(() => Promise.reject(new Error('could not spawn claude'))),
      workspace,
      sessionId: 'session-1',
      model: 'claude-sonnet-4-5',
      prompt: 'p',
      reporter,
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(BootstrapPhaseError)
    expect((failure as BootstrapPhaseError).message).toContain('agent_start')
    expect(reporter.finished[0]).toMatchObject({ outcome: 'failed' })
  }, 60_000)

  it('cannot be handed anything but a completed workspace', async () => {
    const adapter = fakeAdapter()

    await startAgentPhase({
      adapter,
      // @ts-expect-error a workspace that did not come from checkoutWorkspace
      // is not a `ReadyWorkspace`. This line failing to compile is how FR-112's
      // ordering is enforced: phase 7 has no signature a half-built workspace
      // fits, so "the agent never starts against an incomplete workspace" is
      // not a rule anyone has to remember.
      workspace: { root: '/workspace', configDir: '/workspace/.agent-config', entries: [] },
      sessionId: 'session-1',
      model: 'claude-sonnet-4-5',
      prompt: 'p',
      reporter: nullPhaseReporter,
    }).catch(() => undefined)

    expect(adapter.starts).toHaveLength(0)
  })
})
