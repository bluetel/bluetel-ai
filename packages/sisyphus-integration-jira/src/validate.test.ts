/* cspell:words issuekey */
import type { ValidationResult } from '@bluetel-ai/sisyphus-api/contracts'
import { describe, expect, it } from 'vitest'

import { createFakeJiraClient } from './client-fake'
import {
  CONFIGURATION_CHECK,
  CONNECTIVITY_CHECK,
  DISCOVERY_CHECK,
  SERVICE_ACCOUNT_CHECK,
  validate,
} from './validate'

const PLATFORM = { accountId: 'sisyphus-service-account' }

const config = (overrides: Record<string, unknown> = {}) => ({
  baseUrl: 'https://example.atlassian.net',
  projectPrefix: 'SIS',
  label: 'sisyphus',
  serviceAccount: PLATFORM,
  ...overrides,
})

const check = (validation: ValidationResult, name: string) =>
  validation.checks.find((entry) => entry.name === name)

describe('validate', () => {
  it('passes a configuration that reaches Jira and can run its query', async () => {
    const client = createFakeJiraClient({ currentUser: PLATFORM, issues: [] })

    const validation = await validate(client, config())

    expect(validation.ok).toBe(true)
    expect(validation.checks.map((entry) => entry.name)).toEqual([
      CONFIGURATION_CHECK,
      CONNECTIVITY_CHECK,
      SERVICE_ACCOUNT_CHECK,
      DISCOVERY_CHECK,
    ])
  })

  it('actually calls Jira rather than inspecting the configuration', async () => {
    // The requirement in one assertion: a validator that only checked the shape would make no
    // calls at all and would pass everything below.
    const client = createFakeJiraClient({ currentUser: PLATFORM, issues: [] })

    await validate(client, config())

    expect(client.currentUserCalls()).toBe(1)
    expect(client.searches).toHaveLength(1)
  })

  it('runs the query the integration will actually run every tick', async () => {
    const client = createFakeJiraClient({ currentUser: PLATFORM, issues: [] })

    await validate(client, config({ extraFilters: { status: 'Ready' } }))

    expect(client.searches[0]?.jql).toBe(
      'project = "SIS" AND labels = "sisyphus" AND status = "Ready" ' +
        'ORDER BY created ASC, issuekey ASC',
    )
    expect(client.searches[0]?.maxResults).toBe(1)
  })

  it('fails a well-formed configuration pointing at an unreachable deployment', async () => {
    // The whole point of T114: the shape is fine, and it must still not enable.
    const client = createFakeJiraClient({ currentUserError: new Error('ENOTFOUND') })

    const validation = await validate(client, config())

    expect(validation.ok).toBe(false)
    expect(check(validation, CONFIGURATION_CHECK)?.ok).toBe(true)
    expect(check(validation, CONNECTIVITY_CHECK)?.ok).toBe(false)
    expect(check(validation, CONNECTIVITY_CHECK)?.detail).toContain('ENOTFOUND')
  })

  it('fails a revoked credential', async () => {
    const client = createFakeJiraClient({ currentUserError: new Error('401 Unauthorized') })

    const validation = await validate(client, config())

    expect(validation.ok).toBe(false)
    expect(check(validation, CONNECTIVITY_CHECK)?.detail).toContain('401')
  })

  it('does not report checks it never ran', async () => {
    const client = createFakeJiraClient({ currentUserError: new Error('ENOTFOUND') })

    const validation = await validate(client, config())

    expect(check(validation, DISCOVERY_CHECK)).toBeUndefined()
  })

  it('fails a mistyped project key, because the discovery query is rejected', async () => {
    const client = createFakeJiraClient({
      currentUser: PLATFORM,
      searchError: new Error("The value 'SSI' does not exist for the field 'project'"),
    })

    const validation = await validate(client, config({ projectPrefix: 'SSI' }))

    expect(validation.ok).toBe(false)
    expect(check(validation, DISCOVERY_CHECK)?.ok).toBe(false)
    expect(check(validation, DISCOVERY_CHECK)?.detail).toContain('does not exist')
  })

  it('fails when the credential is not the configured service account', async () => {
    // Silent and expensive: every run would comment as an account the next run does not
    // recognise, and would read its own comments back as task input.
    const client = createFakeJiraClient({ currentUser: { accountId: 'someone-else' } })

    const validation = await validate(client, config())

    expect(validation.ok).toBe(false)
    expect(check(validation, SERVICE_ACCOUNT_CHECK)?.detail).toContain('fed back')
  })

  it('accepts a service account left unset when the credential has an identity', async () => {
    const client = createFakeJiraClient({ currentUser: { accountId: 'derived-account' } })

    const validation = await validate(client, config({ serviceAccount: undefined }))

    expect(validation.ok).toBe(true)
    expect(check(validation, SERVICE_ACCOUNT_CHECK)?.detail).toContain('derived-account')
  })

  it('fails when neither the configuration nor the credential yields an identity', async () => {
    const client = createFakeJiraClient({ currentUser: {} })

    const validation = await validate(client, config({ serviceAccount: undefined }))

    expect(validation.ok).toBe(false)
    expect(check(validation, SERVICE_ACCOUNT_CHECK)?.ok).toBe(false)
  })

  it('fails a malformed configuration without calling Jira at all', async () => {
    const client = createFakeJiraClient({ currentUser: PLATFORM })

    const validation = await validate(client, config({ baseUrl: 'not-a-url' }))

    expect(validation.ok).toBe(false)
    expect(validation.checks).toHaveLength(1)
    expect(check(validation, CONFIGURATION_CHECK)?.detail).toContain('baseUrl')
    expect(client.currentUserCalls()).toBe(0)
  })

  it('rejects a plaintext base URL before it sends a credential to it', async () => {
    const client = createFakeJiraClient({ currentUser: PLATFORM })

    const validation = await validate(client, config({ baseUrl: 'http://example.atlassian.net' }))

    expect(validation.ok).toBe(false)
    expect(client.currentUserCalls()).toBe(0)
  })

  it('never throws, whatever the deployment does', async () => {
    const client = createFakeJiraClient({
      currentUser: PLATFORM,
      searchError: new Error('request failed: authorization: Basic totally-not-a-real-token'),
    })

    const validation = await validate(client, config())

    expect(validation.ok).toBe(false)
    // And never carries the credential out in the message it shows the admin.
    expect(JSON.stringify(validation)).not.toContain('totally-not-a-real-token')
  })

  it('comments on nothing while validating', async () => {
    const client = createFakeJiraClient({ currentUser: PLATFORM })

    await validate(client, config())

    expect(client.posted).toEqual([])
  })
})
