import { describe, expect, it } from 'vitest'

import type { WorkflowJobEnvelope } from './job-envelope'
import { encodeUserData, MAX_USER_DATA_BYTES, WORKSPACE_ROOT } from './job-envelope'

/**
 * FR-036's rule about the envelope is a rule about **absence**, so the load-bearing test here is
 * the one that reads the serialised text and asserts that a set of long-lived secrets is nowhere
 * in it. An envelope is user data: readable through the metadata service by every process on the
 * instance, for as long as the instance exists. The scoped credential belongs there because it is
 * bounded on three axes; a repository token belongs there on none.
 */

const envelope = (assembled: string): WorkflowJobEnvelope => ({
  workflowId: '44444444-4444-4444-4444-444444444444',
  sessionId: '55555555-5555-5555-5555-555555555555',
  machineSurfaceUrl: 'https://sisyphus.example/api/machine',
  scopedCredential: 'header.payload.signature',
  setupBundle: { s3Key: 'bundles/1.tar.gz', contentDigest: 'sha256:abc', version: 3 },
  workspace: {
    root: WORKSPACE_ROOT,
    entries: [
      {
        entryId: '66666666-6666-6666-6666-666666666666',
        repositoryUrl: 'https://example.invalid/app.git',
        baseBranch: 'main',
        subdirectory: 'app',
        isPrimary: true,
      },
    ],
  },
  job: { model: 'claude-opus-5', turnCap: 40, spendCap: '25.00', workflowType: 'delegated' },
  prompt: { assembled },
  mode: 'workflow',
})

describe('the job envelope', () => {
  it('pins the workspace root, which a snapshot is only resumable against', () => {
    expect(WORKSPACE_ROOT).toBe('/workspace')
  })

  it('carries the references an instance needs and none of the secrets it installs itself', () => {
    const text = encodeUserData(envelope('Do the thing.'), 'workflow under test')

    // Present: the run's identity, where to report, the short-lived credential, and *references*
    // to everything else.
    expect(text).toContain('"scopedCredential":"header.payload.signature"')
    expect(text).toContain('"s3Key":"bundles/1.tar.gz"')
    expect(text).toContain('"contentDigest":"sha256:abc"')

    // Absent, and this is FR-036: the bundle installs these on the instance, so none of them ever
    // travels through a channel that stays readable for the instance's whole life.
    for (const forbidden of [
      'agentApiKey',
      'repositoryToken',
      'ticketToken',
      'awsAccessKeyId',
      'awsSecretAccessKey',
      'credentialSecret',
      'signingSecret',
      'databaseUrl',
    ]) {
      expect(text).not.toContain(forbidden)
    }
  })

  it('does not carry the secret its own credential was signed with', () => {
    // The one that would undo the whole scheme: with the signing secret on the instance, the
    // executor could mint itself a credential for any workflow it liked.
    const text = encodeUserData(envelope('Do the thing.'), 'workflow under test')
    const parsed: unknown = JSON.parse(text)

    expect(Object.keys(parsed as Record<string, unknown>).sort()).toStrictEqual([
      'job',
      'machineSurfaceUrl',
      'mode',
      'prompt',
      'scopedCredential',
      'sessionId',
      'setupBundle',
      'workflowId',
      'workspace',
    ])
  })

  it('omits resumeFromSnapshot rather than carrying a null the executor would have to read', () => {
    expect(encodeUserData(envelope('x'), 'workflow under test')).not.toContain('resumeFromSnapshot')
  })

  it('refuses an envelope over the user-data cap, naming the overage', () => {
    const oversized = envelope('x'.repeat(MAX_USER_DATA_BYTES))

    expect(() => encodeUserData(oversized, 'workflow under test')).toThrow(
      /over the 16384-byte user-data limit/,
    )
    // Failing here means the message names the assembled prompt; failing at RunInstances would
    // produce one about a malformed request.
    expect(() => encodeUserData(oversized, 'workflow under test')).toThrow(/assembled prompt/)
  })

  it('accepts an envelope that just fits', () => {
    const text = encodeUserData(envelope('x'.repeat(1024)), 'workflow under test')

    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(MAX_USER_DATA_BYTES)
  })

  it('serialises a validation envelope with no workflow, workspace or prompt', () => {
    const text = encodeUserData(
      {
        machineSurfaceUrl: 'https://sisyphus.example/api/machine',
        scopedCredential: 'header.payload.signature',
        setupBundle: { s3Key: 'bundles/1.tar.gz', contentDigest: 'sha256:abc', version: 3 },
        mode: 'validation',
      },
      'validation run under test',
    )

    // FR-147: the absence is the requirement. A validation envelope that carried an empty prompt
    // or an empty workspace would be the beginning of loosening the workflow columns to match.
    expect(text).not.toContain('workflowId')
    expect(text).not.toContain('workspace')
    expect(text).not.toContain('prompt')
    expect(text).toContain('"mode":"validation"')
  })
})
