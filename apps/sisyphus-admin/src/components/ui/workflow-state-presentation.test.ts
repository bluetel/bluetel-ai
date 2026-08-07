import { WORKFLOW_STATES } from '@bluetel-ai/sisyphus-api/client'
import { describe, expect, it } from 'vitest'

import {
  IDLE_PRESENTATION,
  presentationForState,
  readoutForState,
  STATE_TONES,
  WORKFLOW_STATE_PRESENTATION,
} from './workflow-state-presentation'

/**
 * The mapping table from `contracts/design-tokens.md`, restated here as the assertion rather than
 * imported from the implementation — a test that read the same object it is checking would only be
 * proving that an object equals itself.
 */
const CONTRACT_TONES = {
  queued: 'signal',
  provisioning: 'amber',
  running: 'amber',
  paused: 'amber',
  succeeded: 'verdigris',
  failed: 'rust',
  capped: 'rust',
  needs_attention: 'amber',
  parked_resumable: 'graphite',
  cancelled: 'graphite',
}

describe('WORKFLOW_STATE_PRESENTATION', () => {
  it.each(Object.entries(CONTRACT_TONES))(
    'maps %s to %s exactly as the contract says',
    (state, tone) => {
      expect(
        WORKFLOW_STATE_PRESENTATION[state as keyof typeof WORKFLOW_STATE_PRESENTATION].tone,
      ).toBe(tone)
    },
  )

  /**
   * The run-time half of the "a new state must not fall through" guarantee. `satisfies` already
   * fails `tsc` when a member is unmapped; this fails the test suite too, so the property survives
   * the type-level check being loosened.
   */
  it.each(WORKFLOW_STATES)('has an entry for the enum member %s', (state) => {
    expect(Object.keys(WORKFLOW_STATE_PRESENTATION)).toContain(state)
  })

  it('maps every enum member and nothing else, so a stale state cannot linger', () => {
    expect(Object.keys(WORKFLOW_STATE_PRESENTATION).sort()).toStrictEqual(
      [...WORKFLOW_STATES].sort(),
    )
  })

  it.each(WORKFLOW_STATES)('gives %s a tone from the closed set', (state) => {
    expect(STATE_TONES).toContain(WORKFLOW_STATE_PRESENTATION[state].tone)
  })

  it('pulses only for the states in which a machine is actually working', () => {
    const pulsing = Object.entries(WORKFLOW_STATE_PRESENTATION)
      .filter(([, presentation]) => presentation.pulse)
      .map(([state]) => state)
    expect(pulsing.sort()).toStrictEqual(['provisioning', 'running'])
  })

  it('uses the three state colours only for machine state, never for the idle case', () => {
    expect(IDLE_PRESENTATION.tone).toBe('graphite')
    expect(IDLE_PRESENTATION.pulse).toBe(false)
  })
})

describe('presentationForState', () => {
  it.each(WORKFLOW_STATES)('resolves %s to its mapped presentation', (state) => {
    expect(presentationForState(state)).toStrictEqual(WORKFLOW_STATE_PRESENTATION[state])
  })

  it('resolves the absent state to the graphite idle case', () => {
    expect(presentationForState()).toStrictEqual(IDLE_PRESENTATION)
  })
})

describe('readoutForState', () => {
  it('reads a single-word state back unchanged', () => {
    expect(readoutForState('running')).toBe('running')
  })

  it('turns an underscore into a space, leaving the case to the label-mono token', () => {
    expect(readoutForState('needs_attention')).toBe('needs attention')
    expect(readoutForState('parked_resumable')).toBe('parked resumable')
  })

  it('reads the absent state as idle', () => {
    expect(readoutForState()).toBe('idle')
  })
})
