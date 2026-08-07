import { describe, expect, it } from 'vitest'

import type {
  IntegrationsClient,
  IntegrationSubmission,
  IntegrationView,
} from './integrations-client'

/**
 * The port carries no runtime values — it is the screen's statement of what the server owes it, and
 * `api-integrations-client.ts` is the one implementation. So the assertions here are about the
 * shape: that the panel's seven calls are all still declared, and that neither direction of the
 * contract has grown a credential it could read back (T199, FR-098).
 *
 * A stand-in implementation is built rather than described, because building one is what makes
 * `tsc` check the method set: a procedure added to the port without being added below stops this
 * file compiling.
 */
const stub: IntegrationsClient = {
  list: () => Promise.resolve([]),
  create: () => Promise.resolve(),
  update: () => Promise.resolve(),
  setEnabled: () => Promise.resolve(),
  validate: () => Promise.resolve({ ok: true, checks: [] }),
  runNow: () => Promise.resolve(),
  remove: () => Promise.resolve(),
  runs: () => Promise.resolve([]),
  previewPrompt: () =>
    Promise.resolve({
      prompt: '',
      truncated: false,
      truncatedComments: 0,
      resolvedProfileId: undefined,
      resolutionReason: undefined,
    }),
}

describe('IntegrationsClient', () => {
  it('declares every call the panel makes, including the two FR-097 and FR-105 require', () => {
    expect(Object.keys(stub).sort()).toStrictEqual([
      'create',
      'list',
      'previewPrompt',
      'remove',
      'runNow',
      'runs',
      'setEnabled',
      'update',
      'validate',
    ])
  })

  it('covers the six admin actions FR-097 names', () => {
    // create, edit, enable, disable, delete, manually trigger — enable and disable are one call.
    for (const call of ['create', 'update', 'setEnabled', 'remove', 'runNow'] as const) {
      expect(stub).toHaveProperty(call)
    }
  })

  it('has no unavailable-client fallback left to mistake for a real refusal (T199)', async () => {
    const exported: Record<string, unknown> = await import('./integrations-client')

    expect(exported).not.toHaveProperty('createUnavailableIntegrationsClient')
    expect(exported).not.toHaveProperty('INTEGRATIONS_UNAVAILABLE')
  })
})

describe('the credential is write-only in the port itself (FR-098)', () => {
  it('is absent from what the panel receives', () => {
    // Typed, then keyed: the annotation is the real assertion — an object literal carrying
    // `credentialSecretArn` would not compile as an `IntegrationView`.
    const view: IntegrationView = {
      id: 'integration-1',
      type: 'jira',
      name: 'Platform board',
      baseUrl: 'https://example.atlassian.net',
      projectPrefix: 'PROJ',
      label: 'autonomous',
      extraFilters: null,
      defaultOwnerUserId: null,
      promptIntro: '',
      cronExpression: '*/15 * * * *',
      timezone: 'Europe/London',
      perTickCeiling: 5,
      rollingPeriodCeiling: 20,
      rollingPeriodMinutes: 60,
      enabled: false,
      consecutiveFailures: 0,
      autoDisabledReason: null,
      scheduleArn: null,
      mappings: [],
      claimedTicketCount: 0,
      startedWorkflowCount: 0,
      lastRun: undefined,
    }

    expect(Object.keys(view).join(' ').toLowerCase()).not.toContain('credential')
  })

  it('is present on what the panel sends, which is the half that must exist', () => {
    const submission: IntegrationSubmission = {
      name: 'Platform board',
      baseUrl: 'https://example.atlassian.net',
      credentialSecretArn: 'arn:aws:secretsmanager:eu-west-1:1:secret:jira',
      projectPrefix: 'PROJ',
      label: 'autonomous',
      extraFilters: null,
      defaultOwnerUserId: null,
      promptIntro: 'Deliver the ticket.',
      cronExpression: '*/15 * * * *',
      timezone: 'Europe/London',
      perTickCeiling: 5,
      rollingPeriodCeiling: 20,
      rollingPeriodMinutes: 60,
      mappings: [],
    }

    expect(submission.credentialSecretArn).toContain('arn:aws:secretsmanager')
  })
})
