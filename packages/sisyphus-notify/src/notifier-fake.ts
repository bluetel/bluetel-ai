import type { NotificationEvent } from '@bluetel-ai/sisyphus-api/client'

import type { TickStart } from './coalesce'
import type { NotificationDelivery, WorkflowNotificationResult } from './delivery'
import type { IntegrationTickNotice, WorkflowNotifier } from './notifier'

/**
 * Recording fake for {@link WorkflowNotifier}.
 *
 * It exists so a job's suite can assert **that the transition announced itself** without assembling
 * a store, a messenger and a panel URL to do it — and, more to the point, without any of those
 * suites acquiring a path to Slack. `slack-fake.ts` is the only Slack in this repository; this fake
 * does not even reach that far.
 *
 * Every notice is kept in order, because the assertions that matter are about a *sequence*: a sweep
 * that moved three runs must have announced three, and a fake that only remembered the last could
 * not tell that from a sweep that announced one.
 */

/** One `workflowEvent` call, as it was made. */
export interface RecordedWorkflowNotice {
  readonly workflowId: string
  readonly event: NotificationEvent
}

/** One `integrationTick` call, as it was made. */
export interface RecordedTickNotice {
  readonly integrationName: string | null
  readonly starts: readonly TickStart[]
}

export interface FakeWorkflowNotifier extends WorkflowNotifier {
  /** Every workflow event announced, oldest first. */
  readonly notices: readonly RecordedWorkflowNotice[]
  /** Every tick summary announced, oldest first. */
  readonly tickNotices: readonly RecordedTickNotice[]
  /**
   * Make every call reject, as a deployment's own notifier might.
   *
   * FR-141 is the reason this is here: a job must report the same outcome whether or not the
   * message got out, and a fake that could not fail could not prove it.
   */
  readonly failWith: (error: Error | undefined) => void
}

export interface FakeWorkflowNotifierOptions {
  /** A failure applied to every call from the start. */
  readonly failure?: Error
}

const EMPTY_WORKFLOW_RESULT: WorkflowNotificationResult = { deliveries: [], deferred: [] }

export const createFakeWorkflowNotifier = (
  options: FakeWorkflowNotifierOptions = {},
): FakeWorkflowNotifier => {
  const notices: RecordedWorkflowNotice[] = []
  const tickNotices: RecordedTickNotice[] = []
  let failure = options.failure

  return {
    notices,
    tickNotices,

    failWith: (error) => {
      failure = error
    },

    workflowEvent: (notice) => {
      if (failure !== undefined) {
        return Promise.reject(failure)
      }

      notices.push({ workflowId: notice.workflowId, event: notice.event })
      return Promise.resolve(EMPTY_WORKFLOW_RESULT)
    },

    integrationTick: (notice: IntegrationTickNotice) => {
      if (failure !== undefined) {
        return Promise.reject(failure)
      }

      tickNotices.push({ integrationName: notice.integrationName, starts: notice.starts })
      return Promise.resolve<readonly NotificationDelivery[]>([])
    },
  }
}
