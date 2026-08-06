import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SupervisionControls } from './controls'
import type { CorrectionReadout } from './correction-list'
import type { SupervisionStatus } from './supervision-status'

/**
 * T095, rendered.
 *
 * The derivation is proved in `supervision-status.test.ts`; what is proved here is that the markup
 * cannot say something the derivation forbids — the word "PAUSED" must not appear anywhere on a card
 * for a run whose pause is only requested, whatever else the component chooses to render.
 */

const WORKFLOW_ID = '0199a1f4-0000-7000-8000-0000000000ab'

const noop = (): void => undefined

const render = (
  status: SupervisionStatus,
  overrides: Partial<Parameters<typeof SupervisionControls>[0]> = {},
): string =>
  renderToStaticMarkup(
    <SupervisionControls
      workflowId={WORKFLOW_ID}
      status={status}
      correctionBody=""
      onCorrectionBodyChange={noop}
      onCommand={noop}
      onSendCorrection={noop}
      corrections={[]}
      {...overrides}
    />,
  )

describe('SupervisionControls — what it may claim', () => {
  it('never renders the word PAUSED while the pause is only requested', () => {
    const markup = render('pause-requested')

    expect(markup).toContain('PAUSE REQUESTED')
    expect(markup).not.toMatch(/>PAUSED</)
    expect(markup).toContain('has not performed it yet')
  })

  it('renders PAUSED once the executor has confirmed it', () => {
    expect(render('paused')).toContain('PAUSED')
    expect(render('paused')).toContain('instance has confirmed the pause')
  })

  it('keeps Stop available while a pause is queued', () => {
    const markup = render('pause-requested')

    expect(markup).toContain('Stop')
  })
})

describe('SupervisionControls — the four controls', () => {
  it('offers pause, stop and a correction on a live run', () => {
    const markup = render('live')

    expect(markup).toContain('Pause')
    expect(markup).toContain('Stop')
    expect(markup).toContain('Send correction')
    expect(markup).toContain('Correction')
  })

  it('offers resume once the run is paused', () => {
    const markup = render('paused')

    expect(markup).toContain('Resume')
    expect(markup).not.toContain('>Pause<')
  })

  it('offers no control at all on a finished run, and no correction field', () => {
    const markup = render('finished')

    expect(markup).not.toContain('Send correction')
    expect(markup).not.toContain('>Pause<')
    expect(markup).not.toContain('>Stop<')
  })

  it('renders the already-finished explanation in the server’s own words (FR-081)', () => {
    const explanation = 'This run finished successfully, so the pause was recorded but not applied.'
    const markup = render('finished', { alreadyFinished: explanation })

    expect(markup).toContain(explanation)
    expect(markup).toContain('role="status"')
  })

  it('will not send an empty correction', () => {
    const markup = render('live', { correctionBody: '   ' })

    expect(markup).toMatch(/disabled=""[^>]*>Send correction|Send correction/)
    expect(markup).toContain('data-state="disabled"')
  })

  it('turns the in-flight button into a live readout rather than a spinner', () => {
    const markup = render('live', {
      pending: { kind: 'pause', startedAt: Date.now() },
    })

    expect(markup).toContain('Pausing 0:00')
    expect(markup).toContain('aria-busy="true"')
  })

  it('disables the other controls while one is in flight', () => {
    const markup = render('live', {
      pending: { kind: 'correct', startedAt: Date.now() },
    })

    expect(markup).toContain('Sending 0:00')
    expect(markup).toContain('data-state="disabled"')
  })
})

describe('SupervisionControls — corrections', () => {
  const corrections: readonly CorrectionReadout[] = [
    {
      id: 'c1',
      sequence: 1,
      body: 'prefer the existing helper',
      outcome: 'delivered',
      failureReason: null,
      submittedAt: '2026-08-05 09:00:00',
    },
    {
      id: 'c2',
      sequence: 2,
      body: 'this one did not land',
      outcome: 'failed',
      failureReason: 'the turn was written to the agent but never acknowledged',
      submittedAt: '2026-08-05 09:01:00',
    },
  ]

  it('shows a failed delivery rather than hiding it (FR-049, SC-004)', () => {
    const markup = render('live', { corrections })

    expect(markup).toContain('this one did not land')
    expect(markup).toContain('not delivered')
    expect(markup).toContain('never acknowledged')
  })

  it('lists them in submission order, which is delivery order', () => {
    const markup = render('live', { corrections })

    expect(markup.indexOf('prefer the existing helper')).toBeLessThan(
      markup.indexOf('this one did not land'),
    )
  })

  it('offers no retry, because resending guidance is the author’s decision', () => {
    expect(render('live', { corrections })).not.toContain('Retry')
  })
})

describe('SupervisionControls — SC-015', () => {
  it('writes no literal colour, size or radius', () => {
    for (const status of ['live', 'pause-requested', 'paused', 'finished'] as const) {
      const markup = render(status, {
        corrections: [
          {
            id: 'c1',
            sequence: 1,
            body: 'body',
            outcome: 'failed',
            failureReason: 'reason',
            submittedAt: 'then',
          },
        ],
      })

      expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(markup).not.toMatch(/style="/)
      expect(markup).not.toMatch(/\b\d+(px|rem)\b/)
    }
  })
})
