import { describe, expect, it } from 'vitest'

import type { CredentialAlertKind, CredentialAlertSubject } from './credential-alerts'
import {
  composeCredentialAlertMessage,
  CREDENTIAL_ALERT_KINDS,
  credentialPoolUrl,
  planCredentialAlerts,
} from './credential-alerts'

/**
 * The FR-056 alerts (T111).
 *
 * Two questions are being asked, and they are not the same question:
 *
 * 1. **Do the four conditions FR-056 names reach an administrator?** Approaching expiry, becoming
 *    unhealthy, requiring a login, and a lease held beyond
 *    `SISYPHUS_LEASE_HOLD_EXPECTATION_HOURS` — the last of which must **name the holding workflow**,
 *    because "a seat has been held too long" tells nobody where the capacity went.
 * 2. **Do the states 003/FR-079 makes silent stay silent?** Waiting for a credential, cooling off,
 *    and parking raise nothing to a workflow's owner, and nothing here fires for them either — a
 *    parked holder inside the expectation and a cooling-off seat both produce no alert at all. That
 *    is the half of the requirement most easily lost: an alerter that fired on every unusable seat
 *    would page somebody about a provider rate limit that clears by itself, and the alert that
 *    matters would stop being read.
 *
 * The thresholds are passed in rather than defaulted, which is the point of the second `it` in the
 * expiry block: the window is unmeasured (research R2) and the alert has to move with whatever the
 * deployment configures.
 */

const HOUR = 3_600_000
const now = new Date('2026-03-01T12:00:00.000Z')
const hoursAgo = (hours: number): Date => new Date(now.getTime() - hours * HOUR)

/** A healthy, recently exercised seat that nobody is holding. Every test starts from a pool with nothing wrong. */
const subject = (overrides: Partial<CredentialAlertSubject> = {}): CredentialAlertSubject => ({
  agentCredentialId: 'seat-1',
  name: 'vendor-seat-1',
  credentialGroupName: 'vendor pool',
  state: 'available',
  hasLogin: true,
  lastExercisedAt: hoursAgo(1),
  lastFailureReason: null,
  holder: null,
  ...overrides,
})

const plan = (subjects: readonly CredentialAlertSubject[]): readonly CredentialAlertKind[] =>
  planCredentialAlerts({
    subjects,
    idleExpiryHours: 24,
    leaseHoldExpectationHours: 12,
    now,
  }).map((alert) => alert.kind)

describe('CREDENTIAL_ALERT_KINDS', () => {
  it('is exactly FR-056’s four conditions', () => {
    expect([...CREDENTIAL_ALERT_KINDS]).toStrictEqual([
      'approaching_expiry',
      'became_unhealthy',
      'requires_login',
      'lease_held_too_long',
    ])
  })
})

