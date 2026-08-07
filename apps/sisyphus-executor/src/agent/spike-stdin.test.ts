import { existsSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { resolveTsxBinary, runStdinInjectionSpike, stubAgentEntry } from './spike-stdin'

describe('spike S1 harness', () => {
  it('finds the runner and the stub entry point', () => {
    expect(existsSync(resolveTsxBinary())).toBe(true)
    expect(existsSync(stubAgentEntry())).toBe(true)
  })
})

describe('spike S1 — NDJSON stdin turn injection', () => {
  it('delivers a turn written mid-request to the in-flight request', async () => {
    const outcome = await runStdinInjectionSpike({
      injectAfterChunks: 2,
      stub: { chunkCount: 10, chunkDelayMs: 30 },
    })

    // The request was genuinely running when the turn was written.
    expect(outcome.chunksBeforeInjection).toBeGreaterThanOrEqual(2)
    expect(outcome.chunksBeforeInjection).toBeLessThan(10)

    // Received before the request finished, not queued behind it.
    expect(outcome.deliveredMidRequest).toBe(true)
    expect(outcome.injectionAcknowledgedAt).toBeLessThan(outcome.firstResultAt)

    // And the same in-flight request changed as a result — arriving during a
    // request and steering it are different claims, and this is the second.
    expect(outcome.behaviourChangedMidRequest).toBe(true)
    expect(outcome.guidedChunkCount).toBeGreaterThan(0)
  }, 30_000)

  it('does not restart the agent process to deliver the turn (FR-044)', async () => {
    const outcome = await runStdinInjectionSpike({
      injectAfterChunks: 2,
      stub: { chunkCount: 8, chunkDelayMs: 30 },
    })

    expect(outcome.childPid).toBeGreaterThan(0)
    expect(outcome.exitedBeforeResult).toBe(false)

    // A restart-per-correction would produce a second result frame for the
    // first request; one result means one uninterrupted conversation.
    expect(outcome.resultFrameCount).toBe(1)
    expect(outcome.exitCode).toBe(0)
  }, 30_000)

  it('records a delivery latency rather than assuming one', async () => {
    const outcome = await runStdinInjectionSpike({
      injectAfterChunks: 2,
      stub: { chunkCount: 8, chunkDelayMs: 30 },
    })

    expect(outcome.injectionLatencyMs).toBeGreaterThanOrEqual(0)
    // The stub acknowledges on receipt, so this measures pipe and scheduling
    // cost only. It is a floor for the real CLI, never an estimate of it.
    expect(outcome.injectionLatencyMs).toBeLessThan(1_000)
  }, 30_000)

  it('keeps every frame it saw, so a failed run can be read rather than guessed at', async () => {
    const outcome = await runStdinInjectionSpike({
      injectAfterChunks: 2,
      stub: { chunkCount: 6, chunkDelayMs: 20, emitUnknownFrame: true },
    })

    expect(outcome.frames.length).toBeGreaterThan(6)
    expect(outcome.frames[0]?.type).toBe('system')
    expect(outcome.frames.every((frame) => frame.raw.length > 0)).toBe(true)

    // An unfamiliar frame is carried through as data, never thrown on.
    expect(outcome.frames.some((frame) => frame.type === 'stub_diagnostic')).toBe(true)
  }, 30_000)
})
