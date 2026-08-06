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