describe('planCredentialAlerts', () => {
  it('raises nothing for a healthy pool', () => {
    expect(plan([subject(), subject({ agentCredentialId: 'seat-2' })])).toStrictEqual([])
  })

  describe('a credential becoming unhealthy (FR-037, FR-056)', () => {
    it('raises it, quoting the reason recorded against the seat verbatim (FR-009)', () => {
      const alerts = planCredentialAlerts({
        subjects: [
          subject({
            state: 'unhealthy',
            lastFailureReason: 'The provider rejected the stored session.',
          }),
        ],
        idleExpiryHours: 24,
        leaseHoldExpectationHours: 12,
        now,
      })

      expect(alerts).toHaveLength(1)
      expect(alerts[0]?.kind).toBe('became_unhealthy')
      // The provider's own words are very often the only evidence an administrator has.
      expect(alerts[0]?.summary).toContain('The provider rejected the stored session.')
    })

    it('says so plainly when nothing was recorded, rather than implying a reason exists', () => {
      const alerts = planCredentialAlerts({
        subjects: [subject({ state: 'unhealthy' })],
        idleExpiryHours: 24,
        leaseHoldExpectationHours: 12,
        now,
      })

      expect(alerts[0]?.summary).toContain('No reason was recorded')
    })
  })

  describe('a credential requiring a login (FR-008, FR-056, FR-072)', () => {
    it('raises a seat with no captured login, whatever its state says', () => {
      // FR-008 as a data rule rather than a state one: a seat with nowhere to fetch material from
      // is unusable by every code path, so `hasLogin` is what this turns on.
      expect(
        plan([subject({ state: 'awaiting_login', hasLogin: false, lastExercisedAt: null })]),
      ).toStrictEqual(['requires_login'])
    })

    it('raises both facts about a broken seat that also has no login, rather than picking one', () => {
      expect(
        plan([subject({ state: 'unhealthy', hasLogin: false, lastExercisedAt: null })]),
      ).toStrictEqual(['became_unhealthy', 'requires_login'])
    })
  })

  describe('a credential approaching expiry (SC-009, FR-056)', () => {
    it('raises a seat idle into the last quarter of its window', () => {
      expect(plan([subject({ lastExercisedAt: hoursAgo(19) })])).toStrictEqual([
        'approaching_expiry',
      ])
      expect(plan([subject({ lastExercisedAt: hoursAgo(17) })])).toStrictEqual([])
    })

    it('moves with the configured window rather than with a fixed lead time (research R2)', () => {
      // The idle-expiry period of a subscription login is unmeasured, which is why it is
      // configuration. A warning expressed in hours would be most of a six-hour window and a
      // rounding error in a fortnight-long one.
      const idleFor19Hours = [subject({ lastExercisedAt: hoursAgo(19) })]

      expect(
        planCredentialAlerts({
          subjects: idleFor19Hours,
          idleExpiryHours: 72,
          leaseHoldExpectationHours: 12,
          now,
        }),
      ).toStrictEqual([])
      expect(
        planCredentialAlerts({
          subjects: idleFor19Hours,
          idleExpiryHours: 12,
          leaseHoldExpectationHours: 12,
          now,
        }).map((alert) => alert.kind),
      ).toStrictEqual(['approaching_expiry'])
    })

    it('says nothing about expiry for a seat that has never been exercised', () => {
      // FR-053's "time until expiry **where known**". There is nothing to project from, and
      // inventing a projection from the registration date would raise every new seat.
      expect(plan([subject({ lastExercisedAt: null })])).toStrictEqual([])
    })

    it('does not add a staleness line to a seat that is already broken', () => {
      expect(plan([subject({ state: 'unhealthy', lastExercisedAt: hoursAgo(30) })])).toStrictEqual([
        'became_unhealthy',
      ])
    })
  })

  describe('a lease held beyond the expectation (FR-056)', () => {
    const parkedFor = (hours: number): CredentialAlertSubject =>
      subject({
        state: 'held',
        holder: {
          workflowId: 'workflow-77',
          workflowState: 'parked_resumable',
          acquiredAt: hoursAgo(hours),
        },
      })

    it('names the holding workflow, which is the only thing that makes it actionable', () => {
      const alerts = planCredentialAlerts({
        subjects: [parkedFor(30)],
        idleExpiryHours: 24,
        leaseHoldExpectationHours: 12,
        now,
      })

      expect(alerts).toHaveLength(1)
      expect(alerts[0]?.kind).toBe('lease_held_too_long')
      expect(alerts[0]?.holder?.workflowId).toBe('workflow-77')
      expect(alerts[0]?.summary).toContain('workflow-77')
      expect(alerts[0]?.summary).toContain('parked_resumable')
      expect(alerts[0]?.summary).toContain('30 hours')
      expect(alerts[0]?.summary).toContain('expectation of 12')
    })

    it('reads the configured expectation rather than a number of its own', () => {
      // The knob is `SISYPHUS_LEASE_HOLD_EXPECTATION_HOURS`, in the control plane's environment. A
      // default here would be a second copy of it, and the symptom of the two disagreeing is an
      // alert that does not fire.
      expect(
        planCredentialAlerts({
          subjects: [parkedFor(30)],
          idleExpiryHours: 24,
          leaseHoldExpectationHours: 48,
          now,
        }),
      ).toStrictEqual([])
    })

    it('says it has released nothing, because it has not (FR-057)', () => {
      // An expectation, not a ceiling. Force-release is an administrator's act, attributed to them.
      const alerts = planCredentialAlerts({
        subjects: [parkedFor(30)],
        idleExpiryHours: 24,
        leaseHoldExpectationHours: 12,
        now,
      })

      expect(alerts[0]?.summary).toContain('this is attention, not action')
    })
  })

  describe('what deliberately raises nothing (FR-076, FR-079)', () => {
    it('says nothing about a cooling-off seat — a provider limit clears without a human (FR-076)', () => {
      // FR-076 requires this in as many words: no administrator action, no alert. Paging somebody
      // for a rate limit that clears by itself is how the channel stops being read, and it is also
      // why research R5 resolves an ambiguous provider response to `cooling_off`.
      expect(
        plan([
          subject({ state: 'cooling_off', lastExercisedAt: hoursAgo(2) }),
          subject({ agentCredentialId: 'seat-2', state: 'cooling_off', lastExercisedAt: null }),
        ]),
      ).toStrictEqual([])
    })

    it('says nothing about a parked holder inside the expectation (FR-073, FR-079)', () => {
      // Parking is a normal outcome and a parked run keeps its seat by design. It becomes an
      // administrator's problem at the expectation and not before — that is the fourth rule, not a
      // fifth one.
      expect(
        plan([
          subject({
            state: 'held',
            holder: {
              workflowId: 'workflow-5',
              workflowState: 'parked_resumable',
              acquiredAt: hoursAgo(2),
            },
          }),
        ]),
      ).toStrictEqual([])
    })

    it('says nothing about a run waiting for a seat — that is the queue’s business (FR-079)', () => {
      // A waiting run is not a fact about any credential, so there is no subject it could produce
      // an alert from. The queue is reported on the pool view and pushed to nobody.
      expect(plan([])).toStrictEqual([])
    })
  })
})

