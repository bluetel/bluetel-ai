import { users } from '@bluetel-ai/sisyphus-api/db'
import type { CredentialPoolRow } from '@bluetel-ai/sisyphus-api/server'
import type { CredentialAlertNotice, CredentialPoolAlerter } from '@bluetel-ai/sisyphus-notify'
import { createCredentialPoolAlerter, createFakeSlackMessenger } from '@bluetel-ai/sisyphus-notify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createCredentialPoolFixtures,
  readTestDatabaseUrl,
} from '../credentials/allocate/pool-fixtures'

import {
  alertSubjectFor,
  CREDENTIAL_ALERTS_JOB_NAME,
  runCredentialAlerts,
  sweepCredentialAlerts,
} from './credential-alerts'

/**
 * The sweep that finally gives FR-056 a caller.
 *
 * The interesting assertions are about the two ends of it. At the reading end: the pool row the
 * FR-053 view is built from becomes exactly the description `planCredentialAlerts` expects, and the
 * audience is every active administrator and nobody else. At the sending end: with the real alerter
 * wired over a fake messenger, a pool holding all four of FR-056's conditions produces all four
 * alerts — which is the property that would silently stop being true if the mapping below lost a
 * field.
 */

const connectionString = readTestDatabaseUrl()

const poolRow = (overrides: Partial<CredentialPoolRow> = {}): CredentialPoolRow => ({
  id: 'credential-1',
  credentialGroupId: 'group-1',
  credentialGroupName: 'shared-seats',
  credentialGroupEnabled: true,
  name: 'seat-one',
  state: 'available',
  enabled: true,
  selectable: true,
  hasSecret: true,
  heldBy: null,
  lastUsedAt: null,
  lastExercisedAt: null,
  lastLoginAt: null,
  coolingOffUntil: null,
  lastFailureReason: null,
  archivedAt: null,
  holderWorkflowId: null,
  holderWorkflowState: null,
  holderAcquiredAt: null,
  ...overrides,
})

describe('alertSubjectFor', () => {
  it('describes a free seat without inventing a holder', () => {
    expect(alertSubjectFor(poolRow())).toStrictEqual({
      agentCredentialId: 'credential-1',
      name: 'seat-one',
      credentialGroupName: 'shared-seats',
      state: 'available',
      hasLogin: true,
      lastExercisedAt: null,
      lastFailureReason: null,
      holder: null,
    })
  })

  it('reads "needs logging in" off the absence of a secret, not off the state', () => {
    // FR-008: a seat with nowhere to fetch material from is unusable by every code path, whatever
    // its state column says. A freshly registered seat and one whose capture never landed are the
    // same job to whoever has to fix it.
    expect(alertSubjectFor(poolRow({ state: 'available', hasSecret: false })).hasLogin).toBe(false)
  })

  it('names the holding run and when it took the seat', () => {
    const acquiredAt = new Date('2026-08-01T09:00:00.000Z')

    expect(
      alertSubjectFor(
        poolRow({
          state: 'held',
          holderWorkflowId: 'workflow-9',
          holderWorkflowState: 'parked_resumable',
          holderAcquiredAt: acquiredAt,
        }),
      ).holder,
    ).toStrictEqual({
      workflowId: 'workflow-9',
      workflowState: 'parked_resumable',
      acquiredAt,
    })
  })
})

