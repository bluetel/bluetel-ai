import { describe, expect, it } from 'vitest'

import {
  capLimitsFrom,
  JobEnvelopeError,
  parseJobEnvelope,
  primaryEntry,
  WORKSPACE_ROOT,
} from './job-envelope'
import type { WorkflowJobEnvelope } from './job-envelope'

const CREDENTIAL = 'eyJhbGciOiJIUzI1NiJ9.scoped-to-one-workflow.signature'

const workflowEnvelope = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  mode: 'workflow',
  workflowId: '019fd631-15bf-7a03-a1c6-ff6d568c2654',
  sessionId: '019fd631-15bf-7a03-a1c6-ff6d568c2655',
  machineSurfaceUrl: 'https://sisyphus.test/api/machine',
  scopedCredential: CREDENTIAL,
  setupBundle: { s3Key: 'bundles/acme/3.tar.zst', contentDigest: 'a'.repeat(64), version: 3 },
  workspace: {
    root: WORKSPACE_ROOT,
    entries: [
      {
        entryId: '019fd631-15bf-7a03-a1c6-ff6d568c2660',
        repositoryUrl: 'https://git.test/acme/app.git',
        baseBranch: 'integration-line',
        subdirectory: 'app',
        isPrimary: true,
      },
    ],
  },
  job: { model: 'claude-opus-5', turnCap: 40, spendCap: '12.5000', workflowType: 'delegated' },
  prompt: { assembled: 'Add a changelog entry.' },
  ...overrides,
})

describe('parseJobEnvelope', () => {
  it('reads a workflow envelope as the control plane encodes it', () => {
    const envelope = parseJobEnvelope(JSON.stringify(workflowEnvelope()))

    expect(envelope.mode).toBe('workflow')
    expect(envelope.machineSurfaceUrl).toBe('https://sisyphus.test/api/machine')

    const workflow = envelope as WorkflowJobEnvelope

    expect(workflow.job.workflowType).toBe('delegated')
    expect(workflow.workspace.entries).toHaveLength(1)
    expect(workflow.resumeFromSnapshot).toBeUndefined()
  })

  it('reads a validation envelope, which has no workflow at all (FR-147)', () => {
    const envelope = parseJobEnvelope(
      JSON.stringify({
        mode: 'validation',
        machineSurfaceUrl: 'https://sisyphus.test/api/machine',
        scopedCredential: CREDENTIAL,
        setupBundle: { s3Key: 'bundles/acme/3.tar.zst', contentDigest: 'a'.repeat(64), version: 3 },
      }),
    )

    expect(envelope.mode).toBe('validation')
    expect(envelope).not.toHaveProperty('workflowId')
  })

  it('carries the resume reference when there is one (FR-050)', () => {
    const envelope = parseJobEnvelope(
      JSON.stringify(
        workflowEnvelope({
          resumeFromSnapshot: {
            s3Key: 'snapshots/w/1.tar.zst',
            sessionId: '019fd631-15bf-7a03-a1c6-ff6d568c2656',
          },
        }),
      ),
    ) as WorkflowJobEnvelope

    expect(envelope.resumeFromSnapshot?.sessionId).toBe('019fd631-15bf-7a03-a1c6-ff6d568c2656')
  })

  it('refuses text that is not JSON, naming that and nothing else', () => {
    expect(() => parseJobEnvelope('not json at all')).toThrow(JobEnvelopeError)
    expect(() => parseJobEnvelope('not json at all')).toThrow(/not valid JSON/u)
  })

  it('names every problem rather than the first', () => {
    let problems: readonly string[] = []

    try {
      parseJobEnvelope(
        JSON.stringify(workflowEnvelope({ workflowId: 'not-a-uuid', prompt: { assembled: '' } })),
      )
    } catch (error) {
      problems = error instanceof JobEnvelopeError ? error.problems : []
    }

    expect(problems.length).toBeGreaterThan(1)
    expect(problems.join(' ')).toContain('workflowId')
    expect(problems.join(' ')).toContain('prompt.assembled')
  })

  it('never quotes the envelope back, so the credential stays out of the message', () => {
    let message = ''

    try {
      parseJobEnvelope(JSON.stringify(workflowEnvelope({ workflowId: 'not-a-uuid' })))
    } catch (error) {
      message = error instanceof Error ? error.message : ''
    }

    expect(message).not.toContain(CREDENTIAL)
  })

  it('refuses a workspace root the snapshot path could not restore (FR-051)', () => {
    expect(() =>
      parseJobEnvelope(
        JSON.stringify(
          workflowEnvelope({
            workspace: {
              root: '/home/runner/work',
              entries: [
                {
                  entryId: '019fd631-15bf-7a03-a1c6-ff6d568c2660',
                  repositoryUrl: 'https://git.test/acme/app.git',
                  baseBranch: 'integration-line',
                  subdirectory: 'app',
                  isPrimary: true,
                },
              ],
            },
          }),
        ),
      ),
    ).toThrow(/workspace\.root/u)
  })

  it('refuses a workspace without exactly one primary entry (FR-110)', () => {
    const entries = [
      {
        entryId: '019fd631-15bf-7a03-a1c6-ff6d568c2660',
        repositoryUrl: 'https://git.test/acme/app.git',
        baseBranch: 'integration-line',
        subdirectory: 'app',
        isPrimary: true,
      },
      {
        entryId: '019fd631-15bf-7a03-a1c6-ff6d568c2661',
        repositoryUrl: 'https://git.test/acme/lib.git',
        baseBranch: 'integration-line',
        subdirectory: 'lib',
        isPrimary: true,
      },
    ]

    expect(() =>
      parseJobEnvelope(
        JSON.stringify(workflowEnvelope({ workspace: { root: WORKSPACE_ROOT, entries } })),
      ),
    ).toThrow(/exactly one primary entry/u)
  })

  it('refuses a model or workflow type the platform does not have', () => {
    expect(() =>
      parseJobEnvelope(
        JSON.stringify(
          workflowEnvelope({
            job: {
              model: 'gpt-9',
              turnCap: null,
              spendCap: null,
              workflowType: 'delegated',
            },
          }),
        ),
      ),
    ).toThrow(/job\.model/u)

    expect(() =>
      parseJobEnvelope(
        JSON.stringify(
          workflowEnvelope({
            job: {
              model: 'claude-opus-5',
              turnCap: null,
              spendCap: null,
              workflowType: 'freestyle',
            },
          }),
        ),
      ),
    ).toThrow(/job\.workflowType/u)
  })
})

describe('primaryEntry', () => {
  it('answers the entry the skills are read from', () => {
    const envelope = parseJobEnvelope(JSON.stringify(workflowEnvelope())) as WorkflowJobEnvelope

    expect(primaryEntry(envelope).subdirectory).toBe('app')
  })
})

describe('capLimitsFrom', () => {
  it('normalises a declared cap into the enforcer’s shape', () => {
    expect(
      capLimitsFrom({
        model: 'claude-opus-5',
        turnCap: 40,
        spendCap: '12.5000',
        workflowType: 'delegated',
      }),
    ).toStrictEqual({ turnCap: 40, spendCapUsd: 12.5 })
  })

  it('omits a cap the run did not set rather than defaulting one', () => {
    expect(
      capLimitsFrom({
        model: 'claude-opus-5',
        turnCap: null,
        spendCap: null,
        workflowType: 'autonomous',
      }),
    ).toStrictEqual({})
  })
})
