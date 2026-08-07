import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  deriveIntegrationKey,
  KEY_ID_HEADER,
  REPLAY_WINDOW_MS,
  SIGNATURE_HEADER,
  SIGNATURE_VERSION,
  signDelivery,
  signedPayload,
  TIMESTAMP_HEADER,
  verifyDelivery,
} from './verify-signature'

/** Invented, and never a real webhook secret. */
const DEPLOYMENT_SECRET = 'fixture-deployment-signing-secret'
const BOARD_A = '11111111-1111-4111-8111-111111111111'
const BOARD_B = '22222222-2222-4222-8222-222222222222'
const NOW = Date.UTC(2026, 7, 5, 10, 0, 0)

const headersFor = (input: {
  readonly keyId?: string
  readonly timestamp?: string
  readonly signature?: string
}): Headers => {
  const headers = new Headers()
  if (input.keyId !== undefined) headers.set(KEY_ID_HEADER, input.keyId)
  if (input.timestamp !== undefined) headers.set(TIMESTAMP_HEADER, input.timestamp)
  if (input.signature !== undefined) headers.set(SIGNATURE_HEADER, input.signature)
  return headers
}

const deliver = (input: {
  readonly keyId: string
  readonly rawBody: string
  readonly timestamp?: number
  readonly deploymentSecret?: string
}) => {
  const timestamp = String(input.timestamp ?? NOW)
  const signature = signDelivery({
    deploymentSecret: input.deploymentSecret ?? DEPLOYMENT_SECRET,
    keyId: input.keyId,
    timestamp,
    rawBody: input.rawBody,
  })

  return { headers: headersFor({ keyId: input.keyId, timestamp, signature }), signature }
}

describe('deriveIntegrationKey', () => {
  it('gives each integration a different key from one deployment secret', () => {
    expect(deriveIntegrationKey(DEPLOYMENT_SECRET, BOARD_A)).not.toEqual(
      deriveIntegrationKey(DEPLOYMENT_SECRET, BOARD_B),
    )
  })

  it('is deterministic, so a sender and the platform derive the same key', () => {
    expect(deriveIntegrationKey(DEPLOYMENT_SECRET, BOARD_A)).toEqual(
      deriveIntegrationKey(DEPLOYMENT_SECRET, BOARD_A),
    )
  })

  it('changes for every integration when the deployment secret is rotated', () => {
    expect(deriveIntegrationKey('another-fixture-secret', BOARD_A)).not.toEqual(
      deriveIntegrationKey(DEPLOYMENT_SECRET, BOARD_A),
    )
  })
})

describe('signedPayload', () => {
  it('covers the version, the key id, the timestamp and the body', () => {
    expect(signedPayload({ keyId: BOARD_A, timestamp: '17', rawBody: '{}' })).toBe(
      `${SIGNATURE_VERSION}:${String(BOARD_A.length)}:${BOARD_A}:17:{}`,
    )
  })

  it('cannot be re-split into a different key id and timestamp pair', () => {
    // Without the length prefix these two encode identically, and a signature for one board would
    // verify for another. The key id is attacker-supplied, so this is a live case.
    expect(signedPayload({ keyId: BOARD_A, timestamp: '1:2', rawBody: '{}' })).not.toBe(
      signedPayload({ keyId: `${BOARD_A}:1`, timestamp: '2', rawBody: '{}' }),
    )
  })
})

