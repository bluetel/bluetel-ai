/**
 * Workflow-scoped executor credentials — mint, revoke, verify (T053, FR-037).
 *
 * The whole of FR-037 is reachable behind this barrel: short-lived, one workflow, machine surface
 * only. Minting is here and nowhere else; `machine.renewCredential` extends a `scoped_credentials`
 * row this module wrote and cannot create one. Revocation is a column rather than a wait, which is
 * what makes FR-038's "revoke its credential" an action teardown performs.
 *
 * ## What is here, and what is only re-exported
 *
 * **Local**: `mint.ts` and `revoke.ts`. Both need the signing secret or the ability to write the
 * table, and both are the control plane's alone.
 *
 * **Shared, and re-exported rather than restated**: the claim vocabulary and the verifier, from
 * `@bluetel-ai/sisyphus-api/server`. They used to live here beside the mint, on the argument that
 * the claims, the subject form and the decision that the row owns expiry are one design and a
 * verifier written across a package boundary from its mint is a verifier that drifts. That
 * argument was right about the risk and wrong about the remedy: the machine surface is mounted by
 * the panel, which cannot import this application, so "beside the mint" produced a **second**
 * verifier rather than none. There is now one, in the package both hosts depend on, and this
 * barrel forwards it so a caller in this application still has one import.
 *
 * `no-restated-claims.test.ts` fails if any of the vocabulary reappears as a literal in this
 * application's source.
 *
 * Consumers import this barrel, never a module underneath it.
 */

export {
  bearerTokenFrom,
  CREDENTIAL_HEADER,
  CREDENTIAL_SCHEME,
  createScopedCredentialResolver,
  credentialSigningKey,
  inspectScopedCredential,
  SCOPED_CREDENTIAL_ALGORITHM,
  SCOPED_CREDENTIAL_AUDIENCE,
  SCOPED_CREDENTIAL_ISSUER,
  SCOPED_CREDENTIAL_MAX_LIFETIME_MS,
  SCOPED_CREDENTIAL_WINDOW_MS,
  VALIDATION_SUBJECT_PREFIX,
  validationSubject,
  verifyScopedCredential,
  WORKFLOW_SUBJECT_PREFIX,
  workflowIdFromSubject,
  workflowSubject,
} from '@bluetel-ai/sisyphus-api/server'
export type {
  ScopedCredentialJwtVerifier,
  ScopedCredentialOutcome,
  ScopedCredentialRefusal,
  ScopedCredentialResolverOptions,
} from '@bluetel-ai/sisyphus-api/server'

export { liveCredentialFor, mintScopedCredential, mintValidationCredential } from './mint'
export type { MintedScopedCredential, MintScopedCredentialOptions } from './mint'

export { revokeScopedCredentials } from './revoke'
export type { RevocationOutcome } from './revoke'
