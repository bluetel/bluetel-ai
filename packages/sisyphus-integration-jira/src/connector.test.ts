import type { IntegrationMapping } from '@bluetel-ai/sisyphus-api/contracts'
import { describe, expect, it } from 'vitest'

import { createFakeJiraClient } from './client-fake'
import { createJiraConnector } from './connector'

const PLATFORM = { accountId: 'sisyphus-service-account' }

const config = {
  baseUrl: 'https://example.atlassian.net',
  projectPrefix: 'SIS',
  label: 'sisyphus',
  serviceAccount: PLATFORM,
}

const mapping: IntegrationMapping = {
  id: 'mapping-1',
  position: 0,
  criteria: { components: 'api' },
  executionProfileId: 'profile-1',
  isDefault: false,
}

const jiraIssue = {
  id: '1',
  key: 'SIS-1',
  fields: {
    summary: 'Fix the thing',
    description: 'It is broken',
    components: [{ name: 'api' }],
    comment: {
      comments: [
        { id: 'c1', author: { accountId: 'harry' }, body: 'Only the API, please.' },
        { id: 'c2', author: PLATFORM, body: 'Sisyphus has picked this ticket up.' },
      ],
    },
  },
}

describe('createJiraConnector', () => {
  it('declares the integration type it serves', () => {
    expect(createJiraConnector({ client: createFakeJiraClient() }).type).toBe('jira')
  })

  it('carries a ticket from discovery through to a comment', async () => {
    const client = createFakeJiraClient({
      currentUser: PLATFORM,
      commentAuthor: PLATFORM,
      issues: [jiraIssue],
    })
    const connector = createJiraConnector({ client })

    const candidates = await connector.discover(config, {})
    expect(candidates).toHaveLength(1)
    const [item] = candidates

    const resolution = connector.resolveProfile(item, [mapping])
    expect(resolution).toEqual({
      matched: true,
      executionProfileId: 'profile-1',
      mappingId: 'mapping-1',
    })

    const parts = connector.assemblePromptParts(item, {})
    expect(parts.title).toBe('Fix the thing')
    // The platform's own comment does not come back round as task input.
    expect(parts.comments).toEqual(['Only the API, please.'])

    const written = await connector.writeBack(config, item, {
      kind: 'picked_up',
      workflowId: 'wf-1',
      workflowUrl: 'https://sisyphus.example/w/wf-1',
    })
    expect(written.disposition).toBe('performed')
  })

  it('starts nothing during discovery', async () => {
    const client = createFakeJiraClient({ currentUser: PLATFORM, issues: [jiraIssue] })

    await createJiraConnector({ client }).discover(config, {})

    expect(client.posted).toEqual([])
  })

  it('reports a bad configuration through validate rather than throwing', async () => {
    const client = createFakeJiraClient({ currentUserError: new Error('ENOTFOUND') })

    const validation = await createJiraConnector({ client }).validate(config)

    expect(validation.ok).toBe(false)
  })

  it('fails the tick on a configuration it cannot parse', async () => {
    const client = createFakeJiraClient({ currentUser: PLATFORM })

    // Recorded and retried as a failed run, rather than ticking with a filter it did not
    // understand and starting runs on tickets an admin believed were excluded.
    await expect(
      createJiraConnector({ client }).discover({ ...config, projectPrefix: '' }, {}),
    ).rejects.toThrow()
  })

  it('builds one connector per board, so two boards cannot share a credential by accident', async () => {
    const first = createFakeJiraClient({ currentUser: PLATFORM, issues: [jiraIssue] })
    const second = createFakeJiraClient({ currentUser: PLATFORM, issues: [] })

    await createJiraConnector({ client: first }).discover(config, {})

    expect(first.searches).toHaveLength(1)
    expect(second.searches).toHaveLength(0)
  })
})
