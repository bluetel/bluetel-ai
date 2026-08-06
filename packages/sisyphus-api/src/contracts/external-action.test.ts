import { describe, expect, it } from 'vitest'

import { EXTERNAL_ACTION_KEY_SEPARATOR, externalActionKey, NO_WORKFLOW } from './external-action'

describe('externalActionKey', () => {
  it('produces the executor delivery path key format byte for byte', () => {
    // `apps/sisyphus-executor/src/delivery/external-action.ts` builds a pull request key from
    // action, workflow and the branch pair. Asserting the literal here is what keeps an
    // integration package's comment key the same scheme rather than a second one.
    const key = externalActionKey({
      action: 'pull-request',
      workflowId: 'wf-1',
      target: ['acme/api', 'sisyphus/wf-1', 'main'],
    })

    expect(key).toBe('pull-request:wf-1:acme/api:sisyphus/wf-1:main')
    expect(EXTERNAL_ACTION_KEY_SEPARATOR).toBe(':')
  })

  it('is the same on every attempt of the same action', () => {
    const identity = { action: 'jira-comment', workflowId: 'wf-1', target: ['SIS-1', 'picked_up'] }

    expect(externalActionKey(identity)).toBe(externalActionKey({ ...identity }))
  })

  it('separates actions that differ only in what they are for', () => {
    const pickup = externalActionKey({
      action: 'jira-comment',
      workflowId: 'wf-1',
      target: ['SIS-1', 'picked_up'],
    })
    const outcome = externalActionKey({
      action: 'jira-comment',
      workflowId: 'wf-1',
      target: ['SIS-1', 'outcome'],
    })

    // Without the purpose in the target, the outcome comment would replay as the pickup comment
    // and never be posted.
    expect(pickup).not.toBe(outcome)
  })

  it('separates the same action taken by two different runs', () => {
    const first = externalActionKey({ action: 'a', workflowId: 'wf-1', target: ['SIS-1'] })
    const second = externalActionKey({ action: 'a', workflowId: 'wf-2', target: ['SIS-1'] })

    expect(first).not.toBe(second)
  })

  it('names a run-less action with the sentinel rather than omitting the component', () => {
    const key = externalActionKey({
      action: 'jira-comment',
      workflowId: NO_WORKFLOW,
      target: ['SIS-1', 'skipped', 'no_mapping_matched'],
    })

    expect(key).toBe('jira-comment:no-workflow:SIS-1:skipped:no_mapping_matched')
  })
})