describe('verifyDelivery (T122, FR-017)', () => {
  const rawBody = '{"event":"issue_updated","issue":"FIX-1"}'

  it('verifies a delivery signed with the integration key', () => {
    const { headers } = deliver({ keyId: BOARD_A, rawBody })

    expect(
      verifyDelivery({ headers, rawBody, deploymentSecret: DEPLOYMENT_SECRET, now: NOW }),
    ).toEqual({ verified: true, keyId: BOARD_A, timestamp: NOW })
  })

  it('accepts nothing at all when the deployment has no signing secret', () => {
    const { headers } = deliver({ keyId: BOARD_A, rawBody })

    expect(
      verifyDelivery({ headers, rawBody, deploymentSecret: undefined, now: NOW }),
    ).toMatchObject({ verified: false, failure: 'not_configured' })
  })

  it('refuses a delivery with no signature headers', () => {
    expect(
      verifyDelivery({
        headers: new Headers(),
        rawBody,
        deploymentSecret: DEPLOYMENT_SECRET,
        now: NOW,
      }),
    ).toMatchObject({ verified: false, failure: 'missing_headers' })
  })

  it('refuses a signature in an unknown scheme rather than guessing at it', () => {
    expect(
      verifyDelivery({
        headers: headersFor({ keyId: BOARD_A, timestamp: String(NOW), signature: 'deadbeef' }),
        rawBody,
        deploymentSecret: DEPLOYMENT_SECRET,
        now: NOW,
      }),
    ).toMatchObject({ verified: false, failure: 'malformed_signature' })
  })

  it('refuses a timestamp that is not a number', () => {
    expect(
      verifyDelivery({
        headers: headersFor({ keyId: BOARD_A, timestamp: 'yesterday', signature: 'v1=00' }),
        rawBody,
        deploymentSecret: DEPLOYMENT_SECRET,
        now: NOW,
      }),
    ).toMatchObject({ verified: false, failure: 'malformed_timestamp' })
  })

  it('refuses a stale delivery, which is what bounds a captured request', () => {
    const { headers } = deliver({ keyId: BOARD_A, rawBody, timestamp: NOW - REPLAY_WINDOW_MS - 1 })

    expect(
      verifyDelivery({ headers, rawBody, deploymentSecret: DEPLOYMENT_SECRET, now: NOW }),
    ).toMatchObject({ verified: false, failure: 'stale_timestamp' })
  })

  it('refuses a delivery from the future, so a capture cannot be held and released', () => {
    const { headers } = deliver({ keyId: BOARD_A, rawBody, timestamp: NOW + REPLAY_WINDOW_MS + 1 })

    expect(
      verifyDelivery({ headers, rawBody, deploymentSecret: DEPLOYMENT_SECRET, now: NOW }),
    ).toMatchObject({ verified: false, failure: 'stale_timestamp' })
  })

  it('refuses a body that changed after signing', () => {
    const { headers } = deliver({ keyId: BOARD_A, rawBody })

    expect(
      verifyDelivery({
        headers,
        rawBody: `${rawBody} `,
        deploymentSecret: DEPLOYMENT_SECRET,
        now: NOW,
      }),
    ).toMatchObject({ verified: false, failure: 'bad_signature' })
  })

  it('refuses a signature produced with the wrong deployment secret', () => {
    const { headers } = deliver({
      keyId: BOARD_A,
      rawBody,
      deploymentSecret: 'a-different-fixture-secret',
    })

    expect(
      verifyDelivery({ headers, rawBody, deploymentSecret: DEPLOYMENT_SECRET, now: NOW }),
    ).toMatchObject({ verified: false, failure: 'bad_signature' })
  })

  /**
   * The two attacks the design is actually about. Both must fail, and they fail for different
   * reasons: the first because board A's key cannot be derived from board B's, the second because
   * the key id is inside the signed material.
   */
  it('will not let a holder of one board key sign for another board', () => {
    // An attacker who somehow holds board A's derived key signs with it, claiming to be board B.
    const timestamp = String(NOW)
    const forged = `${SIGNATURE_VERSION}=${createHmac(
      'sha256',
      deriveIntegrationKey(DEPLOYMENT_SECRET, BOARD_A),
    )
      .update(signedPayload({ keyId: BOARD_B, timestamp, rawBody }))
      .digest('hex')}`

    expect(
      verifyDelivery({
        headers: headersFor({ keyId: BOARD_B, timestamp, signature: forged }),
        rawBody,
        deploymentSecret: DEPLOYMENT_SECRET,
        now: NOW,
      }),
    ).toMatchObject({ verified: false, failure: 'bad_signature' })
  })

  it('will not let a valid delivery be re-pointed at another board by editing the header', () => {
    const { headers } = deliver({ keyId: BOARD_A, rawBody })
    headers.set(KEY_ID_HEADER, BOARD_B)

    expect(
      verifyDelivery({ headers, rawBody, deploymentSecret: DEPLOYMENT_SECRET, now: NOW }),
    ).toMatchObject({ verified: false, failure: 'bad_signature' })
  })

  it('never throws, so every refusal is the same shape from outside', () => {
    for (const signature of ['v1=', 'v1=zz', `v1=${'0'.repeat(1000)}`]) {
      expect(() =>
        verifyDelivery({
          headers: headersFor({ keyId: BOARD_A, timestamp: String(NOW), signature }),
          rawBody,
          deploymentSecret: DEPLOYMENT_SECRET,
          now: NOW,
        }),
      ).not.toThrow()
    }
  })
})
