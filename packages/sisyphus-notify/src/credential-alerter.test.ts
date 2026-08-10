import { describe, expect, it } from 'vitest'

import type { AlertRecipient } from './credential-alerter'
import { createCredentialPoolAlerter } from './credential-alerter'
import type { CredentialAlertSubject } from './credential-alerts'
import { createFakeSlackMessenger } from './slack-fake'

/**
 * The FR-056 alerter — the port, and how it learns its thresholds (T111).
 *
 * Three things are asserted here that `credential-alerts.test.ts` cannot:
 *
 * 1. **The thresholds arrive from the host, and the alerter has none of its own.** They live in
 *    `apps/sisyphus-control-plane/src/env-schemas.ts`, this package must not read an application's
 *    environment, and a default in the package would be a second copy of a configured number. So
 *    `createCredentialPoolAlerter` is built with them, exactly as the delivery path is built with
 *    `PanelLink.baseUrl`, and the same pool produces different alerts under different wiring.
 * 2. **The audience is administrators.** There is no path from this port to a workflow's owner, and
 *    no member of `NotificationEvent` is involved. That is 003/FR-079's separation as a property of
 *    the types: the owner-facing path cannot fire for a pool condition, and this one cannot reach an
 *    owner.
 * 3. **Nothing throws.** A Slack outage and an administrator with no Slack identity both come back
 *    as outcomes, because the one thing that must not depend on Slack being up is the mechanism for
 *    reporting that something is broken.
 */

const now = new Date('2026-03-01T12:00:00.000Z')
const hoursAgo = (hours: number): Date => new Date(now.getTime() - hours * 3_600_000)

const administrator: AlertRecipient = {
  userId: 'admin-1',
  displayName: 'Capacity Admin',
  slackUserId: 'U-ADMIN-1',
}

/** A seat held by a parked run for twenty hours — the FR-056 lease-hold case. */
const heldTooLong: CredentialAlertSubject = {
  agentCredentialId: 'seat-1',
  name: 'vendor-seat-1',
  credentialGroupName: 'vendor pool',
  state: 'held',
  hasLogin: true,
  lastExercisedAt: hoursAgo(1),
  lastFailureReason: null,
  holder: {
    workflowId: 'workflow-77',
    workflowState: 'parked_resumable',
    acquiredAt: hoursAgo(20),
  },
}

describe('createCredentialPoolAlerter', () => {
  it('raises the lease-hold alert against the configured expectation, naming the run', async () => {
    const messenger = createFakeSlackMessenger()
    const alerter = createCredentialPoolAlerter({
      messenger,
      panel: { baseUrl: 'https://sisyphus.example.com' },
      idleExpiryHours: 24,
      leaseHoldExpectationHours: 12,
    })

    const deliveries = await alerter.raise({
      subjects: [heldTooLong],
      administrators: [administrator],
      now,
    })

    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({ recipientUserId: 'admin-1', outcome: 'delivered' })
    expect(messenger.sent).toHaveLength(1)
    expect(messenger.sent[0]?.slackUserId).toBe('U-ADMIN-1')
    expect(messenger.sent[0]?.text).toContain('workflow-77')
    expect(messenger.sent[0]?.text).toContain('vendor-seat-1')
  })

  it('is silent about the same pool when the deployment expects longer holds', async () => {
    // The whole point of the knob living in the host's environment: a platform whose runs routinely
    // park for a day configures a longer expectation, and the alerter has no opinion of its own to
    // override it with.
    const messenger = createFakeSlackMessenger()
    const alerter = createCredentialPoolAlerter({
      messenger,
      panel: { baseUrl: 'https://sisyphus.example.com' },
      idleExpiryHours: 24,
      leaseHoldExpectationHours: 48,
    })

    await expect(
      alerter.raise({ subjects: [heldTooLong], administrators: [administrator], now }),
    ).resolves.toStrictEqual([])
    expect(messenger.sent).toStrictEqual([])
  })

  it('sends one message per administrator, so an alert does not depend on one person being awake', async () => {
    const messenger = createFakeSlackMessenger()
    const alerter = createCredentialPoolAlerter({
      messenger,
      panel: { baseUrl: 'https://sisyphus.example.com' },
      idleExpiryHours: 24,
      leaseHoldExpectationHours: 12,
    })

    const deliveries = await alerter.raise({
      subjects: [heldTooLong],
      administrators: [
        administrator,
        { userId: 'admin-2', displayName: 'Second Admin', slackUserId: 'U-ADMIN-2' },
      ],
      now,
    })

    expect(deliveries.map((delivery) => delivery.recipientUserId)).toStrictEqual([
      'admin-1',
      'admin-2',
    ])
    expect(messenger.sent).toHaveLength(2)
  })

  it('records an administrator with no Slack identity rather than dropping them (FR-140’s shape)', async () => {
    const messenger = createFakeSlackMessenger()
    const alerter = createCredentialPoolAlerter({
      messenger,
      panel: { baseUrl: 'https://sisyphus.example.com' },
      idleExpiryHours: 24,
      leaseHoldExpectationHours: 12,
    })

    const deliveries = await alerter.raise({
      subjects: [heldTooLong],
      administrators: [{ userId: 'admin-3', displayName: 'No Slack', slackUserId: null }],
      now,
    })

    expect(deliveries[0]).toMatchObject({ outcome: 'unnotifiable' })
    expect(messenger.sent).toStrictEqual([])
  })

  it('answers with a failure instead of throwing when Slack is down', async () => {
    // An outage is retryable and is not a fact about the person, so it is `failed` and not
    // `unnotifiable`. And it does not propagate: the sweep that raised this is doing something more
    // important than telling Slack about it.
    const messenger = createFakeSlackMessenger({ failure: new Error('slack is unavailable') })
    const alerter = createCredentialPoolAlerter({
      messenger,
      panel: { baseUrl: 'https://sisyphus.example.com' },
      idleExpiryHours: 24,
      leaseHoldExpectationHours: 12,
    })

    const deliveries = await alerter.raise({
      subjects: [heldTooLong],
      administrators: [administrator],
      now,
    })

    expect(deliveries[0]).toMatchObject({ outcome: 'failed', error: 'slack is unavailable' })
  })

  it('raises nothing at all for a pool whose only problems are the silent ones (FR-076, FR-079)', async () => {
    const messenger = createFakeSlackMessenger()
    const alerter = createCredentialPoolAlerter({
      messenger,
      panel: { baseUrl: 'https://sisyphus.example.com' },
      idleExpiryHours: 24,
      leaseHoldExpectationHours: 12,
    })

    const deliveries = await alerter.raise({
      subjects: [
        // Cooling off: a provider limit, which clears without a human (FR-076).
        { ...heldTooLong, agentCredentialId: 'seat-2', state: 'cooling_off', holder: null },
        // Parked and holding a seat, well inside the expectation (FR-073, FR-079).
        {
          ...heldTooLong,
          agentCredentialId: 'seat-3',
          holder: {
            workflowId: 'workflow-8',
            workflowState: 'parked_resumable',
            acquiredAt: hoursAgo(1),
          },
        },
      ],
      administrators: [administrator],
      now,
    })

    expect(deliveries).toStrictEqual([])
    expect(messenger.sent).toStrictEqual([])
  })
})
