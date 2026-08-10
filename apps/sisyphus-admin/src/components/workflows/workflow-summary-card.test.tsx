import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { WorkflowDetailReadouts } from './workflow-detail-readouts'
import { WorkflowSummaryCard } from './workflow-summary-card'

const detail: WorkflowDetailReadouts = {
  id: '0199a1f4-0000-7000-8000-0000000000ab',
  runId: '0199a1f4…',
  state: 'running',
  stateReadout: 'running 10:00',
  type: 'delegated',
  startedByLabel: 'initiated by',
  startedBy: 'Ada Lovelace',
  owner: 'Ada Lovelace',
  workspace: 'Acme platform',
  ticket: 'ABC-12',
  model: 'claude-sonnet-4-5',
  instanceType: 'c7g.2xlarge',
  purchaseMode: 'spot',
  executionProfile: 'API maintenance',
  resultBranch: 'sisyphus/abc-12',
  startedAt: '2026-08-05 09:00',
  lastMovedAt: '2026-08-05 09:04',
  duration: '10:00',
  turns: { used: '14', cap: '40', meter: { value: 14, max: 40 } },
  spend: { used: '3.1400', cap: '10.0000', meter: { value: 3.14, max: 10 } },
  outcome: '—',
  outcomeReason: '—',
  reviewerSummary: null,
  needsReassignment: false,
  promptTruncated: false,
  storagePark: undefined,
}

describe('WorkflowSummaryCard', () => {
  it('shows the whole launch configuration', () => {
    const markup = renderToStaticMarkup(<WorkflowSummaryCard detail={detail} />)

    for (const value of [
      'Ada Lovelace',
      'delegated',
      'Acme platform',
      'ABC-12',
      'API maintenance',
      'claude-sonnet-4-5',
      'c7g.2xlarge',
      'spot',
      'sisyphus/abc-12',
      '2026-08-05 09:00',
      '10:00',
    ]) {
      expect(markup).toContain(value)
    }
  })

  it('reports state through the chip, coloured from the state (FR-025)', () => {
    const markup = renderToStaticMarkup(<WorkflowSummaryCard detail={detail} />)

    expect(markup).toContain('data-state="running"')
    expect(markup).toContain('running 10:00')
  })

  it('meters a cap in signal, never in a state colour', () => {
    const markup = renderToStaticMarkup(<WorkflowSummaryCard detail={detail} />)

    expect(markup).toContain('role="meter"')
    expect(markup).toContain('bg-signal')
    expect(markup).toContain('14 / 40')
    expect(markup).toContain('3.1400 / 10.0000')
  })

  it('says an uncapped run is uncapped, and draws no meter for it', () => {
    const markup = renderToStaticMarkup(
      <WorkflowSummaryCard
        detail={{
          ...detail,
          turns: { used: '14', cap: undefined, meter: undefined },
          spend: { used: '3.1400', cap: undefined, meter: undefined },
        }}
      />,
    )

    expect(markup).toContain('14 (uncapped)')
    expect(markup).not.toContain('role="meter"')
  })

  it('states why a run ended where it did, when that is more than the outcome name', () => {
    const markup = renderToStaticMarkup(
      <WorkflowSummaryCard
        detail={{ ...detail, outcome: 'capped', outcomeReason: 'The spend cap was reached.' }}
      />,
    )

    expect(markup).toContain('why it ended there')
    expect(markup).toContain('The spend cap was reached.')
  })

  it('omits the reason when there is nothing beyond the outcome to say', () => {
    const markup = renderToStaticMarkup(<WorkflowSummaryCard detail={detail} />)

    expect(markup).not.toContain('why it ended there')
  })

  it('says so when the owner was deactivated (FR-176)', () => {
    const markup = renderToStaticMarkup(
      <WorkflowSummaryCard detail={{ ...detail, needsReassignment: true }} />,
    )

    expect(markup).toContain('owner has been deactivated')
  })

  it('says so when the prompt was truncated (FR-163)', () => {
    const markup = renderToStaticMarkup(
      <WorkflowSummaryCard detail={{ ...detail, promptTruncated: true }} />,
    )

    expect(markup).toContain('truncated oldest-comment-first')
  })

  it('says the run is waiting on storage, and that it is being retried (FR-082)', () => {
    const markup = renderToStaticMarkup(
      <WorkflowSummaryCard
        detail={{
          ...detail,
          storagePark: {
            waiting: true,
            headline: 'Waiting on storage',
            explanation: 'It has not stalled: the write is being retried — attempt 2 of 8.',
            cause: 'the snapshot bucket is unreachable',
          },
        }}
      />,
    )

    expect(markup).toContain('Waiting on storage')
    expect(markup).toContain('attempt 2 of 8')
    expect(markup).toContain('the snapshot bucket is unreachable')
    // The chip still reports the run's actual state. A park does not change it, and a panel that
    // overwrote it here would be disagreeing with the heartbeat.
    expect(markup).toContain('data-state="running"')
  })

  it('says a run is waiting for an agent credential, and for how long (003/SC-006)', () => {
    // Every other readout on this card is empty for a waiting run — no instance, no turns, no
    // spend, no log — so without this the card is indistinguishable from a stalled one.
    const markup = renderToStaticMarkup(
      <WorkflowSummaryCard
        detail={detail}
        credentialWait={{
          waiting: true,
          headline: 'Waiting for an agent credential',
          waitedFor: '4:30',
          summary: 'Every agent credential this run can reach is held by another run.',
          remedy: 'Wait for a run to finish, or register more credentials in these groups.',
          groups: ['shared-seats', 'overflow'],
          configurationFault: false,
        }}
      />,
    )

    expect(markup).toContain('Waiting for an agent credential')
    expect(markup).toContain('4:30')
    // FR-029: the sentence saying what is true, the sentence saying what to do, and the groups
    // that were searched — because "no capacity" is what the requirement exists to prevent.
    expect(markup).toContain('held by another run')
    expect(markup).toContain('register more credentials')
    expect(markup).toContain('shared-seats, overflow')
    expect(markup).toContain('data-credential-wait="waiting"')
  })

  it('marks a configuration fault as one, rather than as a queue to wait out', () => {
    const markup = renderToStaticMarkup(
      <WorkflowSummaryCard
        detail={detail}
        credentialWait={{
          waiting: true,
          headline: 'Waiting for an agent credential that is not coming',
          waitedFor: '1:00',
          summary: 'The groups this run can reach hold no credentials at all.',
          remedy: 'Register a credential in one of those groups.',
          groups: ['empty-pool'],
          configurationFault: true,
        }}
      />,
    )

    expect(markup).toContain('data-credential-wait="fault"')
  })

  it('says nothing about a credential wait for a run that never waited', () => {
    const markup = renderToStaticMarkup(<WorkflowSummaryCard detail={detail} />)

    expect(markup).not.toContain('agent credential')
  })

  it('says nothing about storage for a run that never parked', () => {
    const markup = renderToStaticMarkup(<WorkflowSummaryCard detail={detail} />)

    expect(markup).not.toContain('storage')
  })

  it('writes no literal colour, size or radius outside the meter’s computed width (SC-015)', () => {
    const markup = renderToStaticMarkup(<WorkflowSummaryCard detail={detail} />)

    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    // The one inline style in the system is the meter's fill, which is a percentage of its track
    // and therefore a reading rather than a dimension.
    expect(markup).not.toMatch(/style="[^"]*\d+(px|rem)/)
  })
})
