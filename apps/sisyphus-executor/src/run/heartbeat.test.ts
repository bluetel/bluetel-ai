import { describe, expect, it } from 'vitest'

import type { AgentUsage } from '../agent'
import type { HeartbeatInput } from '../report'
import { parkAndRetry, SnapshotBoundaryUnpersistedError } from '../session'

import { createHeartbeatLoop, HEARTBEAT_INTERVAL_MS } from './heartbeat'
import type { HeartbeatState } from './heartbeat'

/**
 * The heartbeat loop (FR-048).
 *
 * No network and no clock: the transport is a recording fake and `sleep` is injected, so the loop
 * is stepped rather than waited on.
 */

const usage = (turns: number, spendUsd: number): AgentUsage => ({ turns, spendUsd })

interface Harness {
  readonly sent: HeartbeatInput[]
  readonly client: { readonly heartbeat: (input: HeartbeatInput) => Promise<void> }
  readonly failNext: (count: number) => void
}

const harness = (): Harness => {
  const sent: HeartbeatInput[] = []
  let failures = 0

  return {
    sent,
    failNext: (count: number) => {
      failures = count
    },
    client: {
      heartbeat: async (input) => {
        if (failures > 0) {
          failures -= 1

          return Promise.reject(new Error('the machine surface is unreachable'))
        }

        sent.push(input)

        return Promise.resolve()
      },
    },
  }
}

describe('createHeartbeatLoop', () => {
  it('beats with the current state and consumption', async () => {
    const world = harness()
    const loop = createHeartbeatLoop({
      client: world.client,
      state: () => 'running',
      usage: () => usage(4, 1.5),
    })

    await expect(loop.beat()).resolves.toBe(true)

    expect(world.sent).toStrictEqual([{ state: 'running', turnsUsed: 4, spendUsed: '1.5000' }])
    expect(loop.beats).toBe(1)
  })

  it('reads the state at every beat, so a pause is reported as a pause', async () => {
    const world = harness()
    let state: HeartbeatState = 'running'
    const loop = createHeartbeatLoop({
      client: world.client,
      state: () => state,
      usage: () => usage(0, 0),
    })

    await loop.beat()
    state = 'paused'
    await loop.beat()

    expect(world.sent.map((input) => input.state)).toStrictEqual(['running', 'paused'])
  })

  it('counts a failed beat and carries on, because a blip is not a dead run', async () => {
    const world = harness()
    const seen: number[] = []
    const loop = createHeartbeatLoop({
      client: world.client,
      state: () => 'running',
      usage: () => usage(0, 0),
      onFailure: (_error, consecutive) => seen.push(consecutive),
    })

    world.failNext(2)

    await expect(loop.beat()).resolves.toBe(false)
    await expect(loop.beat()).resolves.toBe(false)
    await expect(loop.beat()).resolves.toBe(true)

    expect(seen).toStrictEqual([1, 2])
    expect(loop.failures).toBe(2)
    expect(loop.beats).toBe(1)
    expect(loop.consecutiveFailures).toBe(0)
  })

  it('beats immediately rather than after the first interval', async () => {
    const world = harness()
    const slept: number[] = []
    const loop = createHeartbeatLoop({
      client: world.client,
      state: () => 'running',
      usage: () => usage(0, 0),
      sleep: async (milliseconds) => {
        slept.push(milliseconds)
        loop.stop().catch(() => undefined)

        return Promise.resolve()
      },
    })

    await loop.run()

    expect(world.sent).toHaveLength(1)
    expect(slept).toStrictEqual([HEARTBEAT_INTERVAL_MS])
  })

  it('runs until it is stopped, and stop() waits for the loop to leave', async () => {
    const world = harness()
    let ticks = 0
    const loop = createHeartbeatLoop({
      client: world.client,
      state: () => 'running',
      usage: () => usage(0, 0),
      intervalMs: 1,
      sleep: async () => {
        ticks += 1

        if (ticks === 3) {
          loop.stop().catch(() => undefined)
        }

        return Promise.resolve()
      },
    })

    const running = loop.run()
    await running

    expect(loop.isRunning()).toBe(false)
    expect(world.sent).toHaveLength(3)
  })

  /**
   * **FR-082's other half: a parked run must not stop beating.**
   *
   * If the heartbeat stopped for the duration of a park, the reconciler would see a lapse and
   * sweep the run — destroying an instance that is alive, holding a quiesced agent, and waiting on
   * object storage. That would turn a recoverable storage blip into lost work, which is the exact
   * outcome parking exists to prevent.
   *
   * The property is structural — the loop is its own task and `parkAndRetry` suspends only the
   * caller that awaited it — but "structural" is what people say about things that later acquire a
   * synchronous wait. So it is asserted directly, and asserted **during** the park rather than
   * after it: the beat count is sampled from inside the retried operation itself, so a loop that
   * only resumed once the park had finished would fail here.
   *
   * Real timers, deliberately. The whole question is whether two independent tasks interleave on
   * the event loop, and a fake clock stepped by one of them cannot answer it.
   */
  it('keeps beating throughout a parked snapshot boundary (FR-082, FR-048)', async () => {
    const world = harness()
    const loop = createHeartbeatLoop({
      client: world.client,
      // What a heartbeat says during a park: the run is still `running`. The pause has been asked
      // for and not performed, and `supervision-status.ts` forbids the panel claiming otherwise.
      state: () => 'running',
      usage: () => usage(0, 0),
      intervalMs: 2,
    })

    const beating = loop.run()
    const beatsAtAttempt: number[] = []

    await expect(
      parkAndRetry({
        boundary: 'pause',
        budget: { maxAttempts: 4, initialDelayMs: 20, maxDelayMs: 20, factor: 1 },
        operation: () => {
          beatsAtAttempt.push(world.sent.length)

          return Promise.reject(new Error('the snapshot bucket is unreachable'))
        },
      }),
    ).rejects.toBeInstanceOf(SnapshotBoundaryUnpersistedError)

    await loop.stop()
    await beating

    expect(beatsAtAttempt).toHaveLength(4)

    const [first] = beatsAtAttempt
    const last = beatsAtAttempt[beatsAtAttempt.length - 1]

    // Beats landed between the first failed attempt and the last one — i.e. while the run was
    // parked, not merely before it parked and after it gave up.
    expect(last).toBeGreaterThan(first)
    // And the count is not a rounding artefact: three 20ms waits against a 2ms interval is tens of
    // beats, so anything in single figures would mean the loop had been starved.
    expect(last - first).toBeGreaterThanOrEqual(10)
  })

  it('uses one interval that is well inside the control plane’s lapse window', () => {
    // Five minutes is HEARTBEAT_LAPSE_MS in the control plane's reconciler. Ten beats fit inside
    // it, so a single missed beat can never be mistaken for a dead instance.
    expect(HEARTBEAT_INTERVAL_MS * 10).toBeLessThanOrEqual(5 * 60 * 1000)
  })
})
