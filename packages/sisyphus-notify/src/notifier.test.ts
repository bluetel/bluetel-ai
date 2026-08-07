import { randomUUID } from 'node:crypto'

import { WORKFLOW_STATES } from '@bluetel-ai/sisyphus-api/client'
import type { SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import type { MachineCredential, SisyphusDependencies } from '@bluetel-ai/sisyphus-api/server'
import { createMachineCaller, createTRPCContext } from '@bluetel-ai/sisyphus-api/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createNotificationStore } from './notification-store'
import {
  createFakeNotificationStore,
  fakeAudienceMember,
  fakeSubject,
} from './notification-store-fake'
import { createWorkflowNotifier, notificationEventForState } from './notifier'
import type { NotifyFixtures } from './notify-fixtures'
import { createNotifyFixtures, readTestDatabaseUrl } from './notify-fixtures'
import type { FakeSlackMessenger } from './slack-fake'
import { createFakeSlackMessenger } from './slack-fake'

/**
 * The port the jobs notify through (T177).
 *
 * Every test here goes through the recording Slack fake, so the suite makes no network call — the
 * point `slack-fake.ts` exists for.
 */

const panel = { baseUrl: 'https://panel.example' }

const notifierOver = (options: { readonly ownerUserId?: string } = {}) => {
  const store = createFakeNotificationStore({
    subject: fakeSubject({ ownerUserId: options.ownerUserId ?? 'ada' }),
    audience: [fakeAudienceMember({ userId: options.ownerUserId ?? 'ada' })],
  })
  const messenger = createFakeSlackMessenger()

  return { store, messenger, notifier: createWorkflowNotifier({ store, messenger, panel }) }
}

describe('notificationEventForState — exactly FR-136s list, and nothing else', () => {
  it.each([
    ['succeeded', 'workflow_succeeded'],
    ['failed', 'workflow_failed'],
    ['capped', 'workflow_capped'],
    ['cancelled', 'workflow_cancelled'],
    ['needs_attention', 'workflow_needs_attention'],
    ['parked_resumable', 'workflow_parked_resumable'],
  ] as const)('maps %s to %s', (state, event) => {
    expect(notificationEventForState(state)).toBe(event)
  })

  it.each(['queued', 'provisioning', 'running', 'paused'] as const)(
    'announces nothing for %s, because being picked up is not news',
    (state) => {
      expect(notificationEventForState(state)).toBeUndefined()
    },
  )

  it('has an answer for every state the enum admits', () => {
    // A state added without a decision here would otherwise be a run that ends in silence.
    for (const state of WORKFLOW_STATES) {
      expect(() => notificationEventForState(state)).not.toThrow()
    }
  })
})

describe('createWorkflowNotifier', () => {
  it('sends the workflow event as a direct message to the run’s owner', async () => {
    const { messenger, notifier, store } = notifierOver()

    const result = await notifier.workflowEvent({
      workflowId: '00000000-0000-7000-8000-0000000000aa',
      event: 'workflow_parked_resumable',
    })

    expect(result.deliveries.map((delivery) => delivery.outcome)).toStrictEqual(['delivered'])
    expect(messenger.sent).toHaveLength(1)
    expect(messenger.sent[0]?.text).toContain('is parked and can be resumed')
    expect(messenger.sent[0]?.text).toContain(
      'https://panel.example/workflows/00000000-0000-7000-8000-0000000000aa',
    )
    expect(store.recorded[0]).toMatchObject({
      event: 'workflow_parked_resumable',
      outcome: 'delivered',
      recipientUserId: 'ada',
    })
  })

  it('records the attempt and returns rather than throwing when Slack is down (FR-141)', async () => {
    const { messenger, notifier, store } = notifierOver()
    messenger.failWith(new Error('slack is unreachable'))

    const result = await notifier.workflowEvent({
      workflowId: '00000000-0000-7000-8000-0000000000bb',
      event: 'workflow_failed',
    })

    expect(result.deliveries.map((delivery) => delivery.outcome)).toStrictEqual(['failed'])
    expect(store.recorded[0]?.error).toContain('slack is unreachable')
  })

  it('folds a tick that started several runs for one owner into a single summary (FR-139)', async () => {
    const { messenger, notifier } = notifierOver()

    const deliveries = await notifier.integrationTick({
      integrationName: 'Payments board',
      starts: [
        { workflowId: 'w1', ownerUserId: 'ada' },
        { workflowId: 'w2', ownerUserId: 'ada' },
      ],
    })

    expect(deliveries).toHaveLength(1)
    expect(messenger.sent).toHaveLength(1)
    expect(messenger.sent[0]?.text).toContain('Payments board started 2 runs you own.')
  })

  it('sends nothing for a tick that started nothing', async () => {
    const { messenger, notifier } = notifierOver()

    expect(await notifier.integrationTick({ integrationName: null, starts: [] })).toStrictEqual([])
    expect(messenger.sent).toStrictEqual([])
  })
})

/**
 * **The seam, end to end: an executor's terminal report becomes a Slack direct message.**
 *
 * Everything above tests this package on its own. What is asserted here is the join — the one thing
 * neither side can assert alone, and the one that was missing for as long as the delivery path had
 * no production caller:
 *
 * 1. `WorkflowNotifier` is assignable to `SisyphusDependencies['notifier']` with **no
 *    adapter**. That is stated as a type annotation below rather than as a comment, so it is the
 *    type checker that keeps it true; an adapter would mean two opinions about who hears about a
 *    run.
 * 2. `reportTerminal` on the **machine surface** — the mount `apps/sisyphus-admin` serves and the
 *    only route by which `workflow_succeeded` is ever reached — actually drives it, after the
 *    outcome has been committed.
 * 3. What comes out the far side is a message to the run's owner and a recorded attempt, not merely
 *    a call to a spy.
 *
 * The Slack seam is `./slack-fake.ts`, so this makes no network call and needs no token: the
 * boundary a real client would sit behind is exactly where the fake sits.
 */
const connectionString = readTestDatabaseUrl()

describe.skipIf(connectionString === undefined)(
  'a terminal report through the machine surface reaches the notifier (FR-136, FR-141)',
  () => {
    let fixture: NotifyFixtures

    beforeAll(async () => {
      fixture = createNotifyFixtures(connectionString ?? '')
      await fixture.open()
    }, 60_000)

    afterAll(async () => {
      await fixture.close()
    }, 30_000)

    /**
     * A machine caller for one run, notifying through the real delivery path.
     *
     * The credential is handed straight to `resolveMachineCredential`, which is what an executor's
     * verified token resolves to — the credential *format* is `sisyphus-api`'s own subject, and
     * re-deriving it here would be testing JOSE rather than the notification seam.
     */
    const machineCallerFor = (input: {
      readonly db: SisyphusDatabase
      readonly workflowId: string
      readonly messenger: FakeSlackMessenger
    }) => {
      const credential: MachineCredential = {
        credentialId: randomUUID(),
        workflowId: input.workflowId,
        jti: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      }

      // The annotation is the assertion: this package's port, with nothing wrapped around it.
      const notifier: SisyphusDependencies['notifier'] = createWorkflowNotifier({
        store: createNotificationStore({ db: input.db }),
        messenger: input.messenger,
        panel,
      })

      const dependencies: SisyphusDependencies = {
        db: input.db,
        // The machine surface authenticates by credential and never by cookie (FR-005).
        resolveSession: () => Promise.resolve(null),
        resolveMachineCredential: () => Promise.resolve(credential),
        recordDenial: () => Promise.resolve(),
        notifier,
      }

      return createMachineCaller(() => createTRPCContext({ headers: new Headers(), dependencies }))
    }

    it('direct-messages the owner about a run that succeeded', async () => {
      const ownerUserId = await fixture.seedUser({ label: 'owner' })
      const workflowId = await fixture.seedWorkflow({ ownerUserId, state: 'running' })
      const messenger = createFakeSlackMessenger()

      const report = await machineCallerFor({
        db: fixture.db(),
        workflowId,
        messenger,
      }).reportTerminal({
        outcome: 'succeeded',
        reason: 'All checks passed.',
        turnsUsed: 6,
        spendUsed: '4.0000',
      })

      expect(report.recorded).toBe(true)
      expect((await fixture.readWorkflow(workflowId))?.state).toBe('succeeded')

      expect(messenger.sent).toHaveLength(1)
      expect(messenger.sent[0]?.slackUserId).toBe('slack-fixture-owner')
      expect(messenger.sent[0]?.text).toContain(`${panel.baseUrl}/workflows/${workflowId}`)

      const recorded = (await fixture.readNotifications()).filter(
        (notification) => notification.workflowId === workflowId,
      )
      expect(recorded).toHaveLength(1)
      expect(recorded[0]).toMatchObject({
        event: 'workflow_succeeded',
        outcome: 'delivered',
        recipientUserId: ownerUserId,
      })
    })

    it('announces the committed outcome once, not once per retry (FR-047, FR-139)', async () => {
      const ownerUserId = await fixture.seedUser({ label: 'retry' })
      const workflowId = await fixture.seedWorkflow({ ownerUserId, state: 'running' })
      const messenger = createFakeSlackMessenger()
      const caller = machineCallerFor({ db: fixture.db(), workflowId, messenger })
      const input = {
        outcome: 'needs_attention',
        reason: 'A repository was left unmerged.',
        turnsUsed: 2,
        spendUsed: '1.0000',
      } as const

      await caller.reportTerminal(input)
      const retry = await caller.reportTerminal(input)

      expect(retry.recorded).toBe(false)
      expect(messenger.sent).toHaveLength(1)
      expect(messenger.sent[0]?.text).toContain('State: needs_attention')
    })

    it('records the outcome even when Slack is down, and never fails the report (FR-141)', async () => {
      const ownerUserId = await fixture.seedUser({ label: 'outage' })
      const workflowId = await fixture.seedWorkflow({ ownerUserId, state: 'running' })
      const messenger = createFakeSlackMessenger()
      messenger.failWith(new Error('slack is unreachable'))

      const report = await machineCallerFor({
        db: fixture.db(),
        workflowId,
        messenger,
      }).reportTerminal({
        outcome: 'cancelled',
        reason: 'Cancelled by the owner.',
        turnsUsed: 1,
        spendUsed: '0.5000',
      })

      // The whole of FR-141: the run is cancelled, the failed attempt is visible, and the executor
      // was told the report succeeded — so it does not retry a write that already landed.
      expect(report.recorded).toBe(true)
      expect((await fixture.readWorkflow(workflowId))?.terminalOutcome).toBe('cancelled')

      const recorded = (await fixture.readNotifications()).filter(
        (notification) => notification.workflowId === workflowId,
      )
      expect(recorded[0]?.outcome).toBe('failed')
      expect(recorded[0]?.error).toContain('slack is unreachable')
    })
  },
)
