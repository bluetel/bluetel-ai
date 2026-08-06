import { describe, expect, it } from 'vitest'

import * as barrel from './index'

/**
 * The barrel is the directory's public surface, so what it does — and does not — export is a
 * contract in its own right.
 */
describe('the workflows barrel', () => {
  it('exports the two screens a page mounts', () => {
    expect(typeof barrel.WorkflowsPanel).toBe('function')
    expect(typeof barrel.WorkflowDetailPanel).toBe('function')
  })

  it('exports the filter conversions the server page parses with', () => {
    expect(typeof barrel.parseWorkflowFilters).toBe('function')
    expect(typeof barrel.toSearchParams).toBe('function')
    expect(typeof barrel.toListInput).toBe('function')
  })

  it('exports the two named slots, so the log viewer and the controls have somewhere to land', () => {
    expect(typeof barrel.LogViewerSlot).toBe('function')
    expect(typeof barrel.SupervisionSlot).toBe('function')
  })

  it('exports the entry-results card and its shaping function (T108, FR-118)', () => {
    expect(typeof barrel.EntryResultsCard).toBe('function')
    expect(typeof barrel.toEntryResultsReadouts).toBe('function')
  })

  it('exports the page clock, so no consumer needs a second one', () => {
    // `components/admin/fleet` renders these rows too. A second `useNow` there would be a second
    // interval and a second timestamp, and two durations on one screen a second apart.
    expect(typeof barrel.useNow).toBe('function')
    expect(barrel.NOW_TICK_MS).toBeGreaterThan(0)
  })

  it('exports the shaping functions each card is fed from', () => {
    for (const name of [
      'toWorkflowRowReadouts',
      'toWorkflowDetailReadouts',
      'toWorkflowEntryReadouts',
      'toTimelineReadouts',
      'toArtifactReadouts',
    ] as const) {
      expect(typeof barrel[name]).toBe('function')
    }
  })
})
