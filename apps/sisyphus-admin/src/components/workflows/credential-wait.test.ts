import { describe, expect, it } from 'vitest'

import { toCredentialWaitReadout } from './credential-wait'
import type { TimelineItem } from './workflow-detail-readouts'

/**
 * 003/SC-006 in executable form: *an engineer can tell, from the workflow view alone and without
 * assistance, that a run is waiting for an agent credential and how long it has waited.*
 *
 * Three of these tests are about the ways that could quietly not be true. The wait is recorded as a
 * `queued` timeline entry, and `queued` already means "waiting under the concurrency ceiling" — so
 * a reader matching the event name would time the wait from the wrong entry and report a
 * four-second wait as an hour old. A detail written by an older control plane must produce no card
 * rather than a card of empty sentences. And a configuration fault has to be distinguishable from
 * a queue, because telling somebody to wait out a group that holds no credentials is the FR-029
 * failure in one sentence.
 */

const at = (iso: string): Date => new Date(iso)

const entry = (options: {
  readonly id: string
  readonly event: string
  readonly createdAt: string
  readonly detail?: unknown
}): TimelineItem =>
  ({
    id: options.id,
    event: options.event,
    actorType: 'control_plane',
    actorUserId: null,
    actorDisplayName: null,
    detail: options.detail ?? null,
    createdAt: at(options.createdAt),
  }) as TimelineItem

const waitDetail = (overrides: Record<string, unknown> = {}): unknown => ({
  waitingOn: 'agent_credential',
  kind: 'all_held',
  configurationFault: false,
  groups: [
    { name: 'shared-seats', position: 1 },
    { name: 'overflow', position: 2 },
  ],
  summary: 'Every agent credential this run can reach is held by another run.',
  remedy: 'Wait for a run to finish, or register more credentials in these groups.',
  ...overrides,
})

const WAIT_BEGAN = '2026-08-09T09:00:00.000Z'

const waitingTimeline: readonly TimelineItem[] = [
  entry({ id: 'e1', event: 'created', createdAt: '2026-08-09T08:59:00.000Z' }),
  entry({ id: 'e2', event: 'queued', createdAt: WAIT_BEGAN, detail: waitDetail() }),
]

