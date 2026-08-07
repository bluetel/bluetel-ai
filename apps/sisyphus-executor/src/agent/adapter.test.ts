import { describe, expect, it } from 'vitest'

import {
  AgentAdapterError,
  type AgentAdapter,
  type AgentFrame,
  type AgentQuiescedState,
  type AgentStartOptions,
  type AgentStopResult,
  type AgentTurnDelivery,
  type AgentUsage,
} from './adapter'

/**
 * A minimal in-memory adapter.
 *
 * Its job here is to prove the boundary is implementable without a process, a
 * pipe or a CLI — which is the whole claim behind R1's fallback being a swap
 * rather than a rewrite. If the SDK implementation could not satisfy this
 * shape, neither could this fake, and the seam would be a fiction.
 */
const createFakeAdapter = (): AgentAdapter & { readonly starts: number } => {
  const frames: AgentFrame[] = []
  let starts = 0
  let stopped = false
  let usage: AgentUsage = { turns: 0, spendUsd: 0 }

  const emit = (frame: AgentFrame): void => {
    frames.push(frame)
  }

  return {
    get starts() {
      return starts
    },
    start: (options: AgentStartOptions) => {
      starts += 1
      emit({ type: 'system', subtype: 'init', sessionId: options.sessionId })

      return Promise.resolve()
    },
    sendTurn: (body: string): Promise<AgentTurnDelivery> => {
      if (stopped) {
        return Promise.reject(
          new AgentAdapterError('already-stopped', 'the agent has already stopped'),
        )
      }

      emit({ type: 'user', text: body })
      usage = { turns: usage.turns + 1, spendUsd: usage.spendUsd + 0.01 }

      return Promise.resolve({ acknowledged: true, latencyMs: 1 })
    },
    quiesce: (): Promise<AgentQuiescedState> => Promise.resolve({ usage, waitedForTurn: false }),
    stop: (): Promise<AgentStopResult> => {
      stopped = true

      return Promise.resolve({ exitCode: 0, signal: null, forced: false })
    },
    get output(): AsyncIterable<AgentFrame> {
      return {
        [Symbol.asyncIterator]: () => {
          let index = 0

          return {
            next: () => {
              const frame = frames.at(index)

              index += 1

              return Promise.resolve(
                frame === undefined
                  ? { value: undefined, done: true as const }
                  : { value: frame, done: false as const },
              )
            },
          }
        },
      }
    },
    get usage() {
      return usage
    },
  }
}

describe('AgentAdapter', () => {
  it('is satisfiable without a process, so the SDK fallback is a swap', async () => {
    const adapter = createFakeAdapter()

    await adapter.start({
      sessionId: 'session-a',
      cwd: '/workspace',
      model: 'a-model',
      prompt: 'do the thing',
    })

    expect(adapter.starts).toBe(1)
  })

  it('does not restart the agent when a turn is sent (FR-044)', async () => {
    const adapter = createFakeAdapter()

    await adapter.start({
      sessionId: 'session-a',
      cwd: '/workspace',
      model: 'a-model',
      prompt: 'do the thing',
    })
    await adapter.sendTurn('actually, use the other branch')
    await adapter.sendTurn('and squash the commits')

    expect(adapter.starts).toBe(1)
  })

  it('reports delivery rather than assuming it, so a correction can fail visibly', async () => {
    const adapter = createFakeAdapter()

    await adapter.start({
      sessionId: 'session-a',
      cwd: '/workspace',
      model: 'a-model',
      prompt: 'do the thing',
    })

    const delivery = await adapter.sendTurn('a correction')

    expect(delivery.acknowledged).toBe(true)
    expect(delivery.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('leaves the agent alive across quiesce, which is what makes pause non-destructive', async () => {
    const adapter = createFakeAdapter()

    await adapter.start({
      sessionId: 'session-a',
      cwd: '/workspace',
      model: 'a-model',
      prompt: 'do the thing',
    })
    await adapter.sendTurn('a correction')

    const quiesced = await adapter.quiesce()

    expect(quiesced.usage.turns).toBe(1)

    // Still usable afterwards — a quiesce implemented as a kill would fail here.
    await expect(adapter.sendTurn('another correction')).resolves.toMatchObject({
      acknowledged: true,
    })
  })

  it('fails a turn sent after stop with a named reason, not a bare error', async () => {
    const adapter = createFakeAdapter()

    await adapter.start({
      sessionId: 'session-a',
      cwd: '/workspace',
      model: 'a-model',
      prompt: 'do the thing',
    })
    await adapter.stop({ force: false })

    await expect(adapter.sendTurn('too late')).rejects.toBeInstanceOf(AgentAdapterError)

    const failure = await adapter.sendTurn('too late').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AgentAdapterError)
    expect((failure as AgentAdapterError).kind).toBe('already-stopped')
  })

  it('exposes frames in arrival order', async () => {
    const adapter = createFakeAdapter()

    await adapter.start({
      sessionId: 'session-a',
      cwd: '/workspace',
      model: 'a-model',
      prompt: 'do the thing',
    })
    await adapter.sendTurn('a correction')

    const seen: AgentFrame[] = []

    for await (const frame of adapter.output) {
      seen.push(frame)
    }

    expect(seen.map((frame) => frame.type)).toEqual(['system', 'user'])
  })
})

describe('AgentAdapterError', () => {
  it('carries the reason and the underlying cause', () => {
    const cause = new Error('pipe closed')
    const error = new AgentAdapterError('delivery-failed', 'could not write the turn', { cause })

    expect(error.kind).toBe('delivery-failed')
    expect(error.name).toBe('AgentAdapterError')
    expect(error.cause).toBe(cause)
  })
})
