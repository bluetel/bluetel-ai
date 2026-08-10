import {
  AGENT_CREDENTIAL_MATERIAL_FIELD,
  agentCredentialReference,
} from '@bluetel-ai/sisyphus-api/contracts'
import { describe, expect, it } from 'vitest'

import type { WorkflowJobEnvelope } from './job-envelope'
import { encodeUserData, MAX_USER_DATA_BYTES, WORKSPACE_ROOT } from './job-envelope'

/**
 * FR-036's rule about the envelope is a rule about **absence**, so the load-bearing test here is
 * the one that reads the serialised text and asserts that a set of long-lived secrets is nowhere
 * in it. An envelope is user data: readable through the metadata service by every process on the
 * instance, for as long as the instance exists. The scoped credential belongs there because it is
 * bounded on three axes; a repository token belongs there on none.
 *
 * 003/FR-012 says the same thing about the agent credential and says it harder, so the tests under
 * "no field on this envelope can carry material" are written to fail on a *shape* rather than on a
 * value. Asserting that one fixture happens not to contain a secret proves nothing about the next
 * field somebody adds; asserting that every field is a shape which refuses material does.
 */

const AGENT_CREDENTIAL_ID = '77777777-7777-7777-7777-777777777777'

const envelope = (assembled: string): WorkflowJobEnvelope => ({
  workflowId: '44444444-4444-4444-4444-444444444444',
  sessionId: '55555555-5555-5555-5555-555555555555',
  machineSurfaceUrl: 'https://sisyphus.example/api/machine',
  scopedCredential: 'header.payload.signature',
  agentCredential: { credentialId: AGENT_CREDENTIAL_ID, leaseFence: 4 },
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
      'agentCredential',
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

/** Every key in a serialised envelope, at every depth, so the sweep below misses no nesting. */
const keysOf = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.flatMap(keysOf)
    : typeof value === 'object' && value !== null
      ? Object.entries(value).flatMap(([key, nested]) => [key, ...keysOf(nested)])
      : []

describe('no field on the job envelope can carry agent credential material (FR-012, SC-014)', () => {
  it('names the seat with identifiers and nothing else', () => {
    const { agentCredential } = envelope('Do the thing.')

    // Parsed by the contract's own schema rather than compared field by field. That schema is the
    // one the machine surface and the executor read, so an envelope that satisfies it cannot drift
    // away from what those two agree a reference is.
    expect(agentCredentialReference.parse(agentCredential)).toStrictEqual({
      credentialId: AGENT_CREDENTIAL_ID,
      leaseFence: 4,
    })
  })

  it('refuses material smuggled onto the reference, because the schema is strict', () => {
    // The load-bearing assertion, and the reason `agentCredentialReference` is `.strict()` rather
    // than merely narrow. Zod's default is to *strip* unknown keys: a permissive schema would parse
    // this successfully, quietly drop the field, and leave a test that passes for a reason having
    // nothing to do with the guarantee. A refusal is something the surface can record.
    const smuggled = {
      credentialId: AGENT_CREDENTIAL_ID,
      leaseFence: 4,
      [AGENT_CREDENTIAL_MATERIAL_FIELD]: 'sk-the-agents-actual-login',
    }

    expect(() => agentCredentialReference.parse(smuggled)).toThrow()
    expect(agentCredentialReference.safeParse(smuggled).success).toBe(false)
  })

  it('has no field named `material` anywhere in it, at any depth', () => {
    // By name, not by value, and recursively. `AGENT_CREDENTIAL_MATERIAL_FIELD` is the single field
    // in the contract that ever holds material — it appears on the fetch response and on the
    // rotation report, both of which are instance-to-surface only — so its absence here is a
    // machine-checkable statement about the whole envelope rather than about this fixture's values.
    const parsed: unknown = JSON.parse(encodeUserData(envelope('Do the thing.'), 'under test'))

    expect(keysOf(parsed)).toContain('agentCredential')
    expect(keysOf(parsed)).not.toContain(AGENT_CREDENTIAL_MATERIAL_FIELD)
  })

  it('carries no field whose value could be a login, only ids and a fence', () => {
    const text = encodeUserData(envelope('Do the thing.'), 'under test')

    // The envelope becomes EC2 user data, readable from the instance metadata service by anything
    // on the box and surviving into any image taken of it. The instance is expected to *fetch* the
    // material, authorised by the scoped credential this envelope does carry — which is revocable,
    // as a copy in user data would not be.
    expect(text).toContain(`"credentialId":"${AGENT_CREDENTIAL_ID}"`)
    expect(text).toContain('"leaseFence":4')
    for (const forbidden of ['agentCredentialMaterial', 'agentCredentialSecret', 'secretId']) {
      expect(text).not.toContain(forbidden)
    }
  })

  it('omits the seat entirely rather than carrying a null for a run admitted without one', () => {
    // The T064 window: until admission refuses to provision without a seat, a run whose execution
    // profile reaches no credential is still admitted. The executor branches on the field's
    // presence, so absence is expressed by omission — the same rule `resumeFromSnapshot` follows.
    const without: WorkflowJobEnvelope = {
      ...envelope('Do the thing.'),
      agentCredential: undefined,
    }

    expect(encodeUserData(without, 'under test')).not.toContain('agentCredential')
  })
})