describe('toCredentialWaitReadout', () => {
  it('says the run is waiting, for how long, and which groups were searched', () => {
    const readout = toCredentialWaitReadout({
      state: 'awaiting_credential',
      timeline: waitingTimeline,
      now: at('2026-08-09T09:04:30.000Z').getTime(),
    })

    expect(readout).toMatchObject({
      waiting: true,
      headline: 'Waiting for an agent credential',
      waitedFor: '4:30',
      configurationFault: false,
    })
    // FR-029: the sentences are the control plane's, verbatim. A panel that paraphrased them would
    // be a second opinion about what is wrong with the pool.
    expect(readout?.summary).toContain('held by another run')
    expect(readout?.remedy).toContain('register more credentials')
    expect(readout?.groups).toEqual(['shared-seats', 'overflow'])
  })

  it('distinguishes a configuration fault from a queue that will drain', () => {
    // The one case that is not a wait at all: nothing is held, so nothing will be released, and an
    // engineer told to "wait for capacity" would wait until FR-028's limit failed the run.
    const readout = toCredentialWaitReadout({
      state: 'awaiting_credential',
      timeline: [
        entry({
          id: 'e1',
          event: 'queued',
          createdAt: WAIT_BEGAN,
          detail: waitDetail({
            kind: 'no_credentials',
            configurationFault: true,
            summary: 'The agent-credential groups this run can reach hold no credentials at all.',
            remedy: 'Register a credential in one of those groups.',
          }),
        }),
      ],
      now: at('2026-08-09T09:01:00.000Z').getTime(),
    })

    expect(readout?.configurationFault).toBe(true)
    expect(readout?.headline).toBe('Waiting for an agent credential that is not coming')
  })

  it('ignores a `queued` entry that is about the concurrency ceiling', () => {
    // Two scarcities share one event name. Matching the name rather than the discriminator would
    // report a run waiting for a machine as one waiting for a credential.
    const readout = toCredentialWaitReadout({
      state: 'queued',
      timeline: [
        entry({
          id: 'e1',
          event: 'queued',
          createdAt: WAIT_BEGAN,
          detail: { ceiling: 4, liveLeasesBefore: 4 },
        }),
      ],
      now: at('2026-08-09T09:01:00.000Z').getTime(),
    })

    expect(readout).toBeUndefined()
  })

  it('says nothing at all when the recorded detail will not parse', () => {
    // A panel one release ahead of the control plane meets rows written by the older one. A card of
    // empty sentences would be worse than no card.
    const readout = toCredentialWaitReadout({
      state: 'awaiting_credential',
      timeline: [
        entry({
          id: 'e1',
          event: 'queued',
          createdAt: WAIT_BEGAN,
          detail: { waitingOn: 'agent_credential', kind: 'all_held' },
        }),
      ],
      now: at('2026-08-09T09:01:00.000Z').getTime(),
    })

    expect(readout).toBeUndefined()
  })

  it('reports a wait that has ended in the past tense, measured to the entry that ended it', () => {
    // Nothing writes "the wait ended"; admission's `admitted` entry is what ended it, and deriving
    // the end from the timeline means a run whose wait ended stops reading as waiting without any
    // message having had to arrive.
    const readout = toCredentialWaitReadout({
      state: 'running',
      timeline: [
        ...waitingTimeline,
        entry({ id: 'e3', event: 'admitted', createdAt: '2026-08-09T09:20:00.000Z' }),
        entry({ id: 'e4', event: 'started', createdAt: '2026-08-09T09:22:00.000Z' }),
      ],
      // The clock is running long past the end; the duration must still stop at the `admitted`
      // entry, or a finished wait would keep counting for as long as the page was open.
      now: at('2026-08-09T11:00:00.000Z').getTime(),
    })

    expect(readout).toMatchObject({
      waiting: false,
      headline: 'Waited for an agent credential earlier in this run',
      waitedFor: '20:00',
    })
  })

  it('takes the most recent wait when a run has waited more than once', () => {
    const readout = toCredentialWaitReadout({
      state: 'awaiting_credential',
      timeline: [
        entry({ id: 'e1', event: 'queued', createdAt: WAIT_BEGAN, detail: waitDetail() }),
        entry({ id: 'e2', event: 'admitted', createdAt: '2026-08-09T09:05:00.000Z' }),
        entry({
          id: 'e3',
          event: 'queued',
          createdAt: '2026-08-09T10:00:00.000Z',
          detail: waitDetail({ kind: 'all_cooling_off', summary: 'Every seat is cooling off.' }),
        }),
      ],
      now: at('2026-08-09T10:02:00.000Z').getTime(),
    })

    expect(readout?.summary).toBe('Every seat is cooling off.')
    expect(readout?.waitedFor).toBe('2:00')
  })

  it('reports nothing for a run that has never waited for a credential', () => {
    expect(
      toCredentialWaitReadout({
        state: 'running',
        timeline: [entry({ id: 'e1', event: 'admitted', createdAt: WAIT_BEGAN })],
        now: at('2026-08-09T09:01:00.000Z').getTime(),
      }),
    ).toBeUndefined()
  })

  it('invents no duration before the browser has a clock', () => {
    // Rendered on the server there is no `now`, and measuring against the server's clock would put
    // a number on screen that changes the moment the page hydrates.
    const readout = toCredentialWaitReadout({
      state: 'awaiting_credential',
      timeline: waitingTimeline,
      now: undefined,
    })

    expect(readout?.waitedFor).toBe('0:00')
    expect(readout?.waiting).toBe(true)
  })
})
