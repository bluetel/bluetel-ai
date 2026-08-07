import { describe, expect, it, vi } from 'vitest'

import type { AgentAdapter, AgentFrame, AgentUsage } from './adapter'
import { createFrameStream } from './frame-stream'
import { createFrameTap, observeAgentFrames } from './frame-tap'

const assistant = (text: string): AgentFrame => ({ type: 'assistant', text })

describe('createFrameTap', () => {
  it('offers every frame to every listener, in arrival order', () => {
    const tap = createFrameTap()
    const first: AgentFrame[] = []
    const second: AgentFrame[] = []

    tap.subscribe({ onFrame: (frame) => first.push(frame) })
    tap.subscribe({ onFrame: (frame) => second.push(frame) })

    tap.observe(assistant('one'))
    tap.observe(assistant('two'))

    expect(first).toEqual([assistant('one'), assistant('two')])
    expect(second).toEqual(first)
  })

  it('stops delivering once a listener unsubscribes', () => {
    const tap = createFrameTap()
    const seen: AgentFrame[] = []
    const stop = tap.subscribe({ onFrame: (frame) => seen.push(frame) })

    tap.observe(assistant('one'))
    stop()
    tap.observe(assistant('two'))

    expect(seen).toEqual([assistant('one')])
  })

  it('tells every listener when the stream closes, once', () => {
    const tap = createFrameTap()
    const onClose = vi.fn()

    tap.subscribe({ onClose })
    tap.close()
    tap.close()

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(tap.isClosed).toBe(true)
  })

  it('delivers nothing after closing', () => {
    const tap = createFrameTap()
    const onFrame = vi.fn()

    tap.subscribe({ onFrame })
    tap.close()
    tap.observe(assistant('too late'))

    expect(onFrame).not.toHaveBeenCalled()
  })

  it('closes a listener that subscribes after the stream has already ended', () => {
    const tap = createFrameTap()

    tap.close()

    const onClose = vi.fn()
    const stop = tap.subscribe({ onClose })

    // Without this a caller would have to check `isClosed` first and race its own subscription.
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(() => {
      stop()
    }).not.toThrow()
  })

  it('does not let one listener’s failure stop another’s frame', () => {
    const tap = createFrameTap()
    const seen: AgentFrame[] = []

    tap.subscribe({
      onFrame: () => {
        throw new Error('this observer is broken')
      },
    })
    tap.subscribe({ onFrame: (frame) => seen.push(frame) })

    expect(() => {
      tap.observe(assistant('one'))
    }).not.toThrow()
    expect(seen).toEqual([assistant('one')])
  })
})

interface FakeAdapter {
  readonly adapter: AgentAdapter
  readonly emit: (frame: AgentFrame) => void
  readonly finish: () => void
  readonly sent: string[]
  usage: AgentUsage
}

const fakeAdapter = (): FakeAdapter => {
  const stream = createFrameStream()
  const sent: string[] = []
  const state: { usage: AgentUsage } = { usage: { turns: 0, spendUsd: 0 } }

  return {
    adapter: {
      start: () => Promise.resolve(),
      sendTurn: (body) => {
        sent.push(body)

        return Promise.resolve({ acknowledged: true, latencyMs: 0 })
      },
      quiesce: () => Promise.resolve({ usage: state.usage, waitedForTurn: false }),
      stop: () => Promise.resolve({ exitCode: 0, signal: null, forced: false }),
      output: stream.iterable,
      get usage() {
        return state.usage
      },
    },
    emit: stream.emit,
    finish: stream.close,
    sent,
    get usage() {
      return state.usage
    },
    set usage(next: AgentUsage) {
      state.usage = next
    },
  }
}

describe('observeAgentFrames', () => {
  it('offers each frame to the tap and still delivers it to the one consumer', async () => {
    const fake = fakeAdapter()
    const tap = createFrameTap()
    const observed: AgentFrame[] = []

    tap.subscribe({ onFrame: (frame) => observed.push(frame) })

    const wrapped = observeAgentFrames(fake.adapter, tap)
    const consumed: AgentFrame[] = []
    const consuming = (async () => {
      for await (const frame of wrapped.output) {
        consumed.push(frame)
      }
    })()

    fake.emit(assistant('one'))
    fake.emit(assistant('two'))
    fake.finish()

    await consuming

    expect(consumed).toEqual([assistant('one'), assistant('two')])
    expect(observed).toEqual(consumed)
  })

  it('closes the tap when the agent’s output ends', async () => {
    const fake = fakeAdapter()
    const tap = createFrameTap()
    const onClose = vi.fn()

    tap.subscribe({ onClose })

    const wrapped = observeAgentFrames(fake.adapter, tap)
    const consuming = (async () => {
      for await (const frame of wrapped.output) {
        expect(frame).toBeDefined()
      }
    })()

    fake.finish()
    await consuming

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(tap.isClosed).toBe(true)
  })

  it('sees nothing while nobody is consuming the output', async () => {
    const fake = fakeAdapter()
    const tap = createFrameTap()
    const onFrame = vi.fn()

    tap.subscribe({ onFrame })

    observeAgentFrames(fake.adapter, tap)
    fake.emit(assistant('buffered, not pulled'))

    await Promise.resolve()

    // Stated as a test because the developer port's deadline depends on it: a tap is not a
    // subscription to the agent, it is a subscription to somebody else's reading of it.
    expect(onFrame).not.toHaveBeenCalled()
  })

  it('delegates the rest of the adapter, and keeps usage live', async () => {
    const fake = fakeAdapter()
    const wrapped = observeAgentFrames(fake.adapter, createFrameTap())

    await wrapped.sendTurn('a correction')
    fake.usage = { turns: 3, spendUsd: 1.5 }

    expect(fake.sent).toEqual(['a correction'])
    expect(wrapped.usage).toEqual({ turns: 3, spendUsd: 1.5 })
    expect(await wrapped.stop({ force: false })).toEqual({
      exitCode: 0,
      signal: null,
      forced: false,
    })
  })
})
