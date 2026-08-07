import { readFileSync } from 'node:fs'

import type { WorkflowState } from '@bluetel-ai/sisyphus-api/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

/**
 * The container that mounts into `workflows/supervision-slot.tsx`.
 *
 * Two kinds of assertion, and the second kind is the important one. The rendered ones prove the
 * card says what the recorded state says. The source ones prove the *only* thing a settled mutation
 * can do is start a wait — there is no path in this file from `onSuccess` to a status, which is what
 * FR-049 and SC-003 actually ask of the panel. A rendering test cannot show the absence of a path.
 */

const corrections = vi.fn((): unknown => ({ data: [], error: null, isPending: false }))
const pause = vi.fn()
const resume = vi.fn()
const stop = vi.fn()
const correct = vi.fn()
const invalidateById = vi.fn()
const invalidateCorrections = vi.fn()

vi.mock('@sisyphus-admin/trpc', () => ({
  api: {
    useUtils: () => ({
      workflow: {
        byId: { invalidate: invalidateById },
        corrections: { invalidate: invalidateCorrections },
      },
    }),
    workflow: {
      corrections: { useQuery: corrections },
      pause: { useMutation: () => ({ mutate: pause }) },
      resume: { useMutation: () => ({ mutate: resume }) },
      stop: { useMutation: () => ({ mutate: stop }) },
      correct: { useMutation: () => ({ mutate: correct }) },
    },
  },
}))

const { describeSupervisionError, SUPERVISION_REFUSED, WorkflowSupervision } =
  await import('./workflow-supervision')

const WORKFLOW_ID = '0199a1f4-0000-7000-8000-0000000000ab'

const source = readFileSync(new URL('./workflow-supervision.tsx', import.meta.url), 'utf8')

/** The source with its comments removed, so prose about a rule cannot satisfy a test of the rule. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

const render = (workflowState: WorkflowState): string =>
  renderToStaticMarkup(
    <WorkflowSupervision workflowId={WORKFLOW_ID} workflowState={workflowState} />,
  )

describe('what the card claims about the run', () => {
  it('reads a running run as running, and offers pause and stop (FR-015)', () => {
    const markup = render('running')

    expect(markup).toContain('RUNNING')
    expect(markup).toContain('Pause')
    expect(markup).toContain('Stop')
    expect(markup).not.toMatch(/>PAUSED</)
  })

  it('reads a paused run as paused, because the executor is what put it there (SC-003)', () => {
    const markup = render('paused')

    expect(markup).toContain('PAUSED')
    expect(markup).toContain('instance has confirmed the pause')
    expect(markup).toContain('Resume')
  })

  it('offers only a resume on a parked run', () => {
    const markup = render('parked_resumable')

    expect(markup).toContain('PARKED')
    expect(markup).toContain('Resume')
    expect(markup).not.toContain('>Pause<')
  })

  it('offers no command at all on a finished run, and says requests are recorded not applied', () => {
    const markup = render('succeeded')

    expect(markup).toContain('FINISHED')
    expect(markup).toContain('recorded but not applied')
    expect(markup).not.toContain('<button')
  })

  it('states the run it is acting on', () => {
    expect(render('running')).toContain(WORKFLOW_ID)
  })
})

describe('the corrections it lists', () => {
  it('says so plainly when a run has none', () => {
    expect(render('running')).toContain('no corrections written on this run')
  })

  it('lists a failed delivery with the reason, rather than filtering it out (SC-004)', () => {
    corrections.mockReturnValueOnce({
      data: [
        {
          id: 'correction-1',
          sequence: 1,
          body: 'prefer the existing helper',
          authorUserId: 'user-1',
          deliveryOutcome: 'failed',
          deliveredAt: null,
          failureReason: 'the turn was written but never echoed back',
          submittedAt: new Date('2026-08-05T09:00:00.000Z'),
        },
      ],
      error: null,
      isPending: false,
    })

    const markup = render('running')

    expect(markup).toContain('prefer the existing helper')
    expect(markup).toContain('not delivered')
    expect(markup).toContain('the turn was written but never echoed back')
  })
})

describe('refusing a supervision request (FR-190)', () => {
  it('says the same thing for FORBIDDEN as for NOT_FOUND', () => {
    const absent = describeSupervisionError({ data: { code: 'NOT_FOUND' } })
    const forbidden = describeSupervisionError({ data: { code: 'FORBIDDEN' } })

    expect(absent).toStrictEqual(forbidden)
    expect(absent).toStrictEqual(SUPERVISION_REFUSED)
  })

  it('never mentions permission, which would confirm the run exists', () => {
    for (const trpcCode of ['NOT_FOUND', 'FORBIDDEN', 'UNAUTHORIZED', 'INTERNAL_SERVER_ERROR']) {
      const described = describeSupervisionError({ data: { code: trpcCode } })

      expect(`${described.code} ${described.action}`.toLowerCase()).not.toContain('permission')
    }
  })
})

describe('the rule the file exists to hold', () => {
  it('derives the status from supervisionStatus and never assigns one', () => {
    expect(code).toContain('supervisionStatus({ workflowState, pendingCommand: outstanding })')
    expect(code).not.toMatch(/setStatus/)
    expect(code).not.toMatch(/status\s*=\s*'paused'/)
  })

  it('retires a request only through the acknowledgement check', () => {
    // The single place a queued command stops being outstanding, and it reads the recorded state.
    expect(code).toContain('isCommandAcknowledged({ command: awaiting.command, workflowState })')
    expect(code.match(/isCommandAcknowledged\(/g)).toHaveLength(1)
  })

  it('lets a settled mutation start a wait and nothing more', () => {
    const settle = code.split('const settleCommand')[1]?.split('const refuseCommand')[0] ?? ''

    expect(settle).toContain('nextPendingCommand(')
    // No shortcut from "the server accepted my pause" to "the run is paused".
    expect(settle).not.toContain("'paused'")
    expect(settle).not.toContain('isCommandAcknowledged')
  })

  it('takes the state as a prop rather than reading the run for itself', () => {
    // The panel owns the read and its cadence; two readers would be two answers to "is it paused?".
    expect(code).not.toContain('api.workflow.byId.useQuery')
  })

  it('writes no literal colour, size or radius (SC-015)', () => {
    const markup = render('running')

    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(markup).not.toMatch(/style="[^"]*\d+(px|rem)/)
  })
})
