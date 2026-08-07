import { describe, expect, it } from 'vitest'

import * as stream from './index'

/**
 * The barrel keeps the production transport and the spike's measurement harness in one directory,
 * which is only safe while the boundary is visible. This asserts both halves are reachable and,
 * more usefully, that the production loop is not accidentally the spike's — they were written to
 * emit the same {@link stream.LogSegmentEvent} on purpose, so a wrong import would type-check.
 */
describe('the stream barrel', () => {
  it('exposes the production transport', () => {
    expect(typeof stream.pollLogSegments).toBe('function')
    expect(typeof stream.decideLogStreamAccess).toBe('function')
    expect(typeof stream.resolveResumePoint).toBe('function')
    expect(typeof stream.readSegmentText).toBe('function')
    expect(typeof stream.formatSseFrame).toBe('function')
  })

  it('keeps the spike harness reachable, so SPIKE-FINDINGS.md stays reproducible', () => {
    expect(typeof stream.runTransportScenario).toBe('function')
    expect(typeof stream.seedSpikeFixture).toBe('function')
  })

  it('names the two poll intervals apart, so a route cannot import the spike one by accident', () => {
    expect(stream.LOG_POLL_INTERVAL_MS).toBe(250)
    expect(stream.DEFAULT_POLL_INTERVAL_MS).toBe(250)
    expect(Object.keys(stream)).toContain('LOG_POLL_INTERVAL_MS')
  })

  it('shares one reconciler between the transport and the viewer', () => {
    // The viewer reconciles the SSE stream with the same high-water-mark rule the server uses. Two
    // implementations would be two opinions about what a duplicate is.
    const reconciler = stream.createSequenceReconciler(2)

    expect(reconciler.accept({ workflowId: 'w1', sequence: 2, s3Key: 'k', byteSize: 1 })).toBe(
      'duplicate',
    )
    expect(reconciler.accept({ workflowId: 'w1', sequence: 3, s3Key: 'k', byteSize: 1 })).toBe(
      'emit',
    )
  })
})
