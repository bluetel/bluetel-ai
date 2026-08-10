/**
 * Workflow-scoped executor credentials as the **panel** sees them: verification only (FR-037).
 *
 * ## Nothing here is written twice, and nothing here can mint
 *
 * The claim vocabulary and the verifier are `@bluetel-ai/sisyphus-api/server`'s, re-exported
 * through this barrel so the panel's own modules still have one import. They used to be a
 * near-line-for-line copy of `apps/sisyphus-control-plane/src/credentials/`, written because this
 * application cannot import that one — and a second verifier that can disagree with the first
 * about what a valid credential is is a security defect waiting for a divergent edit, not merely
 * duplication. `no-restated-claims.test.ts` fails if any of it reappears in this application.
 *
 * What the panel still contributes is one thing: its JOSE binding, passed to
 * `createScopedCredentialResolver` by `../machine-dependencies.ts`. There is no `SignJWT` behind
 * this barrel, no window and no lifetime ceiling — so a compromise of the panel cannot issue a
 * credential, only fail to accept one. The minting vocabulary is deliberately **not** forwarded
 * here even though the shared module exports it; `index.test.ts` asserts that.
 *
 * ## The validation half, added on the same terms (T200, FR-147)
 *
 * `createValidationCredentialResolver` and its two inspection functions are forwarded alongside the
 * workflow ones because this panel is the host that mounts the machine surface, and a validation
 * instance reaches that mount. They are verifying-side in exactly the same way — there is still no
 * `SignJWT` behind this barrel, and `validationSubject`, `VALIDATION_SUBJECT_PREFIX` and the two
 * window constants stay out of it, so the panel cannot construct a validation subject any more than
 * it can construct a workflow one. The two resolvers are separate functions over separate tables and
 * neither can produce the other's credential.
 *
 * Consumers import this barrel, never a module underneath it.
 */

export {
  bearerTokenFrom,
  CREDENTIAL_HEADER,
  CREDENTIAL_SCHEME,
  createScopedCredentialResolver,
  createValidationCredentialResolver,
  credentialSigningKey,
  inspectScopedCredential,
  inspectValidationCredential,
  SCOPED_CREDENTIAL_ALGORITHM,
  SCOPED_CREDENTIAL_AUDIENCE,
  SCOPED_CREDENTIAL_ISSUER,
  validationRunIdFromSubject,
  verifyScopedCredential,
  verifyValidationCredential,
  WORKFLOW_SUBJECT_PREFIX,
  workflowIdFromSubject,
} from '@bluetel-ai/sisyphus-api/server'
export type {
  ScopedCredentialJwtVerifier,
  ScopedCredentialOutcome,
  ScopedCredentialRefusal,
  ScopedCredentialResolverOptions,
  ValidationCredentialOutcome,
  ValidationCredentialRefusal,
} from '@bluetel-ai/sisyphus-api/server'

export { joseCredentialVerifier } from './jose-binding'

export { resolveNoMachineCredential } from './resolve-no-machine-credential'
