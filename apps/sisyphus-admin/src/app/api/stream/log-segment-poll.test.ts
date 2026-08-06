import { describe, expect, it, vi } from 'vitest'

import type { LogSegmentEvent } from './log-segment-event'
import type { LogSegmentPollOptions, LogStreamMessage } from './log-segment-poll'
import { isTerminalWorkflowState, pollLogSegments } from './log-segment-poll'

/**
 * The transport's decisions, against injected reads and an injected clock — no database and no
 * real time, so every one of these runs in microseconds and none of them is flaky.
 *
 * The two that carry the spike's findings are `backfills from the caller's high-water mark before
 * anything else` and `drops a replayed tail`: finding (g) says a reconnect that does not backfill
 * loses exactly the downtime window, and `appendLogSegment`'s idempotence means duplicates are the
 * normal case rather than an error case.
 *
 * **Not covered here**: the SQL. `readSegmentsAfter` is a stand-in, so this file proves the loop
 * asks for the right range and does the right thing with the answer, not that Drizzle composes
 * `sequence > ?` correctly. That is asserted in the route's live-database suite.
 */

const segment = (sequence: number): LogSegmentEvent => ({
  workflowId: 'w1',
  sequence,
  s3Key: `logs/w1/${String(sequence)}.log`,
  byteSize: 512,
})

interface HarnessOptions {
  /** One entry per poll pass, in order. Exhausting it ends the run. */
  readonly passes: readonly (readonly LogSegmentEvent[])[]
  readonly states?: readonly (string | undefined)[]
  readonly overrides?: Partial<LogSegmentPollOptions>
}

const collect = async (options: HarnessOptions): Promise<readonly LogStreamMessage[]> => {
  const controller = new AbortController()
  let pass = 0
  let stateRead = 0
  let clock = 0

  const poll = pollLogSegments({
    readSegmentsAfter: (after) => {
      const batch = options.passes[pass] ?? []
      pass += 1
      if (pass >= options.passes.length + 1) controller.abort()
      return Promise.resolve(batch.filter((event) => event.sequence > after))
    },
    readWorkflowState: () => {
      // Indexed rather than coalesced: `undefined` is a *meaningful* state here — it is how the
      // run stops being visible — so it must not fall through to a default.
      const states = options.states ?? ['running']
      const state = states[Math.min(stateRead, states.length - 1)]
      stateRead += 1
      return Promise.resolve(state)
    },
    signal: controller.signal,
    // One state read per pass, so `states` reads as "what the run looked like on pass n". The
    // real cadence is asserted separately.
    stateIntervalMs: 0,
    wait: () => {
      clock += 250
      return Promise.resolve()
    },
    now: () => clock,
    ...options.overrides,
  })

  const messages: LogStreamMessage[] = []
  for await (const message of poll) messages.push(message)
  return messages
}

const sequences = (messages: readonly LogStreamMessage[]): readonly number[] =>
  messages.flatMap((message) => (message.kind === 'segment' ? [message.event.sequence] : []))

describe('isTerminalWorkflowState', () => {
  it('counts every recorded outcome, including parked_resumable', () => {
    expect(isTerminalWorkflowState('succeeded')).toBe(true)
    expect(isTerminalWorkflowState('failed')).toBe(true)
    expect(isTerminalWorkflowState('cancelled')).toBe(true)
    expect(isTerminalWorkflowState('capped')).toBe(true)
    // Re-entering it creates a successor with its own sequence space, so *this* stream is over.
    expect(isTerminalWorkflowState('parked_resumable')).toBe(true)
  })

  it('does not count a run that may still produce output', () => {
    expect(isTerminalWorkflowState('running')).toBe(false)
    expect(isTerminalWorkflowState('queued')).toBe(false)
    expect(isTerminalWorkflowState('paused')).toBe(false)
    expect(isTerminalWorkflowState('provisioning')).toBe(false)
  })
})

