import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { IntegrationCard } from './integration-card'
import type { IntegrationReadouts } from './integration-listing'

const noop = () => undefined

const integration: IntegrationReadouts = {
  id: 'integration-1',
  name: 'Payments board',
  type: 'jira',
  board: 'https://boards.invalid · FIX · label sisyphus',
  state: 'enabled',
  enabled: true,
  schedule: 'at 09:00 every day',
  scheduleExpression: '0 9 * * *',
  timezone: 'Australia/Sydney',
  nextRuns: ['2026-08-06 09:00', '2026-08-07 09:00'],
  mappingSummary: 'Payments',
  ceilings: '3 per tick, 12 per 60 minutes',
  claimedTicketCount: '4',
  startedWorkflowCount: '3',
  consecutiveFailures: '0',
  autoDisabledReason: undefined,
  lastRun: '2026-08-05 09:00 — examined 7, started 2, skipped 2',
  scheduleRegistered: true,
}

const render = (props: Partial<Parameters<typeof IntegrationCard>[0]> = {}) =>
  renderToStaticMarkup(
    <IntegrationCard
      integration={integration}
      onEdit={noop}
      onSetEnabled={noop}
      onValidate={noop}
      onRunNow={noop}
      onRequestDelete={noop}
      onCancelDelete={noop}
      onConfirmDelete={noop}
      onShowHistory={noop}
      onHideHistory={noop}
      {...props}
    />,
  )

describe('IntegrationCard (T121, FR-097, FR-105, FR-106, FR-155)', () => {
  it('leads with the schedule and its timezone', () => {
    const markup = render()

    expect(markup.indexOf('at 09:00 every day')).toBeLessThan(markup.indexOf('boards.invalid'))
    expect(markup).toContain('Australia/Sydney')
  })

  it('labels the fire times with the board timezone, not the reader own', () => {
    expect(render()).toContain('next runs — Australia/Sydney')
  })

  it('says outright when a schedule cannot be read', () => {
    expect(render({ integration: { ...integration, nextRuns: [] } })).toContain('could not be read')
  })

  it('says whether the schedule has actually been registered', () => {
    expect(render({ integration: { ...integration, scheduleRegistered: false } })).toContain(
      'not yet',
    )
  })

  it('shows what the last tick did (FR-105)', () => {
    expect(render()).toContain('examined 7, started 2, skipped 2')
  })

  it('shows both ceilings, so what it can spend is visible beside when it runs', () => {
    expect(render()).toContain('3 per tick, 12 per 60 minutes')
  })

  it('offers Run now for an enabled board', () => {
    expect(render()).toContain('Run now')
  })

  it('does not offer Run now for a disabled board, since the server would refuse it', () => {
    expect(
      render({ integration: { ...integration, enabled: false, state: 'disabled' } }),
    ).not.toContain('Run now')
  })

  it('offers Enable rather than Disable when it is off', () => {
    const markup = render({ integration: { ...integration, enabled: false, state: 'disabled' } })

    expect(markup).toContain('>Enable<')
    expect(markup).not.toContain('>Disable<')
  })

  it('renders auto-disabled as its own state, not as plain disabled (FR-106)', () => {
    const markup = render({
      integration: {
        ...integration,
        enabled: false,
        state: 'auto-disabled',
        consecutiveFailures: '5',
        autoDisabledReason: 'auto-disabled after 5 consecutive failed ticks: unreachable',
      },
    })

    expect(markup).toContain('auto-disabled')
    expect(markup).toContain('consecutive failed ticks')
    expect(markup).toContain('enabling clears the failure count')
  })

  it('renders a validation verdict check by check (FR-097)', () => {
    const markup = render({
      validation: {
        ok: false,
        checks: [
          { name: 'configuration', ok: true },
          { name: 'connectivity', ok: false, detail: 'the credential was rejected' },
        ],
      },
    })

    expect(markup).toContain('validation failed')
    expect(markup).toContain('the credential was rejected')
  })

  it('reports its own pending state as a readout rather than a spinner', () => {
    expect(render({ startedAt: Date.now() })).toContain('Working')
  })

  it('renders a refusal on the card it belongs to', () => {
    expect(
      render({ error: { code: 'CONFLICT', action: 'Enable it before running it.' } }),
    ).toContain('Enable it before running it.')
  })
})

describe('IntegrationCard — delete (FR-097)', () => {
  it('offers delete, because FR-097 names it among the six admin actions', () => {
    expect(render()).toContain('Delete')
  })

  it('offers it even for a board that will refuse, so the refusal can name its reason', () => {
    // The count that decides whether it may go (FR-131) lives on the server and is what the admin
    // is asking about. A hidden button answers "you cannot" without ever saying why.
    expect(render({ integration: { ...integration, startedWorkflowCount: '3' } })).toContain(
      'Delete',
    )
  })

  it('asks before it deletes, and says what deleting costs', () => {
    const markup = render({ confirmingDelete: true })

    expect(markup).toContain('Delete Payments board?')
    expect(markup).toContain('Its schedule stops')
    expect(markup).toContain('Keep it')
  })

  it('does not show the confirmation until it is asked for', () => {
    expect(render()).not.toContain('Delete Payments board?')
  })
})

describe('IntegrationCard — tick history (FR-105)', () => {
  const rows = [
    {
      id: 'run-1',
      trigger: 'scheduled',
      startedAt: '2026-08-05 09:00:00',
      duration: '12s',
      counts: 'examined 7, matched 4, started 2, skipped 2',
      error: undefined,
      failed: false,
    },
    {
      id: 'run-2',
      trigger: 'manual',
      startedAt: '2026-08-04 09:00:00',
      duration: '3s',
      counts: 'examined 0, matched 0, started 0, skipped 0',
      error: 'the credential was rejected',
      failed: true,
    },
  ]

  it('offers the history rather than loading it with the list', () => {
    expect(render()).toContain('Tick history')
  })

  it('renders each tick as what it did, with its trigger and counts', () => {
    const markup = render({ history: rows })

    expect(markup).toContain('examined 7, matched 4, started 2, skipped 2')
    expect(markup).toContain('scheduled')
    expect(markup).toContain('manual')
  })

  it('carries the failure reason, which is how an unreachable board reads (FR-108)', () => {
    expect(render({ history: rows })).toContain('failed: the credential was rejected')
  })

  it('says a board has never ticked rather than rendering an empty list', () => {
    expect(render({ history: [] })).toContain('has not ticked yet')
  })

  it('names the silent stall FR-106 does not catch (FR-105)', () => {
    const markup = render({ history: rows, stalled: true })

    expect(markup).toContain('matched tickets and started nothing')
    expect(markup).toContain('consecutive-failure count has not moved')
  })

  it('says nothing about stalling for a healthy board', () => {
    expect(render({ history: rows })).not.toContain('started nothing')
  })
})
