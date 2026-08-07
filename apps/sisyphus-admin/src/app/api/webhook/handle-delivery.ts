import type { ReplayStore } from './replay-guard'
import type { VerificationFailure } from './verify-signature'
import { SIGNATURE_HEADER, verifyDelivery } from './verify-signature'

/**
 * The delivery pipeline, apart from the route (T122, FR-017).
 *
 * Split out so the **order** — the thing the requirement is actually about — is a function a test
 * can drive without a Next.js request, a database or an environment. `route.ts` is then the
 * adapter: read the body as text, call this, turn the result into a `Response`.
 *
 * ```
 * 1. read the body as TEXT — nothing is parsed yet
 * 2. verify the signature, which also identifies the integration    ← before any parsing
 * 3. reject a signature already seen                                ← replay
 * 4. only now: parse the body
 * 5. act on the integration the *signature* named, never the body
 * ```
 *
 * Steps 2 and 5 are the two the task calls out, and they are the same rule seen twice: a request is
 * whatever its signature proves it is, and its content is data. Letting the body name the
 * integration would let anyone who can reach the URL choose which client's credentials the
 * resulting run uses — the body is attacker-controlled by definition, and a signature over it does
 * not change that, because the signature only says *someone with a key* wrote it.
 */

/** What the platform does once a delivery is verified. Injected, so this module reaches nothing. */
export interface DeliverySink {
  /**
   * Signal that this integration has work waiting.
   *
   * @returns `false` when the integration does not exist or is disabled — a delivery for a board
   *   that has been switched off is accepted and ignored, not acted on.
   */
  readonly notify: (integrationId: string) => Promise<boolean>
}

export interface HandleDeliveryOptions {
  readonly headers: Headers
  /** The body **as text**, exactly as received. */
  readonly rawBody: string
  readonly deploymentSecret: string | undefined
  readonly replay: ReplayStore
  readonly sink: DeliverySink
  readonly now?: number
}

export type DeliveryOutcome =
  | { readonly status: 202; readonly result: 'accepted'; readonly integrationId: string }
  | { readonly status: 202; readonly result: 'ignored'; readonly integrationId: string }
  | { readonly status: 400; readonly result: 'unparsable_body' }
  | { readonly status: 401; readonly result: VerificationFailure }
  | { readonly status: 409; readonly result: 'replayed' }

/** Fields that would name an integration. Present in a body, they are ignored — see below. */
export const IDENTITY_FIELDS = ['integrationId', 'integration_id', 'integration'] as const

/**
 * Run the pipeline.
 *
 * @param options - See {@link HandleDeliveryOptions}.
 * @returns The status to answer with and why. Never throws.
 */
export const handleDelivery = async (options: HandleDeliveryOptions): Promise<DeliveryOutcome> => {
  const now = options.now ?? Date.now()

  // 2. Verify. Nothing has looked inside `rawBody` at this point, and nothing will unless this
  //    passes. The result carries the key id, which *is* the integration's identity.
  const verification = verifyDelivery({
    headers: options.headers,
    rawBody: options.rawBody,
    deploymentSecret: options.deploymentSecret,
    now,
  })

  if (!verification.verified) {
    return { status: 401, result: verification.failure }
  }

  // 3. A signature already accepted is a replay, however well-formed it is.
  const signature = options.headers.get(SIGNATURE_HEADER) ?? ''

  if (!(await options.replay.claim(signature, now))) {
    return { status: 409, result: 'replayed' }
  }

  // 4. Only now. The body is parsed to confirm it is well-formed — a sender producing malformed
  //    JSON is a misconfiguration worth reporting — and for nothing else.
  try {
    JSON.parse(options.rawBody)
  } catch {
    return { status: 400, result: 'unparsable_body' }
  }

  // 5. The integration comes from `verification.keyId` and from nowhere else. Deliberately not
  //    `body.integrationId`: see the note at the top of this file.
  const acted = await options.sink.notify(verification.keyId)

  return acted
    ? { status: 202, result: 'accepted', integrationId: verification.keyId }
    : { status: 202, result: 'ignored', integrationId: verification.keyId }
}