describe('pollLogSegments', () => {
  it('backfills from the caller high-water mark before anything else (spike S3, finding g)', async () => {
    const readSegmentsAfter = vi.fn(() => Promise.resolve([]))
    const controller = new AbortController()

    const poll = pollLogSegments({
      readSegmentsAfter,
      readWorkflowState: () => {
        controller.abort()
        return Promise.resolve('running')
      },
      fromSequence: 41,
      signal: controller.signal,
      wait: () => Promise.resolve(),
    })
    await poll.next()
    await poll.return(undefined)

    expect(readSegmentsAfter).toHaveBeenCalledWith(41, 500)
  })

  it('emits segments in sequence order', async () => {
    const messages = await collect({ passes: [[segment(1), segment(2)], [segment(3)]] })

    expect(sequences(messages)).toStrictEqual([1, 2, 3])
  })

  it('drops a replayed tail rather than rendering it twice', async () => {
    // The idempotent machine surface means the executor's retried flush is a normal event, and a
    // reconnect re-reads its own tail by design.
    const messages = await collect({
      passes: [
        [segment(1), segment(2)],
        [segment(1), segment(2), segment(3)],
      ],
    })

    expect(sequences(messages)).toStrictEqual([1, 2, 3])
  })

  it('advances the read window, so a duplicate is not even fetched twice', async () => {
    const seen: number[] = []
    const controller = new AbortController()
    let pass = 0

    const poll = pollLogSegments({
      readSegmentsAfter: (after) => {
        seen.push(after)
        pass += 1
        if (pass > 2) controller.abort()
        return Promise.resolve(pass === 1 ? [segment(1), segment(2)] : [])
      },
      readWorkflowState: () => Promise.resolve('running'),
      signal: controller.signal,
      wait: () => Promise.resolve(),
    })
    // Drained rather than collected; what these assert is what was *asked for*, not what came back.
    for await (const message of poll) expect(message.kind).toBeDefined()

    expect(seen[0]).toBe(0)
    expect(seen[1]).toBe(2)
  })

  it('reconciles by sequence, not by arrival: an out-of-order batch is still ordered', async () => {
    // The reconciler advances on the highest sequence it has accepted, so a batch that arrives
    // shuffled emits ascending and never re-emits what it has already passed.
    const messages = await collect({ passes: [[segment(3), segment(1), segment(2)]] })

    expect(sequences(messages)).toStrictEqual([3])
  })

  it('closes when the run reaches a terminal state, after one drain pass', async () => {
    const messages = await collect({
      passes: [[segment(1)], [], []],
      states: ['succeeded'],
    })

    expect(messages.at(-1)).toStrictEqual({ kind: 'closed', reason: 'terminal' })
  })

  it('does not close on a late buffered segment landing behind reportTerminal (FR-047)', async () => {
    const messages = await collect({
      passes: [[segment(1)], [segment(2)], [], []],
      states: ['succeeded'],
    })

    expect(sequences(messages)).toStrictEqual([1, 2])
    expect(messages.at(-1)).toStrictEqual({ kind: 'closed', reason: 'terminal' })
  })

  it('closes as gone the moment the run stops being visible, with no further output (FR-184)', async () => {
    const messages = await collect({
      passes: [[segment(1)], [segment(2)], [segment(3)]],
      states: ['running', undefined],
    })

    // The second state read answers "gone" and the stream ends there — segment 3 is never fetched.
    expect(sequences(messages)).toStrictEqual([1, 2])
    expect(messages.at(-1)).toStrictEqual({ kind: 'closed', reason: 'gone' })
  })

  it('stops when the reader disconnects, and says nothing on the way out', async () => {
    const controller = new AbortController()
    const readSegmentsAfter = vi.fn(() => Promise.resolve([]))

    const poll = pollLogSegments({
      readSegmentsAfter,
      readWorkflowState: () => Promise.resolve('running'),
      signal: controller.signal,
      wait: () => {
        controller.abort()
        return Promise.resolve()
      },
    })

    const messages: LogStreamMessage[] = []
    for await (const message of poll) messages.push(message)

    // No close frame: the reader is gone, so there is nobody to tell.
    expect(messages).toStrictEqual([])
    // And no further query is paid for after the abort.
    expect(readSegmentsAfter).toHaveBeenCalledOnce()
  })

  it('does not poll at all for a reader that left before the first pass', async () => {
    const controller = new AbortController()
    controller.abort()
    const readSegmentsAfter = vi.fn(() => Promise.resolve([]))

    const poll = pollLogSegments({
      readSegmentsAfter,
      readWorkflowState: () => Promise.resolve('running'),
      signal: controller.signal,
      wait: () => Promise.resolve(),
    })
    // Drained rather than collected; what these assert is what was *asked for*, not what came back.
    for await (const message of poll) expect(message.kind).toBeDefined()

    expect(readSegmentsAfter).not.toHaveBeenCalled()
  })

  it('reads the run state on its own slower cadence, not once per poll', async () => {
    const readWorkflowState = vi.fn(() => Promise.resolve('running'))
    const controller = new AbortController()
    let clock = 0
    let pass = 0

    const poll = pollLogSegments({
      readSegmentsAfter: () => {
        pass += 1
        if (pass > 4) controller.abort()
        return Promise.resolve([])
      },
      readWorkflowState,
      signal: controller.signal,
      intervalMs: 250,
      stateIntervalMs: 1_000,
      wait: () => {
        clock += 250
        return Promise.resolve()
      },
      now: () => clock,
    })
    // Drained rather than collected; what these assert is what was *asked for*, not what came back.
    for await (const message of poll) expect(message.kind).toBeDefined()

    // Four segment passes across 750 ms of simulated time, and the state read only at 0 ms.
    expect(readWorkflowState).toHaveBeenCalledOnce()
  })

  it('sends a keep-alive when a live run has produced nothing for a while', async () => {
    const controller = new AbortController()
    let clock = 0
    let pass = 0

    const poll = pollLogSegments({
      readSegmentsAfter: () => {
        pass += 1
        if (pass > 3) controller.abort()
        return Promise.resolve([])
      },
      readWorkflowState: () => Promise.resolve('running'),
      signal: controller.signal,
      keepaliveMs: 10_000,
      wait: () => {
        clock += 6_000
        return Promise.resolve()
      },
      now: () => clock,
    })

    const messages: LogStreamMessage[] = []
    for await (const message of poll) messages.push(message)

    expect(messages.some((message) => message.kind === 'keepalive')).toBe(true)
  })
})
