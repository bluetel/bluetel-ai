import { describe, expect, it } from 'vitest'

import {
  acknowledgeCommandInput,
  acknowledgeCorrectionInput,
  appendLogSegmentInput,
  heartbeatInput,
  registerSnapshotInput,
  reportBootstrapPhaseInput,
  reportExternalActionInput,
  reportIterationInput,
  reportSnapshotParkInput,
  reportTerminalInput,
} from './machine'

const ID = '01890a5d-ac96-774b-bcce-b302099a8057'

describe('the machine inputs', () => {
  it('never carry a workflow id — the credential does (FR-018)', () => {
    for (const schema of [
      heartbeatInput,
      appendLogSegmentInput,
      registerSnapshotInput,
      reportTerminalInput,
      reportBootstrapPhaseInput,
      reportSnapshotParkInput,
    ]) {
      expect(Object.keys(schema.shape)).not.toContain('workflowId')
    }
  })
})

describe('reportSnapshotParkInput', () => {
  const base = { boundary: 'pause', attempt: 1, maxAttempts: 8, nextDelayMs: 1000 }

  it('carries the boundary and the attempt count, so a park is attributable (FR-082)', () => {
    expect(reportSnapshotParkInput.parse(base)).toStrictEqual(base)
  })

  it('accepts a sanitised explanation, and does not demand one', () => {
    expect(reportSnapshotParkInput.parse({ ...base, detail: 'connect ETIMEDOUT' }).detail).toBe(
      'connect ETIMEDOUT',
    )
    expect(reportSnapshotParkInput.parse(base).detail).toBeUndefined()
  })

  it('rejects a zeroth attempt — the report is of an attempt that failed, and they are 1-based', () => {
    expect(reportSnapshotParkInput.safeParse({ ...base, attempt: 0 }).success).toBe(false)
  })

  it('rejects a boundary outside the snapshot vocabulary', () => {
    expect(reportSnapshotParkInput.safeParse({ ...base, boundary: 'checkpoint' }).success).toBe(
      false,
    )
  })
})

describe('heartbeatInput', () => {
  it('carries liveness and consumption together (FR-048)', () => {
    expect(
      heartbeatInput.parse({ state: 'running', turnsUsed: 4, spendUsed: '1.2500' }),
    ).toStrictEqual({ state: 'running', turnsUsed: 4, spendUsed: '1.2500' })
  })

  it('rejects a state outside the workflow vocabulary', () => {
    expect(
      heartbeatInput.safeParse({ state: 'thinking', turnsUsed: 0, spendUsed: '0' }).success,
    ).toBe(false)
  })
})

describe('reportBootstrapPhaseInput', () => {
  it('names the phase, so a timeout points at the step that hung (FR-146)', () => {
    expect(
      reportBootstrapPhaseInput.parse({ phase: 'bundle_verify', outcome: 'timed_out' }),
    ).toMatchObject({ phase: 'bundle_verify', outcome: 'timed_out' })
  })
})

describe('appendLogSegmentInput', () => {
  it('is keyed by sequence, which is what makes a retry idempotent (FR-046)', () => {
    const parsed = appendLogSegmentInput.parse({
      sequence: 12,
      s3Key: 'logs/abc/12.ndjson',
      byteSize: 4096,
      startedAt: new Date(0),
      endedAt: new Date(1000),
    })

    expect(parsed.sequence).toBe(12)
    expect(parsed.startedAt).toBeInstanceOf(Date)
  })

  it('rejects a negative sequence', () => {
    expect(
      appendLogSegmentInput.safeParse({
        sequence: -1,
        s3Key: 'k',
        byteSize: 1,
        startedAt: new Date(0),
        endedAt: new Date(1),
      }).success,
    ).toBe(false)
  })
})

describe('registerSnapshotInput', () => {
  it('requires both state flags — a snapshot missing either is not resumable (FR-053)', () => {
    const base = {
      sessionId: ID,
      s3Key: 'snapshots/abc.tar.zst',
      sizeBytes: 100,
      boundary: 'pause',
    }

    expect(registerSnapshotInput.safeParse({ ...base, hasConversationState: true }).success).toBe(
      false,
    )
    expect(
      registerSnapshotInput.safeParse({
        ...base,
        hasConversationState: true,
        hasWorktreeState: true,
      }).success,
    ).toBe(true)
  })
})

describe('acknowledgeCommandInput', () => {
  it('accepts `superseded`, which is how a pause overtaken by a stop is reported', () => {
    expect(acknowledgeCommandInput.parse({ commandId: ID, outcome: 'superseded' })).toMatchObject({
      outcome: 'superseded',
    })
  })

  it('refuses `pending` — that is the row before anyone answered, not something to report', () => {
    // The database enum carries `pending`; the reportable subset deliberately does not. This is
    // the assertion that keeps the two apart, now that both live in `src/enums/`.
    expect(acknowledgeCommandInput.safeParse({ commandId: ID, outcome: 'pending' }).success).toBe(
      false,
    )
  })
})

describe('acknowledgeCorrectionInput', () => {
  it('refuses `pending` for the same reason, and accepts a recorded failure (FR-049)', () => {
    expect(
      acknowledgeCorrectionInput.safeParse({ correctionId: ID, outcome: 'pending' }).success,
    ).toBe(false)
    expect(
      acknowledgeCorrectionInput.parse({
        correctionId: ID,
        outcome: 'failed',
        failureReason: 'agent had already exited',
      }),
    ).toMatchObject({ outcome: 'failed' })
  })
})

describe('reportExternalActionInput', () => {
  it('requires an idempotency key — a retried comment posting twice is customer-visible', () => {
    const base = {
      kind: 'comment_posted',
      targetReference: 'BTAI-1',
      result: 'succeeded',
      attemptCount: 2,
    }

    expect(reportExternalActionInput.safeParse(base).success).toBe(false)
    expect(reportExternalActionInput.safeParse({ ...base, idempotencyKey: 'k1' }).success).toBe(
      true,
    )
  })
})

describe('reportIterationInput', () => {
  it('bounds the ordinal at three, mirroring the check constraint (FR-061)', () => {
    expect(reportIterationInput.safeParse({ ordinal: 3, verdict: 'fail' }).success).toBe(true)
    expect(reportIterationInput.safeParse({ ordinal: 4, verdict: 'fail' }).success).toBe(false)
    expect(reportIterationInput.safeParse({ ordinal: 0, verdict: 'fail' }).success).toBe(false)
  })

  it('defaults findings to none rather than requiring an empty array', () => {
    expect(reportIterationInput.parse({ ordinal: 1, verdict: 'pass' }).findings).toStrictEqual([])
  })
})

describe('reportTerminalInput', () => {
  it('requires a reason, so a terminal state always says why (FR-064)', () => {
    expect(
      reportTerminalInput.safeParse({
        outcome: 'failed',
        reason: '',
        turnsUsed: 1,
        spendUsed: '1',
      }).success,
    ).toBe(false)
  })

  it('accepts only a terminal outcome', () => {
    expect(
      reportTerminalInput.safeParse({
        outcome: 'running',
        reason: 'still going',
        turnsUsed: 1,
        spendUsed: '1',
      }).success,
    ).toBe(false)
  })
})
