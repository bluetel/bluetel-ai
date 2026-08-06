/**
 * T057 — the adapter driven against the stub agent process.
 *
 * A genuine child process over genuine pipes, spawned through the same
 * `createCliStreamAdapter` the executor uses in production: only the process
 * spec differs. That is the point. The whole start / correct / quiesce / stop
 * loop is exercised on every `vitest` run **without a single token of paid
 * inference**, and without the `claude` binary needing to exist on the machine.
 *
 * What it does not test is stated where it matters, and once here: the stub is
 * not the CLI. It was built from the frame vocabulary in the shipped binary's
 * strings (spike S1), so the shapes are faithful, but its scheduling is its
 * own. A test asserting that a mid-request turn steers the in-flight request is
 * a statement about the stub. What it genuinely proves about the adapter is
 * that a turn written mid-response is delivered without a restart, that a
 * boundary is detected wherever it falls, and that an unfamiliar frame does not
 * kill the run.
 */

import { describe, expect, it } from 'vitest'

import type { AgentAdapter, AgentFrame, AgentUnknownFrame } from './adapter'
import { AgentAdapterError } from './adapter'
import { createCliStreamAdapter } from './cli-stream'
import type { AgentProcessSpecFactory } from './invocation'
import { resolveTsxBinary, stubAgentEntry } from './spike-stdin'
import { INJECTION_MARKER, type StubAgentConfig } from './stub-agent'

const SESSION_ID = '9f1d1b3e-0000-4000-8000-000000000abc'

const stubProcessSpec =
  (config: Partial<StubAgentConfig> = {}): AgentProcessSpecFactory =>
  () => ({
    command: resolveTsxBinary(),
    args: [stubAgentEntry(), JSON.stringify({ sessionId: SESSION_ID, ...config })],
    env: {},
  })

interface Harness {
  readonly adapter: AgentAdapter
  readonly frames: readonly AgentFrame[]
  readonly unknownFrames: readonly AgentUnknownFrame[]
  readonly waitFor: (
    predicate: (frame: AgentFrame) => boolean,
    label: string,
  ) => Promise<AgentFrame>
  readonly countOf: (type: AgentFrame['type']) => number
  readonly dispose: () => Promise<void>
}

const isChunk = (frame: AgentFrame): boolean =>
  frame.type === 'assistant' && frame.text.includes('chunk ')

