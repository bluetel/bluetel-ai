import * as shared from '@bluetel-ai/sisyphus-api/server'
import { describe, expect, it } from 'vitest'

import * as machineCredential from './index'

/**
 * The barrel is the boundary, so what it does **not** export is as load-bearing as what it does:
 * the panel must be unable to mint a credential, and the shortest guarantee of that is that no
 * signing helper is reachable from here.
 */
describe('the machine-credential barrel', () => {
  it('exposes the verifying half and the interactive surface refusal', () => {
    expect(Object.keys(machineCredential).sort()).toStrictEqual([
      'CREDENTIAL_HEADER',
      'CREDENTIAL_SCHEME',
      'SCOPED_CREDENTIAL_ALGORITHM',
      'SCOPED_CREDENTIAL_AUDIENCE',
      'SCOPED_CREDENTIAL_ISSUER',
      'WORKFLOW_SUBJECT_PREFIX',
      'bearerTokenFrom',
      'createScopedCredentialResolver',
      'createValidationCredentialResolver',
      'credentialSigningKey',
      'inspectScopedCredential',
      'inspectValidationCredential',
      'joseCredentialVerifier',
      'resolveNoMachineCredential',
      'validationRunIdFromSubject',
      'verifyScopedCredential',
      'verifyValidationCredential',
      'workflowIdFromSubject',
    ])
  })

  it('forwards the shared definitions rather than re-declaring them', () => {
    // Identity against the package, not equality of two literals. The panel used to keep its own
    // copy of this vocabulary and its own verifier, pinned to the control plane's by comment; if
    // either were re-introduced locally these would stop being the same objects.
    expect(machineCredential.SCOPED_CREDENTIAL_AUDIENCE).toBe(shared.SCOPED_CREDENTIAL_AUDIENCE)
    expect(machineCredential.SCOPED_CREDENTIAL_ISSUER).toBe(shared.SCOPED_CREDENTIAL_ISSUER)
    expect(machineCredential.SCOPED_CREDENTIAL_ALGORITHM).toBe(shared.SCOPED_CREDENTIAL_ALGORITHM)
    expect(machineCredential.WORKFLOW_SUBJECT_PREFIX).toBe(shared.WORKFLOW_SUBJECT_PREFIX)
    expect(machineCredential.verifyScopedCredential).toBe(shared.verifyScopedCredential)
    expect(machineCredential.createScopedCredentialResolver).toBe(
      shared.createScopedCredentialResolver,
    )
    expect(machineCredential.workflowIdFromSubject).toBe(shared.workflowIdFromSubject)
    expect(machineCredential.bearerTokenFrom).toBe(shared.bearerTokenFrom)
    // The validation half, on the same terms (T200): forwarded, never re-declared.
    expect(machineCredential.createValidationCredentialResolver).toBe(
      shared.createValidationCredentialResolver,
    )
    expect(machineCredential.verifyValidationCredential).toBe(shared.verifyValidationCredential)
    expect(machineCredential.validationRunIdFromSubject).toBe(shared.validationRunIdFromSubject)
  })

  it('exposes nothing that could issue a credential', () => {
    const names = new Set(Object.keys(machineCredential))

    // The minting vocabulary, named explicitly rather than pattern-matched: `credentialSigningKey`
    // is a *verifying* key derivation and legitimately contains "signing".
    for (const forbidden of [
      'mintScopedCredential',
      'mintValidationCredential',
      'validationSubject',
      'workflowSubject',
      'SCOPED_CREDENTIAL_WINDOW_MS',
      'SCOPED_CREDENTIAL_MAX_LIFETIME_MS',
      'VALIDATION_SUBJECT_PREFIX',
    ]) {
      expect(names.has(forbidden)).toBe(false)
    }
  })
})
