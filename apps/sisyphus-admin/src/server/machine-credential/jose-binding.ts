import type { ScopedCredentialJwtVerifier } from '@bluetel-ai/sisyphus-api/server'
import { jwtVerify } from 'jose'

/**
 * The whole of what this application contributes to credential verification: a JOSE implementation.
 *
 * ## Why it is an assignment and not a wrapper
 *
 * The panel and the control plane each used to carry a complete verifier, because neither can
 * import the other. The shared one now lives in `@bluetel-ai/sisyphus-api/server`, and that package
 * takes no cryptography dependency of its own — it declares the shape it needs and a host supplies
 * it.
 *
 * A host could satisfy that shape with an adapter, and an adapter is where the duplication would
 * grow back: a few lines that decide which options to pass, written twice, free to diverge. So
 * {@link ScopedCredentialJwtVerifier} is deliberately signature-compatible with `jose`'s
 * `jwtVerify`, and this file is the assignment. There is no expression here that could check
 * something different from what the control plane checks, because there is no expression here.
 *
 * If the shared type ever drifted from `jose`'s signature this line would stop compiling — a
 * better warning than an adapter that keeps compiling while quietly checking less.
 *
 * ## What it is trusted with, and what it is not
 *
 * The signature, and nothing else. The pinned algorithm, issuer and audience are handed to it by
 * the shared verifier and then **re-checked** there against the claims it reports, so a binding
 * that ignored them could not widen what this mount accepts. Expiry of the credential itself is
 * not its business at all: the token's `exp` is a twelve-hour ceiling, and the fifteen-minute
 * window FR-037 asks for is `scoped_credentials.expires_at`, read from the row.
 */
export const joseCredentialVerifier: ScopedCredentialJwtVerifier = jwtVerify
