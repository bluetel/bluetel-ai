import { describe, expect, it } from 'vitest'

import { createSecretRegistry } from './secret-registry'
import { buildSecretIndex } from './secret-values'

/**
 * 003/T054. The registry's contract is two sentences long and both of them are
 * load-bearing:
 *
 * - a value added after construction is redacted from then on, which is the
 *   whole reason this exists (FR-014, a credential rotated mid-run);
 * - the array reference is stable until something is added, which is what stops
 *   `buildSecretIndex` re-expanding every value into every encoding on every
 *   chunk of agent output.
 */

/** Synthetic throughout. Nothing here belongs to any real service. */
const INSTALLED = 'not-a-real-agent-credential-installed-0001'
const ROTATED = 'not-a-real-agent-credential-rotated-0002'

describe('createSecretRegistry', () => {
  it('starts from the values already known', () => {
    const registry = createSecretRegistry([{ name: 'bundle-credential', value: INSTALLED }])

    expect(registry.current()).toStrictEqual([{ name: 'bundle-credential', value: INSTALLED }])
  })

  it('is empty when nothing is known yet', () => {
    expect(createSecretRegistry().current()).toStrictEqual([])
  })

  it('keeps the same array until something is added', () => {
    const registry = createSecretRegistry([{ name: 'agent-credential', value: INSTALLED }])
    const before = registry.current()

    expect(registry.current()).toBe(before)

    registry.add({ name: 'agent-credential', value: ROTATED })

    expect(registry.current()).not.toBe(before)
  })

  it('does not churn the array when the same pair is added twice', () => {
    const registry = createSecretRegistry()

    registry.add({ name: 'agent-credential', value: ROTATED })

    const after = registry.current()

    registry.add({ name: 'agent-credential', value: ROTATED })

    expect(registry.current()).toBe(after)
    expect(registry.current()).toHaveLength(1)
  })

  it('keeps the same value under a second name, because the names are what an operator reads', () => {
    const registry = createSecretRegistry()

    registry.add({ name: 'agent-credential', value: ROTATED })
    registry.add({ name: 'forge-credential', value: ROTATED })

    expect(registry.current()).toHaveLength(2)
  })

  /**
   * The registry and the index are only useful together, so the seam between
   * them is asserted here rather than left to the two unit tests either side of
   * it: an index built over `registry.current` must notice an addition made
   * after it was built, without being rebuilt by its caller.
   */
  it('feeds an index that picks up a value added after it was built', () => {
    const registry = createSecretRegistry()
    const index = buildSecretIndex(registry.current)

    expect(index.isEmpty).toBe(true)
    expect(index.redact(ROTATED)).toBe(ROTATED)

    registry.add({ name: 'agent-credential', value: ROTATED })

    expect(index.isEmpty).toBe(false)
    expect(index.redact(ROTATED)).toBe('[redacted:agent-credential]')
    expect(index.longestMatchLength).toBeGreaterThan(ROTATED.length)
  })
})
