import { WORKFLOW_STATES } from '@bluetel-ai/sisyphus-api/client'
import { describe, expect, it } from 'vitest'

import {
  acceptsCorrections,
  availableSupervisionActions,
  isAwaitingExecutor,
  isConfirmedPause,
  supervisionAction,
  supervisionReadout,
  supervisionStatus,
} from './supervision-status'

/**
 * The requirement, asserted where it lives.
 *
 * "The panel reports paused only once the executor has acknowledged" is a rule about a *derivation*,
 * not about markup, so it is proved here — with the negative case first, because the way this gets
 * broken is by an implementation that treats a queued command as an accomplished one.
 */

describe('supervisionStatus — the one rule', () => {
  it('does not say paused while the pause is only requested', () => {
    const status = supervisionStatus({
      workflowState: 'running',
      pendingCommand: { command: 'pause', requestedAt: Date.now() },
    })

    expect(status).toBe('pause-requested')
    expect(isConfirmedPause(status)).toBe(false)
    expect(supervisionReadout(status).chip).not.toBe('PAUSED')
  })

  it('says paused only when the recorded state says so and nothing is queued', () => {
    const status = supervisionStatus({ workflowState: 'paused' })

    expect(status).toBe('paused')
    expect(isConfirmedPause(status)).toBe(true)
    expect(supervisionReadout(status).chip).toBe('PAUSED')
  })

  it('has no input at all that turns a pending pause into a confirmed one', () => {
    // Every workflow state, with a pause queued. None of them may read as paused: the row exists,
    // and the instance has not acted on it.
    for (const workflowState of WORKFLOW_STATES) {
      const status = supervisionStatus({
        workflowState,
        pendingCommand: { command: 'pause', requestedAt: 0 },
      })

      expect(isConfirmedPause(status)).toBe(false)
    }
  })

  it('says in plain words that the agent is still working while a pause is queued', () => {
    const explanation = supervisionReadout('pause-requested').explanation

    expect(explanation).toContain('has not performed it yet')
    expect(explanation).toContain('still working')
  })
})

describe('supervisionStatus — the rest of the derivation', () => {
  it('reports a live run as live', () => {
    expect(supervisionStatus({ workflowState: 'running' })).toBe('live')
    expect(supervisionStatus({ workflowState: 'provisioning' })).toBe('live')
  })

  it('lets a terminal state win over a queued command (FR-081)', () => {
    // The request was recorded and not applied; saying "stop requested" would imply it will be.
    expect(
      supervisionStatus({
        workflowState: 'succeeded',
        pendingCommand: { command: 'stop', requestedAt: 0 },
      }),
    ).toBe('finished')
  })

  it('distinguishes parked from finished, because a parked run can be resumed (FR-151)', () => {
    expect(supervisionStatus({ workflowState: 'parked_resumable' })).toBe('parked')
    expect(supervisionStatus({ workflowState: 'cancelled' })).toBe('finished')
  })

  it('names the queued command for a resume and a stop as well as a pause', () => {
    expect(
      supervisionStatus({
        workflowState: 'paused',
        pendingCommand: { command: 'resume', requestedAt: 0 },
      }),
    ).toBe('resume-requested')
    expect(
      supervisionStatus({
        workflowState: 'running',
        pendingCommand: { command: 'stop', requestedAt: 0 },
      }),
    ).toBe('stop-requested')
  })

  it('knows which statuses are waiting on the instance', () => {
    expect(isAwaitingExecutor('pause-requested')).toBe(true)
    expect(isAwaitingExecutor('stop-requested')).toBe(true)
    expect(isAwaitingExecutor('paused')).toBe(false)
    expect(isAwaitingExecutor('live')).toBe(false)
  })

  it('reads every status, with no fallback to get wrong', () => {
    const statuses = [
      'live',
      'pause-requested',
      'resume-requested',
      'stop-requested',
      'paused',
      'parked',
      'finished',
    ] as const

    for (const status of statuses) {
      expect(supervisionReadout(status).chip.length).toBeGreaterThan(0)
      expect(supervisionReadout(status).explanation.length).toBeGreaterThan(0)
    }
  })
})

describe('availableSupervisionActions', () => {
  it('offers pause and stop on a live run', () => {
    expect(availableSupervisionActions('live').map((action) => action.kind)).toStrictEqual([
      'pause',
      'stop',
    ])
  })

  it('keeps stop available while a pause is queued', () => {
    // The moment an operator most needs to be able to stop a run is while a pause has not landed.
    expect(availableSupervisionActions('pause-requested').map((action) => action.kind)).toContain(
      'stop',
    )
  })

  it('offers resume once the pause is confirmed, and never before', () => {
    expect(availableSupervisionActions('paused').map((action) => action.kind)).toStrictEqual([
      'resume',
      'stop',
    ])
    expect(availableSupervisionActions('live').map((action) => action.kind)).not.toContain('resume')
  })

  it('offers only resume on a parked run (FR-151)', () => {
    expect(availableSupervisionActions('parked').map((action) => action.kind)).toStrictEqual([
      'resume',
    ])
  })

  it('offers nothing on a finished run', () => {
    expect(availableSupervisionActions('finished')).toStrictEqual([])
    expect(acceptsCorrections('finished')).toBe(false)
  })

  it('gives stop the danger weight and the others the secondary one', () => {
    expect(supervisionAction('stop').variant).toBe('danger')
    expect(supervisionAction('pause').variant).toBe('secondary')
    expect(supervisionAction('resume').verb).toBe('Resuming')
  })
})
