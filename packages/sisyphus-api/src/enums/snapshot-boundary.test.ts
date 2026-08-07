import { describe, expect, it } from 'vitest'

import { isSnapshotBoundary, SNAPSHOT_BOUNDARIES } from './snapshot-boundary'

describe('SNAPSHOT_BOUNDARIES', () => {
  it('names all four reasons the one suspend routine is entered (R3)', () => {
    expect([...SNAPSHOT_BOUNDARIES]).toStrictEqual(['completion', 'pause', 'interruption', 'stop'])
  })

  it('distinguishes an involuntary interruption from a requested stop', () => {
    expect(SNAPSHOT_BOUNDARIES).toContain('interruption')
    expect(SNAPSHOT_BOUNDARIES).toContain('stop')
  })

  it('guards membership', () => {
    expect(isSnapshotBoundary('interruption')).toBe(true)
    expect(isSnapshotBoundary('crash')).toBe(false)
  })
})
