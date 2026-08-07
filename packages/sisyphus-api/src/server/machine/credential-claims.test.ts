import { describe, expect, it } from 'vitest'

import { CREDENTIAL_RENEWAL_WINDOW_MS } from './credential'
import {
  credentialSigningKey,
  SCOPED_CREDENTIAL_ALGORITHM,
  SCOPED_CREDENTIAL_AUDIENCE,
  SCOPED_CREDENTIAL_ISSUER,
  SCOPED_CREDENTIAL_MAX_LIFETIME_MS,
  SCOPED_CREDENTIAL_WINDOW_MS,
  VALIDATION_SUBJECT_PREFIX,
  validationSubject,
  WORKFLOW_SUBJECT_PREFIX,
  workflowIdFromSubject,
  workflowSubject,
} from './credential-claims'

/**
 * **This file is the only place the claim literals are written out.**
 *
 * They used to be written out three times — here in spirit, in the control plane's mint, and again
 * in the panel's mount — each copy pinned to its literal by its own test and each carrying a
 * comment about the other. `no-restated-claims.test.ts` in both host applications now fails if any
 * of these strings reappears in application source, so this file is the single definition of what
 * the platform means by a machine credential, and the hosts have no opinion of their own.
 *
 * The vocabulary is the whole of FR-037's "one workflow, machine surface only", so these tests are
 * about what the format **cannot express** as much as what it can.
 */

describe('the scoped-credential claim vocabulary', () => {
  it('addresses the machine surface and nothing else', () => {
    expect(SCOPED_CREDENTIAL_AUDIENCE).toBe('sisyphus-machine-surface')
    expect(SCOPED_CREDENTIAL_ISSUER).toBe('sisyphus-control-plane')
  })

  it('pins one symmetric algorithm, so `alg` is never negotiated with the presenter', () => {
    expect(SCOPED_CREDENTIAL_ALGORITHM).toBe('HS256')
  })

  it('types the subject space, so no bare string can pass as a workflow id', () => {
    expect(WORKFLOW_SUBJECT_PREFIX).toBe('workflow:')
    expect(VALIDATION_SUBJECT_PREFIX).toBe('validation:')
  })

  it('keeps the enforced window far shorter than the signed ceiling', () => {
    // The row is what makes a credential short-lived; the ceiling only stops a leaked token
    // outliving any plausible run. If these ever inverted, renewal would extend a credential past
    // the material backing it and every renewed run would fail on the token instead of the row.
    expect(SCOPED_CREDENTIAL_WINDOW_MS).toBe(15 * 60 * 1000)
    expect(SCOPED_CREDENTIAL_MAX_LIFETIME_MS).toBe(12 * 60 * 60 * 1000)
    expect(SCOPED_CREDENTIAL_WINDOW_MS).toBeLessThan(SCOPED_CREDENTIAL_MAX_LIFETIME_MS)
  })

  it('opens the very window `machine.renewCredential` reopens', () => {
    // Identity, not equality of two literals. The two were once separate constants in separate
    // packages held equal by assertion; a renewal that reopened a different window than the mint
    // opened would silently halve or double every credential's life.
    expect(CREDENTIAL_RENEWAL_WINDOW_MS).toBe(SCOPED_CREDENTIAL_WINDOW_MS)
  })
})

describe('subjects', () => {
  it('names one run, and has no way of naming two', () => {
    expect(workflowSubject('w-1')).toBe('workflow:w-1')
    expect(workflowIdFromSubject(workflowSubject('w-1'))).toBe('w-1')
  })

  it('keeps validation runs in a subject space the verifier refuses', () => {
    expect(validationSubject('v-1')).toBe('validation:v-1')
    expect(workflowIdFromSubject(validationSubject('v-1'))).toBeUndefined()
  })

  it('reads no workflow from an absent, empty, bare or foreign subject', () => {
    expect(workflowIdFromSubject(undefined)).toBeUndefined()
    expect(workflowIdFromSubject('')).toBeUndefined()
    expect(workflowIdFromSubject('workflow:')).toBeUndefined()
    expect(workflowIdFromSubject('w-1')).toBeUndefined()
    expect(workflowIdFromSubject('user:w-1')).toBeUndefined()
  })
})

describe('the signing key', () => {
  it('is the secret as bytes', () => {
    expect(credentialSigningKey('abc')).toStrictEqual(new TextEncoder().encode('abc'))
  })

  it('refuses an empty secret rather than producing a forgeable one', () => {
    expect(() => credentialSigningKey('')).toThrow(/empty/i)
  })
})
