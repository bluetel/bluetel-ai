import { describe, expect, it } from 'vitest'

import type { DeliverySink } from './handle-delivery'
import { handleDelivery, IDENTITY_FIELDS } from './handle-delivery'
import { createMemoryReplayStore } from './replay-guard'
import {
  KEY_ID_HEADER,
  REPLAY_WINDOW_MS,
  SIGNATURE_HEADER,
  signDelivery,
  TIMESTAMP_HEADER,
} from './verify-signature'

const DEPLOYMENT_SECRET = 'fixture-deployment-signing-secret'
const BOARD_A = '11111111-1111-4111-8111-111111111111'
const BOARD_B = '22222222-2222-4222-8222-222222222222'
const NOW = Date.UTC(2026, 7, 5, 10, 0, 0)

interface RecordingSink extends DeliverySink {
  readonly notified: readonly string[]
}

const createRecordingSink = (acted = true): RecordingSink => {
  const notified: string[] = []

  return {
    notified,
    notify: (integrationId) => {
      notified.push(integrationId)
      return Promise.resolve(acted)
    },
  }
}

const signedHeaders = (input: {
  readonly keyId: string
  readonly rawBody: string
  readonly timestamp?: number
}): Headers => {
  const timestamp = String(input.timestamp ?? NOW)
  const headers = new Headers()

  headers.set(KEY_ID_HEADER, input.keyId)
  headers.set(TIMESTAMP_HEADER, timestamp)
  headers.set(
    SIGNATURE_HEADER,
    signDelivery({
      deploymentSecret: DEPLOYMENT_SECRET,
      keyId: input.keyId,
      timestamp,
      rawBody: input.rawBody,
    }),
  )

  return headers
}

const run = async (input: {
  readonly keyId: string
  readonly rawBody: string
  readonly sink?: RecordingSink
  readonly replay?: ReturnType<typeof createMemoryReplayStore>
  readonly timestamp?: number
}) => {
  const sink = input.sink ?? createRecordingSink()
  const replay = input.replay ?? createMemoryReplayStore()

  const outcome = await handleDelivery({
    headers: signedHeaders(input),
    rawBody: input.rawBody,
    deploymentSecret: DEPLOYMENT_SECRET,
    replay,
    sink,
    now: NOW,
  })

  return { outcome, sink, replay }
}

describe('handleDelivery accepts a genuine delivery (T122, FR-017)', () => {
  it('accepts it and names the integration the signature proved', async () => {
    const { outcome, sink } = await run({ keyId: BOARD_A, rawBody: '{"event":"issue_updated"}' })

    expect(outcome).toEqual({ status: 202, result: 'accepted', integrationId: BOARD_A })
    expect(sink.notified).toEqual([BOARD_A])
  })

  it('accepts and ignores a delivery for a board that is gone or switched off', async () => {
    const { outcome } = await run({
      keyId: BOARD_A,
      rawBody: '{}',
      sink: createRecordingSink(false),
    })

    expect(outcome).toMatchObject({ status: 202, result: 'ignored' })
  })
})

describe('it verifies before it parses', () => {
  it('refuses an unsigned delivery whose body is not even JSON, without parsing it', async () => {
    const sink = createRecordingSink()

    const outcome = await handleDelivery({
      headers: new Headers(),
      rawBody: 'this is not json at all',
      deploymentSecret: DEPLOYMENT_SECRET,
      replay: createMemoryReplayStore(),
      sink,
      now: NOW,
    })

    // 401, not 400. A 400 would mean the parser ran on unverified input — which is the failure the
    // ordering exists to prevent, and the response would say so to anyone probing.
    expect(outcome).toEqual({ status: 401, result: 'missing_headers' })
    expect(sink.notified).toEqual([])
  })

  it('reports a malformed body only once the signature has been checked', async () => {
    const { outcome, sink } = await run({ keyId: BOARD_A, rawBody: 'not json' })

    expect(outcome).toEqual({ status: 400, result: 'unparsable_body' })
    expect(sink.notified).toEqual([])
  })

  it('never calls the sink for a delivery it could not verify', async () => {
    const sink = createRecordingSink()
    const headers = signedHeaders({ keyId: BOARD_A, rawBody: '{}' })
    headers.set(SIGNATURE_HEADER, 'v1=0000')

    await handleDelivery({
      headers,
      rawBody: '{}',
      deploymentSecret: DEPLOYMENT_SECRET,
      replay: createMemoryReplayStore(),
      sink,
      now: NOW,
    })

    expect(sink.notified).toEqual([])
  })
})

describe('it never trusts the body to name the integration', () => {
  it.each(IDENTITY_FIELDS)('ignores a body naming a different integration in %s', async (field) => {
    const rawBody = JSON.stringify({ [field]: BOARD_B, event: 'issue_updated' })
    const { outcome, sink } = await run({ keyId: BOARD_A, rawBody })

    // The signature said board A. The body said board B. The signature wins — otherwise anyone who
    // could reach this URL would choose which client's credentials the resulting run uses.
    expect(sink.notified).toEqual([BOARD_A])
    expect(outcome).toMatchObject({ integrationId: BOARD_A })
  })

  it('accepts a body with no identity in it at all, because it never needed one', async () => {
    const { outcome } = await run({ keyId: BOARD_A, rawBody: '{"event":"issue_updated"}' })

    expect(outcome).toMatchObject({ result: 'accepted', integrationId: BOARD_A })
  })
})

describe('it rejects a replay', () => {
  it('accepts a delivery once and refuses the identical one', async () => {
    const replay = createMemoryReplayStore()
    const first = await run({ keyId: BOARD_A, rawBody: '{"a":1}', replay })
    const second = await run({ keyId: BOARD_A, rawBody: '{"a":1}', replay })

    expect(first.outcome.status).toBe(202)
    expect(second.outcome).toEqual({ status: 409, result: 'replayed' })
  })

  it('does not call the sink twice for a replayed delivery', async () => {
    const replay = createMemoryReplayStore()
    const sink = createRecordingSink()

    await run({ keyId: BOARD_A, rawBody: '{"a":1}', replay, sink })
    await run({ keyId: BOARD_A, rawBody: '{"a":1}', replay, sink })

    expect(sink.notified).toEqual([BOARD_A])
  })

  it('still accepts a genuinely different delivery from the same board', async () => {
    const replay = createMemoryReplayStore()

    await run({ keyId: BOARD_A, rawBody: '{"a":1}', replay })
    const second = await run({ keyId: BOARD_A, rawBody: '{"a":2}', replay })

    expect(second.outcome.status).toBe(202)
  })

  it('refuses a stale delivery before the replay store is even consulted', async () => {
    const replay = createMemoryReplayStore()

    const outcome = await handleDelivery({
      headers: signedHeaders({
        keyId: BOARD_A,
        rawBody: '{}',
        timestamp: NOW - REPLAY_WINDOW_MS - 1,
      }),
      rawBody: '{}',
      deploymentSecret: DEPLOYMENT_SECRET,
      replay,
      sink: createRecordingSink(),
      now: NOW,
    })

    expect(outcome).toEqual({ status: 401, result: 'stale_timestamp' })
  })
})
