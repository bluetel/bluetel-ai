import type { WorkflowState } from '@bluetel-ai/sisyphus-api/client'
import { describe, expect, it } from 'vitest'

import type { SupervisionCommandResult } from './pending-command'
import {
  alreadyFinishedExplanation,
  isCommandAcknowledged,
  nextPendingCommand,
  supersededNotice,
  toCorrectionReadouts,
} from './pending-command'
import type { PendingSupervisionCommand } from './supervision-status'

/**
 * The half of the "paused" rule that `supervision-status.ts` cannot state on its own.
 *
 * That module proves a queued command can never *become* a pause. This proves the other direction:
 * that a queued command is retired by the executor's acknowledgement and by nothing else — not by
 * the mutation resolving, and not by time passing.
 */

const WORKFLOW_ID = '0199a1f4-0000-7000-8000-0000000000ab'

const queued = (overrides: Partial<SupervisionCommandResult> = {}): SupervisionCommandResult =>
  ({
    applied: true,
    alreadyFinished: false,
    workflowId: WORKFLOW_ID,
    commandId: 'command-1',
    command: 'pause',
    sequence: 1,
    outcome: 'pending',
    supersededCommandIds: [],
    supersededReason: null,
    ...overrides,
  }) as SupervisionCommandResult

const refused = (): SupervisionCommandResult =>
  ({
    applied: false,
    alreadyFinished: true,
    workflowId: WORKFLOW_ID,
    state: 'succeeded',
    terminalOutcome: 'succeeded',
    outcomeReason: null,
    recordedAt: new Date('2026-08-05T09:30:00.000Z'),
    code: 'E_WORKFLOW_ALREADY_FINISHED',
    explanation: 'This run has already succeeded, so the pause was recorded but not applied.',
  }) as SupervisionCommandResult

describe('isCommandAcknowledged — a pause is what the executor did', () => {
  it('does not treat a running run as having performed a requested pause', () => {
    // The whole point. The mutation has resolved, the row is queued, and the agent is still working.
    expect(isCommandAcknowledged({ command: 'pause', workflowState: 'running' })).toBe(false)
  })

  it('treats the recorded paused state as the acknowledgement, because that is what wrote it', () => {
    expect(isCommandAcknowledged({ command: 'pause', workflowState: 'paused' })).toBe(true)
  })

  it('accepts a pause that went straight on to park (FR-050)', () => {
    expect(isCommandAcknowledged({ command: 'pause', workflowState: 'parked_resumable' })).toBe(
      true,
    )
  })

  it('retires a resume only once the run is no longer held', () => {
    expect(isCommandAcknowledged({ command: 'resume', workflowState: 'paused' })).toBe(false)
    expect(isCommandAcknowledged({ command: 'resume', workflowState: 'parked_resumable' })).toBe(
      false,
    )
    expect(isCommandAcknowledged({ command: 'resume', workflowState: 'running' })).toBe(true)
    // A resume out of a park re-enters provisioning before it runs (FR-151).
    expect(isCommandAcknowledged({ command: 'resume', workflowState: 'provisioning' })).toBe(true)
  })

  it('retires a stop only on a terminal state, never on the acknowledgement alone', () => {
    // `stateAfterAcknowledgement` moves nothing for a stop: `reportTerminal` writes the outcome.
    expect(isCommandAcknowledged({ command: 'stop', workflowState: 'running' })).toBe(false)
    expect(isCommandAcknowledged({ command: 'stop', workflowState: 'paused' })).toBe(false)
    expect(isCommandAcknowledged({ command: 'stop', workflowState: 'cancelled' })).toBe(true)
  })

  it('retires anything against a run that has ended', () => {
    const ended: readonly WorkflowState[] = [
      'succeeded',
      'failed',
      'capped',
      'cancelled',
      'needs_attention',
    ]

    for (const workflowState of ended) {
      expect(isCommandAcknowledged({ command: 'pause', workflowState })).toBe(true)
    }
  })
})

describe('nextPendingCommand — what the panel waits on', () => {
  it('waits on a command the server queued', () => {
    expect(
      nextPendingCommand({
        held: undefined,
        command: 'pause',
        result: queued(),
        requestedAt: 1_000,
      }),
    ).toStrictEqual({ command: 'pause', requestedAt: 1_000 })
  })

  it('waits on nothing when the run had already finished (FR-081)', () => {
    expect(
      nextPendingCommand({
        held: undefined,
        command: 'pause',
        result: refused(),
        requestedAt: 1_000,
      }),
    ).toBeUndefined()
  })

  it('keeps waiting on the stop when the pause was superseded on arrival', () => {
    // quickstart Scenario 5: the pause comes back `superseded` and is never applied, so claiming it
    // is queued would be the same false claim one step earlier.
    const held: PendingSupervisionCommand = { command: 'stop', requestedAt: 500 }

    expect(
      nextPendingCommand({
        held,
        command: 'pause',
        result: queued({ outcome: 'superseded', supersededReason: 'overtaken by a stop' }),
        requestedAt: 1_000,
      }),
    ).toBe(held)
  })

  it('waits on nothing when the platform applied the command itself (003/FR-027)', () => {
    // A `stop` against a run waiting for an agent credential is applied in the same transaction
    // that answered it — there is no executor to collect it and the run is already terminal. A
    // "stop requested" card here would invite somebody to press it again.
    expect(
      nextPendingCommand({
        held: undefined,
        command: 'stop',
        result: queued({ command: 'stop', outcome: 'acknowledged' }),
        requestedAt: 1_000,
      }),
    ).toBeUndefined()
  })
})

describe('what the server said, verbatim', () => {
  it('hands back the already-finished sentence rather than a rewrite of it', () => {
    expect(alreadyFinishedExplanation(refused())).toContain('recorded but not applied')
    expect(alreadyFinishedExplanation(queued())).toBeUndefined()
  })

  it('surfaces a supersession reason rather than dropping it', () => {
    expect(
      supersededNotice(queued({ outcome: 'superseded', supersededReason: 'overtaken by a stop' })),
    ).toBe('overtaken by a stop')
    expect(supersededNotice(queued())).toBeUndefined()
    expect(supersededNotice(refused())).toBeUndefined()
  })
})

describe('toCorrectionReadouts', () => {
  const record = (overrides: Record<string, unknown> = {}) => ({
    id: 'correction-1',
    sequence: 1,
    body: 'prefer the existing helper',
    authorUserId: 'user-1',
    deliveryOutcome: 'delivered' as const,
    deliveredAt: new Date('2026-08-05T09:05:00.000Z'),
    failureReason: null,
    submittedAt: new Date('2026-08-05T09:00:00.000Z'),
    ...overrides,
  })

  it('keeps every correction, including the ones that never landed (FR-049, SC-004)', () => {
    const readouts = toCorrectionReadouts([
      record(),
      record({
        id: 'correction-2',
        sequence: 2,
        deliveryOutcome: 'failed',
        deliveredAt: null,
        failureReason: 'the turn was written but never echoed back',
      }),
    ])

    expect(readouts).toHaveLength(2)
    expect(readouts[1]?.outcome).toBe('failed')
    expect(readouts[1]?.failureReason).toBe('the turn was written but never echoed back')
  })

  it('formats the timestamp, because the list holds no clock', () => {
    expect(toCorrectionReadouts([record()])[0]?.submittedAt).not.toBe('')
    expect(typeof toCorrectionReadouts([record()])[0]?.submittedAt).toBe('string')
  })
})
