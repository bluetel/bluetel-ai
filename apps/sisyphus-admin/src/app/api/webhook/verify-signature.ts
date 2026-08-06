import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Verifying a webhook delivery — **before** anything is parsed (T122, FR-017).
 *
 * ## Order is the requirement, not hardening
 *
 * Parsing first means the platform has already executed on unverified input: a JSON parser, a
 * schema, a date coercion and whatever a resolver does with the result, all reachable by anyone who
 * can reach the URL. So this module takes the body as **text** and never looks inside it. The route
 * calls {@link verifyDelivery} and only calls `JSON.parse` on what it returns.
 *
 * ## Why the key id is inside the signed material
 *
 * `SISYPHUS_WEBHOOK_SIGNING_SECRET` is one deployment-wide secret, and one shared secret cannot by
 * itself say *which* integration a delivery is for — anyone holding it could sign for any of them.
 * So each integration is given its own key, **derived** from the deployment secret and the
 * integration id ({@link deriveIntegrationKey}). A sender holding board A's key cannot compute board
 * B's, because that needs the deployment secret.
 *
 * The key id is then bound into the signed material as well ({@link signedPayload}), which closes
 * the other half: a signature produced for board A cannot be replayed with the header changed to
 * board B, because the header is part of what was signed.
 *
 * **This is why the body never names the integration.** A delivery says who it is by presenting a
 * signature only that integration's key could produce; the body is data, and letting data choose
 * the integration would let an attacker pick which client's credentials the resulting run uses.
 *
 * ## Timing-safe, and equal-length first
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be an oracle if it were allowed
 * to escape as a different response. Lengths are compared first and a mismatch is reported as an
 * ordinary failed verification.
 */

/** The signature scheme, carried in the header so it can be rotated without guessing. */
export const SIGNATURE_VERSION = 'v1'

export const KEY_ID_HEADER = 'x-sisyphus-key-id'
export const TIMESTAMP_HEADER = 'x-sisyphus-timestamp'
export const SIGNATURE_HEADER = 'x-sisyphus-signature'

/** How far out of date a delivery may be. Five minutes is generous for clock skew and slow retries. */
export const REPLAY_WINDOW_MS = 5 * 60 * 1000

/**
 * The per-integration key.
 *
 * Derived rather than stored, so adding an integration adds no secret to manage and rotating the
 * deployment secret rotates every integration's key at once. The label keeps this derivation
 * separate from any other use of the same secret.
 */
export const deriveIntegrationKey = (deploymentSecret: string, keyId: string): Buffer =>
  createHmac('sha256', deploymentSecret).update(`sisyphus-webhook-key:${keyId}`).digest()

/**
 * Exactly what is signed.
 *
 * The version, the key id and the timestamp are all inside it, and the key id is **length-prefixed**
 * — which is what makes the encoding unambiguous. Plain concatenation with a delimiter is not: a key
 * id containing the delimiter could be split differently by a verifier than by the signer, so a
 * signature over one (keyId, timestamp) pair would also be valid for another. The key id is
 * attacker-supplied, so that is a live possibility rather than a theoretical one.
 */
export const signedPayload = (input: {
  readonly keyId: string
  readonly timestamp: string
  readonly rawBody: string
}): string =>
  `${SIGNATURE_VERSION}:${String(input.keyId.length)}:${input.keyId}:${input.timestamp}:${input.rawBody}`

/** The signature a sender should produce. Exported so a test signs the way a sender would. */
export const signDelivery = (input: {
  readonly deploymentSecret: string
  readonly keyId: string
  readonly timestamp: string
  readonly rawBody: string
}): string =>
  `${SIGNATURE_VERSION}=${createHmac(
    'sha256',
    deriveIntegrationKey(input.deploymentSecret, input.keyId),
  )
    .update(signedPayload(input))
    .digest('hex')}`

/** Why a delivery was rejected. A closed vocabulary, so refusals can be counted. */
export type VerificationFailure =
  | 'not_configured'
  | 'missing_headers'
  | 'malformed_signature'
  | 'malformed_timestamp'
  | 'stale_timestamp'
  | 'bad_signature'

export type VerificationResult =
  | { readonly verified: true; readonly keyId: string; readonly timestamp: number }
  | { readonly verified: false; readonly failure: VerificationFailure }

const equalSignatures = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')

  // `timingSafeEqual` throws on unequal lengths; comparing first keeps every rejection one shape.
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

export interface VerifyDeliveryInput {
  readonly headers: Headers
  /** The body **as text**. Nothing in this module parses it. */
  readonly rawBody: string
  readonly deploymentSecret: string | undefined
  /** Injectable so a test states the clock rather than racing it. */
  readonly now?: number
}

/**
 * Verify a delivery.
 *
 * @returns Which integration key signed it, or why it was refused. Never throws: a malformed header
 *   is an ordinary rejection, and an exception here would be a different response shape an attacker
 *   could distinguish.
 */
export const verifyDelivery = (input: VerifyDeliveryInput): VerificationResult => {
  const { deploymentSecret, headers, rawBody } = input
  const now = input.now ?? Date.now()

  if (deploymentSecret === undefined || deploymentSecret.length === 0) {
    // A deployment with no signing secret cannot verify anything, so it accepts nothing. Treating
    // an absent secret as "skip verification" is the single worst default available here.
    return { verified: false, failure: 'not_configured' }
  }

  const keyId = headers.get(KEY_ID_HEADER)
  const timestamp = headers.get(TIMESTAMP_HEADER)
  const signature = headers.get(SIGNATURE_HEADER)

  if (keyId === null || timestamp === null || signature === null) {
    return { verified: false, failure: 'missing_headers' }
  }

  if (!signature.startsWith(`${SIGNATURE_VERSION}=`)) {
    return { verified: false, failure: 'malformed_signature' }
  }

  const sentAt = Number(timestamp)

  if (!Number.isFinite(sentAt) || timestamp.trim().length === 0) {
    return { verified: false, failure: 'malformed_timestamp' }
  }

  // Both directions. A delivery from the future is as suspect as a stale one, and accepting one
  // would let a captured request be held and replayed at a chosen moment.
  if (Math.abs(now - sentAt) > REPLAY_WINDOW_MS) {
    return { verified: false, failure: 'stale_timestamp' }
  }

  const expected = signDelivery({ deploymentSecret, keyId, timestamp, rawBody })

  if (!equalSignatures(expected, signature)) {
    return { verified: false, failure: 'bad_signature' }
  }

  return { verified: true, keyId, timestamp: sentAt }
}
