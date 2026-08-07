import { describe, expect, it } from 'vitest'

import { createFakeWorkflowNotifier } from './notifier-fake'

describe('createFakeWorkflowNotifier', () => {
  it('records every workflow event in order, so a sweep of three is distinguishable from one', async () => {
    const notifier = createFakeWorkflowNotifier()

    await notifier.workflowEvent({ workflowId: 'w1', event: 'workflow_failed' })
    await notifier.workflowEvent({ workflowId: 'w2', event: 'workflow_parked_resumable' })

    expect(notifier.notices).toStrictEqual([
      { workflowId: 'w1', event: 'workflow_failed' },
      { workflowId: 'w2', event: 'workflow_parked_resumable' },
    ])
  })

  it('records tick summaries with the runs they covered', async () => {
    const notifier = createFakeWorkflowNotifier()
    const starts = [{ workflowId: 'w1', ownerUserId: 'ada' }]

    await notifier.integrationTick({ integrationName: 'Payments board', starts })

    expect(notifier.tickNotices).toStrictEqual([{ integrationName: 'Payments board', starts }])
  })

  it('answers with an empty result rather than an invented delivery', async () => {
    const notifier = createFakeWorkflowNotifier()

    expect(
      await notifier.workflowEvent({ workflowId: 'w1', event: 'workflow_failed' }),
    ).toStrictEqual({ deliveries: [], deferred: [] })
    expect(await notifier.integrationTick({ integrationName: null, starts: [] })).toStrictEqual([])
  })

  it('can be made to fail, which is how the FR-141 guard in each job is proved', async () => {
    const notifier = createFakeWorkflowNotifier({ failure: new Error('the notifier is broken') })

    await expect(
      notifier.workflowEvent({ workflowId: 'w1', event: 'workflow_failed' }),
    ).rejects.toThrow('the notifier is broken')
    await expect(notifier.integrationTick({ integrationName: null, starts: [] })).rejects.toThrow(
      'the notifier is broken',
    )

    notifier.failWith(undefined)

    await notifier.workflowEvent({ workflowId: 'w2', event: 'workflow_failed' })
    expect(notifier.notices).toStrictEqual([{ workflowId: 'w2', event: 'workflow_failed' }])
  })
})
