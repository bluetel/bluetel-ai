import { describe, expect, it } from 'vitest'

import * as report from './index'

/**
 * The barrel is the reporting surface, so it is asserted rather than assumed.
 * A removed export is a consumer's build break; noticing it here is cheaper.
 */
describe('the report barrel', () => {
  it('exports the machine-surface client and its transport', () => {
    expect(typeof report.createMachineSurfaceClient).toBe('function')
    expect(typeof report.createHttpMachineTransport).toBe('function')
    expect(typeof report.crossWorkflowSegmentError).toBe('function')
  })

  it('exports the buffering and backoff machinery FR-047 is built from', () => {
    expect(typeof report.createOutbox).toBe('function')
    expect(typeof report.createBackoff).toBe('function')
    expect(report.OutboxFullError.prototype).toBeInstanceOf(Error)
    expect(report.DEFAULT_MAX_ENTRIES).toBeGreaterThan(0)
  })

  it('exports the reviewer summary surface required by FR-153', () => {
    expect(typeof report.buildReviewerSummary).toBe('function')
    expect(typeof report.publishReviewerSummary).toBe('function')
    expect(typeof report.createArtifactSummarySink).toBe('function')
    expect(typeof report.incompleteSummaryError).toBe('function')
  })

  it('exposes no transport internals a consumer could bypass the buffer with', () => {
    expect(Object.keys(report)).not.toContain('createTRPCClient')
    expect(Object.keys(report)).not.toContain('httpLink')
  })
})
