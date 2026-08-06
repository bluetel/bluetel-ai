import { describe, expect, it } from 'vitest'

import type { AgentFrame } from './adapter'
import { createFrameStream } from './frame-stream'

const assistant = (text: string): AgentFrame => ({ type: 'assistant', text })

const collect = async (iterable: AsyncIterable<AgentFrame>): Promise<AgentFrame[]> => {
  const frames: AgentFrame[] = []

  for await (const frame of iterable) {
    frames.push(frame)
  }

  return frames
}

describe('createFrameStream — iteration', () => {
  it('buffers frames emitted before anyone iterates', async () => {
    const stream = createFrameStream()

    stream.emit(assistant('one'))
    stream.emit(assistant('two'))
    stream.close()

    expect(await collect(stream.iterable)).toEqual([assistant('one'), assistant('two')])
  })

  it('delivers frames to a consumer already waiting on next()', async () => {
    const stream = createFrameStream()
    const collected = collect(stream.iterable)

    await Promise.resolve()
    stream.emit(assistant('live'))
    stream.close()

    expect(await collected).toEqual([assistant('live')])
  })

  it('completes the iterator when the stream closes', async () => {
    const stream = createFrameStream()
    const iterator = stream.iterable[Symbol.asyncIterator]()
    const pending = iterator.next()

    stream.close()

    expect(await pending).toEqual({ value: undefined, done: true })
    expect(stream.isClosed).toBe(true)
  })

  it('ignores frames emitted after close rather than resurrecting the stream', async () => {
    const stream = createFrameStream()

    stream.close()
    stream.emit(assistant('too late'))

    expect(await collect(stream.iterable)).toEqual([])
  })
})

describe('createFrameStream — waiting', () => {
  it('settles a waiter without any consumer iterating', async () => {
    const stream = createFrameStream()
    const waiting = stream.waitFor((frame) => frame.type === 'result', 1_000)

    stream.emit(assistant('noise'))
    stream.emit({
      type: 'result',
      subtype: 'success',
      isError: false,
      usage: { turns: 1, spendUsd: 0 },
    })

    const outcome = await waiting

    expect(outcome.kind).toBe('matched')
  })

  it('considers only frames emitted after the wait began', async () => {
    const stream = createFrameStream()

    stream.emit(assistant('history'))

    const waiting = stream.waitFor(
      (frame) => frame.type === 'assistant' && frame.text === 'history',
      50,
    )

    expect((await waiting).kind).toBe('timed-out')
  })

  it('reports a timeout as a value rather than a rejection', async () => {
    const stream = createFrameStream()
    const outcome = await stream.waitFor(() => false, 20)

    expect(outcome.kind).toBe('timed-out')
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(0)
  })

  it('settles every outstanding waiter when the stream closes', async () => {
    const stream = createFrameStream()
    const first = stream.waitFor(() => false, 5_000)
    const second = stream.waitFor(() => false, 5_000)

    stream.close()

    expect((await first).kind).toBe('closed')
    expect((await second).kind).toBe('closed')
  })

  it('reports closed immediately for a wait started after close', async () => {
    const stream = createFrameStream()

    stream.close()

    expect((await stream.waitFor(() => true, 5_000)).kind).toBe('closed')
  })

  it('tells two identical frames apart by when the wait started', async () => {
    const stream = createFrameStream()

    stream.emit({ type: 'user', text: 'same body' })

    const waiting = stream.waitFor(
      (frame) => frame.type === 'user' && frame.text === 'same body',
      1_000,
    )

    stream.emit({ type: 'user', text: 'same body' })

    expect((await waiting).kind).toBe('matched')
  })

  it('measures how long a wait took using the injected clock', async () => {
    let clock = 1_000
    const stream = createFrameStream({ now: () => clock })
    const waiting = stream.waitFor((frame) => frame.type === 'result', 1_000)

    clock = 1_250
    stream.emit({
      type: 'result',
      subtype: 'success',
      isError: false,
      usage: { turns: 1, spendUsd: 0 },
    })

    expect((await waiting).waitedMs).toBe(250)
  })
})