describe.skipIf(connectionString === undefined)('sweeping the pool for alerts', () => {
  const fixtures = createCredentialPoolFixtures(connectionString ?? '')

  /** Every notice the sweep raised, so the wiring can be asserted rather than the wording. */
  const notices: CredentialAlertNotice[] = []

  const recordingAlerter: CredentialPoolAlerter = {
    raise: (notice) => {
      notices.push(notice)

      return Promise.resolve([])
    },
  }

  let groupId = ''

  beforeAll(async () => {
    await fixtures.open()

    groupId = await fixtures.seedGroup({ label: 'alerts' })

    // One seat per FR-056 condition, plus a healthy one that must produce nothing.
    await fixtures.seedCredential({
      label: 'broken',
      credentialGroupId: groupId,
      state: 'unhealthy',
      secretId: 'secret-broken',
      lastFailureReason: 'The provider rejected the stored login.',
      lastExercisedAt: new Date('2026-08-01T00:00:00.000Z'),
    })

    await fixtures.seedCredential({
      label: 'never-logged-in',
      credentialGroupId: groupId,
      state: 'awaiting_login',
      secretId: null,
    })

    await fixtures.seedCredential({
      label: 'going-stale',
      credentialGroupId: groupId,
      state: 'available',
      secretId: 'secret-stale',
      lastExercisedAt: new Date('2026-08-01T00:00:00.000Z'),
    })

    const heldId = await fixtures.seedCredential({
      label: 'held-too-long',
      credentialGroupId: groupId,
      state: 'held',
      secretId: 'secret-held',
      lastExercisedAt: new Date('2026-08-09T00:00:00.000Z'),
    })

    const workflowId = await fixtures.seedWorkflow({ label: 'holder', state: 'running' })

    await fixtures.forceLease({ agentCredentialId: heldId, workflowId, fence: 1 })

    // A second administrator, reachable, so the fixture's own unreachable one is not the only
    // recipient; plus two people who must never be written to.
    await fixtures
      .db()
      .insert(users)
      .values([
        {
          email: `${fixtures.suffix}-reachable@sisyphus.test`,
          googleSubject: `${fixtures.suffix}-reachable`,
          displayName: 'Reachable administrator',
          role: 'admin',
          slackUserId: 'U-REACHABLE',
        },
        {
          email: `${fixtures.suffix}-deactivated@sisyphus.test`,
          googleSubject: `${fixtures.suffix}-deactivated`,
          displayName: 'Deactivated administrator',
          role: 'admin',
          isActive: false,
          slackUserId: 'U-DEACTIVATED',
        },
        {
          email: `${fixtures.suffix}-engineer@sisyphus.test`,
          googleSubject: `${fixtures.suffix}-engineer`,
          displayName: 'An engineer',
          role: 'engineer',
          slackUserId: 'U-ENGINEER',
        },
      ])
  }, 120_000)

  afterAll(async () => {
    await fixtures.close()
  }, 120_000)

  it('reads the pool through the same query the pool view uses', async () => {
    notices.length = 0

    const result = await sweepCredentialAlerts({
      db: fixtures.db(),
      alerter: recordingAlerter,
      now: new Date('2026-08-10T00:00:00.000Z'),
    })

    expect(result.considered).toBe(4)
    expect(result.skipped).toBe(false)
    expect(notices).toHaveLength(1)
    expect(notices[0].subjects.map((subject) => subject.name).sort()).toStrictEqual([
      `broken-${fixtures.suffix}`,
      `going-stale-${fixtures.suffix}`,
      `held-too-long-${fixtures.suffix}`,
      `never-logged-in-${fixtures.suffix}`,
    ])
  })

  it('addresses every active administrator, and nobody else', async () => {
    notices.length = 0

    const result = await sweepCredentialAlerts({ db: fixtures.db(), alerter: recordingAlerter })

    // The fixture's own administrator has no Slack identity and is kept: an administrator nobody
    // can reach is a gap in the alerting path, and dropping them here would report perfect
    // delivery to an audience of nobody.
    expect(result.recipients).toBe(2)
    expect(
      notices[0].administrators.map((recipient) => recipient.slackUserId).sort(),
    ).toStrictEqual(['U-REACHABLE', null])
    expect(notices[0].administrators.map((recipient) => recipient.displayName)).toContain(
      'Reachable administrator',
    )
  })

  it('raises all four of FR-056 conditions through the real alerter', async () => {
    const messenger = createFakeSlackMessenger()

    const result = await sweepCredentialAlerts({
      db: fixtures.db(),
      alerter: createCredentialPoolAlerter({
        messenger,
        panel: { baseUrl: 'https://panel.example' },
        // Bound thresholds, exactly as `src/context.ts` binds them from the environment.
        idleExpiryHours: 24,
        leaseHoldExpectationHours: 12,
      }),
      // A day after the lease was taken, because `forceLease` stamps `acquired_at` with the
      // database's own clock and the hold expectation is measured from it. Stating the instant as
      // a literal would have made this assertion pass only on the day it was written.
      now: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })

    const kinds = new Set(result.deliveries.map((delivery) => delivery.alert.kind))

    expect([...kinds].sort()).toStrictEqual([
      'approaching_expiry',
      'became_unhealthy',
      'lease_held_too_long',
      'requires_login',
    ])

    // Delivered to the reachable administrator, reported `unnotifiable` for the one with no Slack
    // identity — never silently dropped.
    expect(result.deliveries.some((delivery) => delivery.outcome === 'delivered')).toBe(true)
    expect(result.deliveries.some((delivery) => delivery.outcome === 'unnotifiable')).toBe(true)
    expect(messenger.sent.length).toBeGreaterThan(0)
  })

  it('is a no-op that says so when a deployment has wired no alerter', async () => {
    const result = await sweepCredentialAlerts({ db: fixtures.db() })

    // Not a failure. An unwired alerter withholds a message and breaks nothing; a sweep that threw
    // would put a failing job on every schedule of a deployment still being stood up.
    expect(result).toStrictEqual({ considered: 4, recipients: 0, deliveries: [], skipped: true })
  })

  it('reports through the job envelope under its own name', async () => {
    const outcome = await runCredentialAlerts({ db: fixtures.db(), alerter: recordingAlerter })

    expect(outcome.ok).toBe(true)
    expect(outcome.jobName).toBe(CREDENTIAL_ALERTS_JOB_NAME)
  })

  it('writes nothing — it can raise a seat’s condition and cannot act on it', async () => {
    const before = await fixtures.audit()

    await sweepCredentialAlerts({ db: fixtures.db(), alerter: recordingAlerter })

    expect(await fixtures.audit()).toHaveLength(before.length)
  })
})
