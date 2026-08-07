import { describe, expect, it, vi } from 'vitest'

import { createBackoff } from './backoff'
import { createOutbox, DEFAULT_MAX_ENTRIES, OutboxFullError } from './outbox'

/**
 * The injected sleeper: records what it was asked to wait and yields
 * immediately.
 *
 * It yields through a timer rather than through a resolved promise. A retry
 * loop whose sleep only awaits a resolved promise never lets the event loop
 * turn, so a test holding a permanently failing call would starve its own
 * assertions — a property of the test harness, not of the outbox, but one worth
 * stating because getting it wrong looks exactly like a deadlock in the code.
 */
const recordingSleeper = (): { readonly waits: number[]; readonly sleep: () => Promise<void> } => {
  const waits: number[] = []

  return {
    waits,
    sleep: async (milliseconds = 0): Promise<void> => {
      waits.push(milliseconds)

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0)
      })
    },
  }
}

/** Lets a test hold a call failing and then release it, so no loop outlives the test. */
const blocker = (): {
  readonly send: (onLand: () => void) => () => Promise<void>
  release: () => void
} => {
  const state = { released: false }

  return {
    send: (onLand: () => void) => async (): Promise<void> => {
      if (!state.released) {
        throw new Error('machine surface unreachable')
      }

      onLand()

      await Promise.resolve()
    },
    release: () => {
      state.released = true
    },
  }
}

/** Give the retry loop a turn of the event loop. */
const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

const fixedBackoff = createBackoff({ initialDelayMs: 10, factor: 2, random: () => 1 })

describe('createOutbox', () => {
  it('delivers accepted calls in order', async () => {
    const seen: string[] = []
    const outbox = createOutbox({ sleep: recordingSleeper().sleep })

    await Promise.all(
      ['a', 'b', 'c'].map(async (name) =>
        outbox.enqueue({
          procedure: name,
          send: async () => {
            seen.push(name)

            await Promise.resolve()
          },
        }),
      ),
    )

    expect(seen).toEqual(['a', 'b', 'c'])
    expect(outbox.pending).toBe(0)
  })

  it('retries a failing call with backoff until it lands, keeping the same payload', async () => {
    const sleeper = recordingSleeper()
    const outbox = createOutbox({ sleep: sleeper.sleep, backoff: fixedBackoff })
    const attempts: number[] = []
    let calls = 0

    await outbox.enqueue({
      procedure: 'appendLogSegment',
      send: async () => {
        calls += 1
        attempts.push(calls)

        if (calls < 4) {
          throw new Error('machine surface unreachable')
        }

        await Promise.resolve()
      },
    })

    expect(attempts).toEqual([1, 2, 3, 4])
    expect(sleeper.waits).toEqual([10, 20, 40])
  })

  it('does not advance past an unsent record, so the log cannot gain a hole', async () => {
    const sleeper = recordingSleeper()
    const outbox = createOutbox({ sleep: sleeper.sleep, backoff: fixedBackoff })
    const delivered: number[] = []
    let firstAttempts = 0

    const first = outbox.enqueue({
      procedure: 'appendLogSegment',
      send: async () => {
        firstAttempts += 1

        if (firstAttempts < 3) {
          throw new Error('unreachable')
        }

        delivered.push(1)

        await Promise.resolve()
      },
    })

    const second = outbox.enqueue({
      procedure: 'appendLogSegment',
      send: async () => {
        delivered.push(2)

        await Promise.resolve()
      },
    })

    await Promise.all([first, second])

    expect(delivered).toEqual([1, 2])
  })

  it('refuses the newest call when full and never discards an accepted one', async () => {
    const sleeper = recordingSleeper()
    const outbox = createOutbox({ maxEntries: 2, sleep: sleeper.sleep, backoff: fixedBackoff })
    const landed: string[] = []
    const held = blocker()

    const first = outbox.enqueue({
      procedure: 'first',
      send: held.send(() => landed.push('first')),
    })
    const second = outbox.enqueue({
      procedure: 'second',
      send: held.send(() => landed.push('second')),
    })

    await settle()

    await expect(
      outbox.enqueue({ procedure: 'third', send: held.send(() => landed.push('third')) }),
    ).rejects.toBeInstanceOf(OutboxFullError)

    expect(outbox.isSaturated).toBe(true)

    held.release()
    await Promise.all([first, second])

    // Both accepted records landed; only the refused one was never taken on.
    expect(landed).toEqual(['first', 'second'])
  })

  it('names the refused procedure and the bound in the error', async () => {
    const outbox = createOutbox({ maxEntries: 1, sleep: recordingSleeper().sleep })
    const held = blocker()
    const accepted = outbox.enqueue({
      procedure: 'appendLogSegment',
      send: held.send(() => undefined),
    })

    await settle()

    const refused = await outbox
      .enqueue({ procedure: 'registerArtifact', send: async () => Promise.resolve() })
      .catch((error: unknown) => error)

    expect(refused).toBeInstanceOf(OutboxFullError)
    expect((refused as OutboxFullError).procedure).toBe('registerArtifact')
    expect((refused as OutboxFullError).maxEntries).toBe(1)
    expect((refused as OutboxFullError).message).toContain('registerArtifact')
    expect((refused as OutboxFullError).message).toContain('1')

    held.release()
    await accepted
  })

  it('reports saturation once, so the run can mark reporting degraded', async () => {
    const onSaturated = vi.fn()
    const outbox = createOutbox({ maxEntries: 1, sleep: recordingSleeper().sleep, onSaturated })
    const held = blocker()
    const accepted = outbox.enqueue({
      procedure: 'appendLogSegment',
      send: held.send(() => undefined),
    })

    await settle()

    await expect(
      outbox.enqueue({ procedure: 'a', send: async () => Promise.resolve() }),
    ).rejects.toBeInstanceOf(OutboxFullError)
    await expect(
      outbox.enqueue({ procedure: 'b', send: async () => Promise.resolve() }),
    ).rejects.toBeInstanceOf(OutboxFullError)

    expect(onSaturated).toHaveBeenCalledTimes(1)
    expect(onSaturated).toHaveBeenCalledWith({
      procedure: 'a',
      pending: 1,
      maxEntries: 1,
    })

    held.release()
    await accepted
  })

  it('drains everything held, including calls accepted while a drain was running', async () => {
    const outbox = createOutbox({ sleep: recordingSleeper().sleep })
    const seen: string[] = []

    void outbox.enqueue({
      procedure: 'first',
      send: async () => {
        seen.push('first')
        void outbox.enqueue({
          procedure: 'second',
          send: async () => {
            seen.push('second')

            await Promise.resolve()
          },
        })

        await Promise.resolve()
      },
    })

    await outbox.drain()

    expect(seen).toEqual(['first', 'second'])
    expect(outbox.pending).toBe(0)
  })

  it('bounds the buffer by default rather than growing without limit', () => {
    expect(DEFAULT_MAX_ENTRIES).toBeGreaterThan(0)
    expect(Number.isFinite(DEFAULT_MAX_ENTRIES)).toBe(true)
  })
})
