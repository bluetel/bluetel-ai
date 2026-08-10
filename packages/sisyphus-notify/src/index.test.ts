import { describe, expect, it } from 'vitest'

import * as notify from './index'

/**
 * The barrel is the boundary, so two things about it are asserted rather than assumed.
 *
 * **It reaches nothing.** Importing it must not construct a Slack client or a database handle — a
 * barrel that did would make `import { … } from '@bluetel-ai/sisyphus-notify'` a side effect, and
 * the seam-plus-fake arrangement the control plane's `src/aws/` established exists precisely so
 * that importing costs nothing.
 *
 * **It does not export the fixture seeder.** `notify-fixtures.ts` is live-database test support;
 * exporting it would put it one import away from the delivery path, the same rule the control
 * plane's `jobs/index.ts` keeps for `workflow-fixtures.ts`.
 */
describe('the notify barrel', () => {
  it('exports the seams, their fakes and the delivery path', () => {
    expect(typeof notify.createWebApiSlackMessenger).toBe('function')
    expect(typeof notify.createFakeSlackMessenger).toBe('function')
    expect(typeof notify.createNotificationStore).toBe('function')
    expect(typeof notify.createFakeNotificationStore).toBe('function')
    expect(typeof notify.deliverNotification).toBe('function')
    expect(typeof notify.notifyWorkflowEvent).toBe('function')
    expect(typeof notify.notifyIntegrationTick).toBe('function')
  })

  it('exports the port the jobs notify through, and its recording fake (T177)', () => {
    expect(typeof notify.createWorkflowNotifier).toBe('function')
    expect(typeof notify.createFakeWorkflowNotifier).toBe('function')
    expect(notify.notificationEventForState('parked_resumable')).toBe('workflow_parked_resumable')
  })

  it('exports the FR-056 administrator alerts as a vocabulary of their own (003/T111)', () => {
    expect(typeof notify.createCredentialPoolAlerter).toBe('function')
    expect(typeof notify.planCredentialAlerts).toBe('function')

    // Kept apart from `NotificationEvent` on purpose: these are about a seat rather than a run,
    // their audience is whoever administers capacity, and none of them may be switched off by a
    // notification preference. 003/FR-079 leaves administrator alerting untouched while making
    // waiting, cooling off and parking silent to a workflow's owner — and the owner-facing enum
    // still has no member for any pool condition, which is what keeps the two audiences apart.
    for (const kind of notify.CREDENTIAL_ALERT_KINDS) {
      expect(Object.keys(notify)).not.toContain(`workflow_${kind}`)
    }
    expect(notify.notificationEventForState('awaiting_credential')).toBeUndefined()
  })

  it('does not export the live-database fixture seeder', () => {
    expect(Object.keys(notify)).not.toContain('createNotifyFixtures')
    expect(Object.keys(notify)).not.toContain('readTestDatabaseUrl')
  })

  it('exports the coalescing constants the budget argument rests on', () => {
    expect(notify.worstCaseDeliveryLatencyMs()).toBeLessThan(notify.NOTIFICATION_DELIVERY_BUDGET_MS)
  })
})