/** Collect `output` in the background, exactly as the segment writer will. */
const createHarness = (config: Partial<StubAgentConfig> = {}): Harness => {
  const frames: AgentFrame[] = []
  const unknownFrames: AgentUnknownFrame[] = []
  const adapter = createCliStreamAdapter({
    processSpec: stubProcessSpec(config),
    onUnknownFrame: (frame) => unknownFrames.push(frame),
    quiesceTimeoutMs: 20_000,
    sendTurnTimeoutMs: 5_000,
  })

  const consumed = (async (): Promise<void> => {
    for await (const frame of adapter.output) {
      frames.push(frame)
    }
  })()

  return {
    adapter,
    frames,
    unknownFrames,
    waitFor: async (predicate, label): Promise<AgentFrame> => {
      const deadline = Date.now() + 20_000

      for (;;) {
        const found = frames.find(predicate)

        if (found !== undefined) {
          return found
        }

        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${label}`)
        }

        await new Promise((resolveTick) => setTimeout(resolveTick, 5))
      }
    },
    countOf: (type) => frames.filter((frame) => frame.type === type).length,
    dispose: async (): Promise<void> => {
      await adapter.stop({ force: true, timeoutMs: 2_000 })
      await consumed
    },
  }
}

const start = async (harness: Harness, prompt = 'first task'): Promise<void> => {
  await harness.adapter.start({
    sessionId: SESSION_ID,
    cwd: process.cwd(),
    model: 'claude-sonnet-4-5',
    prompt,
  })
}

describe('cli-stream adapter — start', () => {
  it('spawns the agent and resolves once the session is acknowledged', async () => {
    const harness = createHarness({ chunkCount: 2, chunkDelayMs: 10 })

    try {
      await start(harness)

      const init = harness.frames.find((frame) => frame.type === 'system')

      expect(init).toBeDefined()
      expect(init).toMatchObject({ type: 'system', subtype: 'init', sessionId: SESSION_ID })
    } finally {
      await harness.dispose()
    }
  }, 30_000)

  it('delivers the opening prompt as an ordinary user turn', async () => {
    const harness = createHarness({ chunkCount: 2, chunkDelayMs: 10 })

    try {
      await start(harness, 'implement the ticket')

      const chunk = await harness.waitFor(isChunk, 'the response to the opening prompt')

      expect(chunk).toMatchObject({ type: 'assistant' })
      expect(chunk.type === 'assistant' && chunk.text).toContain('implement the ticket')
    } finally {
      await harness.dispose()
    }
  }, 30_000)

  it('refuses a second start rather than spawning a second agent', async () => {
    const harness = createHarness({ chunkCount: 1, chunkDelayMs: 5 })

    try {
      await start(harness)
      await expect(start(harness)).rejects.toMatchObject({
        name: 'AgentAdapterError',
        kind: 'protocol',
      })
    } finally {
      await harness.dispose()
    }
  }, 30_000)

  it('fails with spawn-failed when the agent binary is not there', async () => {
    const adapter = createCliStreamAdapter({
      processSpec: () => ({ command: 'sisyphus-no-such-agent-binary', args: [], env: {} }),
      onUnknownFrame: () => undefined,
      startTimeoutMs: 5_000,
    })

    const failure = await adapter
      .start({
        sessionId: SESSION_ID,
        cwd: process.cwd(),
        model: 'claude-sonnet-4-5',
        prompt: 'first task',
      })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AgentAdapterError)
    expect(failure).toMatchObject({ kind: 'spawn-failed' })
  }, 30_000)
})

describe('cli-stream adapter — corrections', () => {
  it('delivers a turn written mid-request into the live conversation (FR-044)', async () => {
    const harness = createHarness({ chunkCount: 12, chunkDelayMs: 30 })

    try {
      await start(harness)
      await harness.waitFor(
        () => harness.frames.filter(isChunk).length >= 3,
        'the response to be demonstrably in flight',
      )

      // No `result` yet: the correction is genuinely landing mid-request.
      expect(harness.countOf('result')).toBe(0)

      const delivery = await harness.adapter.sendTurn('correction')

      expect(delivery.acknowledged).toBe(true)
      expect(delivery.latencyMs).toBeGreaterThanOrEqual(0)

      const injected = await harness.waitFor(
        (frame) => frame.type === 'assistant' && frame.text.startsWith(INJECTION_MARKER),
        'the agent to act on the injected turn',
      )

      expect(injected).toBeDefined()
      // Reached the agent before the request it was written into finished.
      expect(harness.countOf('result')).toBe(0)
    } finally {
      await harness.dispose()
    }
  }, 30_000)

  it('does not restart the process to deliver a turn', async () => {
    const harness = createHarness({ chunkCount: 10, chunkDelayMs: 25 })

    try {
      await start(harness)
      await harness.waitFor(
        () => harness.frames.filter(isChunk).length >= 2,
        'the first response to start',
      )
      await harness.adapter.sendTurn('correction')
      await harness.waitFor((frame) => frame.type === 'result', 'the request to finish')

      // A restart would produce a second session init and a second result for
      // the same request. One of each means one uninterrupted conversation.
      expect(harness.countOf('system')).toBe(1)
      expect(harness.countOf('result')).toBe(1)
    } finally {
      await harness.dispose()
    }
  }, 30_000)

  it('reports a turn as unacknowledged rather than delivered when no echo comes back', async () => {
    const harness = createHarness({ chunkCount: 10, chunkDelayMs: 25, replayUserMessages: false })

    try {
      await start(harness)
      await harness.waitFor(
        () => harness.frames.filter(isChunk).length >= 1,
        'the first response to start',
      )

      const delivery = await harness.adapter.sendTurn('correction', { timeoutMs: 300 })

      // The write succeeded; nothing confirmed receipt. Saying so is the whole
      // reason `sendTurn` returns evidence instead of `void` (FR-049).
      expect(delivery.acknowledged).toBe(false)
    } finally {
      await harness.dispose()
    }
  }, 30_000)

  it('refuses a turn before start and after stop', async () => {
    const harness = createHarness({ chunkCount: 1, chunkDelayMs: 5 })

    await expect(harness.adapter.sendTurn('too early')).rejects.toMatchObject({
      kind: 'not-started',
    })

    try {
      await start(harness)
      await harness.adapter.stop({ force: true, timeoutMs: 2_000 })
      await expect(harness.adapter.sendTurn('too late')).rejects.toMatchObject({
        kind: 'already-stopped',
      })
    } finally {
      await harness.dispose()
    }
  }, 30_000)
})

describe('cli-stream adapter — quiesce', () => {
  it('waits for the turn boundary and leaves the agent alive (FR-049)', async () => {
    const harness = createHarness({ chunkCount: 6, chunkDelayMs: 25, spendPerTurnUsd: 0.25 })

    try {
      await start(harness)

      const state = await harness.adapter.quiesce()

      expect(state.waitedForTurn).toBe(true)
      expect(state.usage.turns).toBe(1)

      // Alive and idle: it still answers, which a kill-based quiesce could not.
      const delivery = await harness.adapter.sendTurn('after the boundary')

      expect(delivery.acknowledged).toBe(true)
    } finally {
      await harness.dispose()
    }
  }, 30_000)

  it('returns immediately when no turn is in flight', async () => {
    const harness = createHarness({ chunkCount: 3, chunkDelayMs: 10 })

    try {
      await start(harness)
      await harness.adapter.quiesce()

      const second = await harness.adapter.quiesce()

      expect(second.waitedForTurn).toBe(false)
    } finally {
      await harness.dispose()
    }
  }, 30_000)

  it('rejects with quiesce-timeout rather than letting a snapshot assume a boundary', async () => {
    const harness = createHarness({ chunkCount: 40, chunkDelayMs: 100 })

    try {
      await start(harness)
      await expect(harness.adapter.quiesce({ timeoutMs: 150 })).rejects.toMatchObject({
        kind: 'quiesce-timeout',
      })
    } finally {
      await harness.dispose()
    }
  }, 30_000)

  it('refuses to quiesce before the agent has started', async () => {
    const harness = createHarness()

    await expect(harness.adapter.quiesce()).rejects.toMatchObject({ kind: 'not-started' })
  })
})

describe('cli-stream adapter — stop', () => {
  it('ends the session gracefully by closing the input stream', async () => {
    const harness = createHarness({ chunkCount: 2, chunkDelayMs: 10 })

    try {
      await start(harness)
      await harness.adapter.quiesce()

      const result = await harness.adapter.stop({ force: false, timeoutMs: 10_000 })

      expect(result.exitCode).toBe(0)
      expect(result.forced).toBe(false)
    } finally {
      await harness.dispose()
    }
  }, 30_000)

  it('kills the process group when forced, and reports that it did', async () => {
    const harness = createHarness({ chunkCount: 200, chunkDelayMs: 50 })

    try {
      await start(harness)

      const result = await harness.adapter.stop({ force: true, timeoutMs: 5_000 })

      expect(result.forced).toBe(true)
      expect(result.exitCode).toBeNull()
      expect(result.signal).toBe('SIGKILL')
    } finally {
      await harness.dispose()
    }
  }, 30_000)

  it('is safe to call twice, and the second call is the first answer', async () => {
    const harness = createHarness({ chunkCount: 2, chunkDelayMs: 10 })

    try {
      await start(harness)
      await harness.adapter.quiesce()

      const first = await harness.adapter.stop({ force: false, timeoutMs: 10_000 })
      const second = await harness.adapter.stop({ force: false, timeoutMs: 10_000 })

      expect(second).toEqual(first)
    } finally {
      await harness.dispose()
    }
  }, 30_000)

  it('completes the output stream when the process exits', async () => {
    const harness = createHarness({ chunkCount: 2, chunkDelayMs: 10 })

    await start(harness)
    await harness.adapter.quiesce()
    await harness.adapter.stop({ force: false, timeoutMs: 10_000 })

    // `dispose` awaits the collector; it only returns if iteration completed.
    await harness.dispose()

    expect(harness.frames.length).toBeGreaterThan(0)
  }, 30_000)
})

describe('cli-stream adapter — usage accounting', () => {
  it('tracks turns and spend from result frames, monotonically', async () => {
    const harness = createHarness({ chunkCount: 2, chunkDelayMs: 10, spendPerTurnUsd: 0.25 })

    try {
      expect(harness.adapter.usage).toEqual({ turns: 0, spendUsd: 0 })

      await start(harness)
      await harness.adapter.quiesce()

      expect(harness.adapter.usage).toEqual({ turns: 1, spendUsd: 0.25 })

      await harness.adapter.sendTurn('second task')
      await harness.adapter.quiesce()

      expect(harness.adapter.usage).toEqual({ turns: 2, spendUsd: 0.5 })
    } finally {
      await harness.dispose()
    }
  }, 30_000)

  it('reads usage without blocking, so a caps check costs nothing', async () => {
    const harness = createHarness({ chunkCount: 8, chunkDelayMs: 20 })

    try {
      await start(harness)

      // Mid-turn, before any result frame: a figure, not a round trip.
      expect(harness.adapter.usage.turns).toBe(0)
    } finally {
      await harness.dispose()
    }
  }, 30_000)
})

describe('cli-stream adapter — unrecognised frames', () => {
  it('survives an unfamiliar frame, reports it, and completes the run', async () => {
    const harness = createHarness({ chunkCount: 3, chunkDelayMs: 10, emitUnknownFrame: true })

    try {
      await start(harness)

      const state = await harness.adapter.quiesce()

      // The run reached its turn boundary despite the unfamiliar frame — the
      // requirement is that it is skipped, not that it is tolerated silently.
      expect(state.usage.turns).toBe(1)
      expect(harness.unknownFrames).toHaveLength(1)
      expect(harness.unknownFrames[0]?.raw).toContain('stub_diagnostic')

      // And it is still on the output stream, so it reaches the sanitiser and
      // a run producing a flood of them is visibly wrong rather than quietly so.
      expect(harness.countOf('unknown')).toBeGreaterThanOrEqual(1)
    } finally {
      await harness.dispose()
    }
  }, 30_000)
})