describe('composeCredentialAlertMessage', () => {
  const panel = { baseUrl: 'https://sisyphus.example.com/' }

  it('names the seat, its group, the reason and the pool it belongs to', () => {
    const [alert] = planCredentialAlerts({
      subjects: [subject({ state: 'unhealthy', lastFailureReason: 'Session rejected.' })],
      idleExpiryHours: 24,
      leaseHoldExpectationHours: 12,
      now,
    })

    const message = composeCredentialAlertMessage(alert, panel)

    expect(message).toContain('vendor-seat-1')
    expect(message).toContain('vendor pool')
    expect(message).toContain('Session rejected.')
    // The link goes to the pool, because every one of these is a capacity question before it is a
    // credential question: whether this was the group's only seat decides how fast to move.
    expect(message).toContain('https://sisyphus.example.com/admin/credentials/pool')
  })

  it('links the holding run as well, on the lease-hold alert and only there', () => {
    const [held] = planCredentialAlerts({
      subjects: [
        subject({
          state: 'held',
          holder: {
            workflowId: 'workflow-77',
            workflowState: 'paused',
            acquiredAt: hoursAgo(20),
          },
        }),
      ],
      idleExpiryHours: 24,
      leaseHoldExpectationHours: 12,
      now,
    })

    expect(composeCredentialAlertMessage(held, panel)).toContain(
      'https://sisyphus.example.com/workflows/workflow-77',
    )

    const [unhealthy] = planCredentialAlerts({
      subjects: [subject({ state: 'unhealthy' })],
      idleExpiryHours: 24,
      leaseHoldExpectationHours: 12,
      now,
    })

    expect(composeCredentialAlertMessage(unhealthy, panel)).not.toContain('/workflows/')
  })

  it('carries no credential material, because there is none to carry (FR-011, SC-014)', () => {
    // A property of the shapes rather than of care taken here: `CredentialAlertSubject` has no field
    // material could be put in, so no message composed from one can contain any.
    const alerts = planCredentialAlerts({
      subjects: [subject({ state: 'unhealthy', hasLogin: false, lastExercisedAt: null })],
      idleExpiryHours: 24,
      leaseHoldExpectationHours: 12,
      now,
    })

    for (const alert of alerts) {
      expect(composeCredentialAlertMessage(alert, panel)).not.toContain('secret')
    }
  })
})

describe('credentialPoolUrl', () => {
  it('tolerates a base URL with or without a trailing slash', () => {
    expect(credentialPoolUrl({ baseUrl: 'https://s.example.com/' })).toBe(
      'https://s.example.com/admin/credentials/pool',
    )
    expect(credentialPoolUrl({ baseUrl: 'https://s.example.com' })).toBe(
      'https://s.example.com/admin/credentials/pool',
    )
  })
})
