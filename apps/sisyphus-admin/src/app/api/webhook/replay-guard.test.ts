import { describe, expect, it } from 'vitest'

import { createMemoryReplayStore } from './replay-guard'
import { REPLAY_WINDOW_MS } from './verify-signature'

describe('createMemoryReplayStore (T122)', () => {
  it('claims a signature once', async () => {
    const store = createMemoryReplayStore()

    expect(await store.claim('v1=abc', 0)).toBe(true)
    expect(await store.claim('v1=abc', 1)).toBe(false)
  })

  it('claims different signatures independently', async () => {
    const store = createMemoryReplayStore()

    expect(await store.claim('v1=abc', 0)).toBe(true)
    expect(await store.claim('v1=def', 0)).toBe(true)
  })

  it('forgets a signature once it is older than the window', async () => {
    const store = createMemoryReplayStore()

    await store.claim('v1=abc', 0)

    // Safe to forget: a delivery this old is refused by the timestamp check before it reaches here.
    expect(await store.claim('v1=abc', REPLAY_WINDOW_MS + 1)).toBe(true)
  })

  it('still refuses a signature inside the window', async () => {
    const store = createMemoryReplayStore()

    await store.claim('v1=abc', 0)

    expect(await store.claim('v1=abc', REPLAY_WINDOW_MS - 1)).toBe(false)
  })

  it('stays bounded rather than remembering every delivery ever received', async () => {
    const store = createMemoryReplayStore(10)

    for (let index = 0; index < 1000; index += 1) {
      await store.claim(`v1=${String(index)}`, index)
    }

    // Everything from the start of the run has been swept, so the earliest signature is claimable.
    expect(await store.claim('v1=0', 1000)).toBe(true)
  })

  it('honours a caller-supplied window', async () => {
    const store = createMemoryReplayStore(5)

    await store.claim('v1=abc', 0)

    expect(await store.claim('v1=abc', 6)).toBe(true)
  })
})
