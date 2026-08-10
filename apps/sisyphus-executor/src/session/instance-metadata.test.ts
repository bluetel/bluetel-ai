import { describe, expect, it } from 'vitest'

import type { AgentQuiescedState } from '../agent'

import {
  createImdsMetadataReader,
  IMDS_SPOT_ACTION_PATH,
  IMDS_TIMEOUT,
  IMDS_TOKEN_HEADER,
  IMDS_TOKEN_PATH,
  IMDS_TOKEN_TTL_HEADER,
  IMDS_UNEXPECTED_STATUS,
  IMDS_UNREACHABLE,
  parseInstanceAction,
  UNKNOWN_INSTANCE_ACTION,
} from './instance-metadata'
import { watchForInterruption } from './interruption'
import { isCodedError } from './snapshot-store'
import type { CapturedSnapshot, SuspendOptions } from './suspend'

/**
 * T197 / T240. The watch was already proved against a fake reader in `interruption.test.ts`; what
 * was never proved is the thing behind the seam, and on a platform whose **default** purchase mode
 * is `spot` that gap was silent data loss rather than an unfinished edge case.
 *
 * So the assertions here are about the four distinctions the reader has to get right and nothing
 * else: that IMDSv2's token round trip happens and the token is presented on the read; that a `404`
 * is the healthy answer and means `null`; that a `200` is a notice and is parsed; and that every
 * way of failing to read produces a **rejection**, because {@link InstanceMetadataReader} is
 * explicit that rejecting is not the same as answering "no notice".
 *
 * No test here opens a socket. The transport is injected, which is the only reason a `404` from a
 * link-local address is testable at all on a machine that is not an EC2 instance.
 */

const ACTION_BODY = JSON.stringify({ action: 'terminate', time: '2026-08-06T12:00:00Z' })

/** One scripted answer. `'never'` is a transport that has stopped answering without failing. */
type Answer = Response | Error | 'never'

interface RecordedRequest {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
}

interface Transport {
  readonly requests: readonly RecordedRequest[]
  readonly fetch: typeof globalThis.fetch
}

const ok = (body: string) => (): Answer => new Response(body, { status: 200 })
const statusOf = (code: number) => (): Answer => new Response('', { status: code })
const refuses = (message: string) => (): Answer => new TypeError(message)
const hangs = () => (): Answer => 'never'

/**
 * A fake `fetch` scripted per endpoint.
 *
 * Answers are thunks rather than values because a `Response` body may only be read once, and
 * several of these tests deliberately poll twice.
 */
const transportOf = (script: {
  readonly token: readonly (() => Answer)[]
  readonly action: readonly (() => Answer)[]
}): Transport => {
  const requests: RecordedRequest[] = []
  let tokenCalls = 0
  let actionCalls = 0

  const call = (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const isToken = url.endsWith(IMDS_TOKEN_PATH)

    requests.push({
      url,
      method: init?.method ?? 'GET',
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
    })

    const answers = isToken ? script.token : script.action
    const index = isToken ? tokenCalls : actionCalls

    if (isToken) {
      tokenCalls += 1
    } else {
      actionCalls += 1
    }

    const answer = (answers[Math.min(index, answers.length - 1)] ?? statusOf(404))()

    if (answer === 'never') {
      return new Promise<Response>(() => undefined)
    }

    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
  }

  return { requests, fetch: call as unknown as typeof globalThis.fetch }
}

/** The error a promise rejected with, or `undefined` when it did not reject. */
const rejection = async (work: Promise<unknown>): Promise<unknown> => {
  try {
    await work

    return undefined
  } catch (error) {
    return error
  }
}

const tokenRequests = (transport: Transport): readonly RecordedRequest[] =>
  transport.requests.filter((request) => request.url.endsWith(IMDS_TOKEN_PATH))

const actionRequests = (transport: Transport): readonly RecordedRequest[] =>
  transport.requests.filter((request) => request.url.endsWith(IMDS_SPOT_ACTION_PATH))

describe('createImdsMetadataReader', () => {
  it('takes an IMDSv2 token and presents it on the reclamation read', async () => {
    const transport = transportOf({ token: [ok('TOKEN-ONE')], action: [statusOf(404)] })

    await createImdsMetadataReader({ fetch: transport.fetch }).readInterruptionNotice()

    expect(transport.requests).toHaveLength(2)

    const [token, action] = transport.requests

    expect(token.method).toBe('PUT')
    expect(token.url).toBe(`http://169.254.169.254${IMDS_TOKEN_PATH}`)
    expect(token.headers[IMDS_TOKEN_TTL_HEADER]).toBe('21600')
    expect(action.method).toBe('GET')
    expect(action.url).toBe(`http://169.254.169.254${IMDS_SPOT_ACTION_PATH}`)
    // Without this header a hardened instance answers 401 forever, which would look exactly like a
    // metadata service that is simply broken.
    expect(action.headers[IMDS_TOKEN_HEADER]).toBe('TOKEN-ONE')
  })

  it('answers null on a 404 — the ordinary reply from an instance nobody is reclaiming', async () => {
    const transport = transportOf({ token: [ok('TOKEN-ONE')], action: [statusOf(404)] })

    await expect(
      createImdsMetadataReader({ fetch: transport.fetch }).readInterruptionNotice(),
    ).resolves.toBeNull()
  })

  it('reuses one token across polls rather than a PUT per read', async () => {
    const transport = transportOf({ token: [ok('TOKEN-ONE')], action: [statusOf(404)] })
    const reader = createImdsMetadataReader({ fetch: transport.fetch })

    await reader.readInterruptionNotice()
    await reader.readInterruptionNotice()
    await reader.readInterruptionNotice()

    expect(tokenRequests(transport)).toHaveLength(1)
    expect(actionRequests(transport)).toHaveLength(3)
  })

  it('renews the token before it expires, on the margin rather than on the deadline', async () => {
    const transport = transportOf({
      token: [ok('TOKEN-ONE'), ok('TOKEN-TWO')],
      action: [statusOf(404)],
    })
    let clock = 1_000_000
    const reader = createImdsMetadataReader({
      fetch: transport.fetch,
      // 120s of life, renewed 60s early: the second poll is inside the token's stated lifetime and
      // must still take a fresh one.
      tokenTtlSeconds: 120,
      now: () => clock,
    })

    await reader.readInterruptionNotice()
    clock += 61_000
    await reader.readInterruptionNotice()

    expect(tokenRequests(transport)).toHaveLength(2)
    expect(actionRequests(transport)[1]?.headers[IMDS_TOKEN_HEADER]).toBe('TOKEN-TWO')
  })

  it('reads a real reclamation notice off a 200', async () => {
    const transport = transportOf({ token: [ok('TOKEN-ONE')], action: [ok(ACTION_BODY)] })

    const notice = await createImdsMetadataReader({
      fetch: transport.fetch,
    }).readInterruptionNotice()

    expect(notice?.action).toBe('terminate')
    expect(notice?.reclaimAt.toISOString()).toBe('2026-08-06T12:00:00.000Z')
  })

  it('takes a fresh token and retries once when the read is refused', async () => {
    const transport = transportOf({
      token: [ok('TOKEN-ONE'), ok('TOKEN-TWO')],
      action: [statusOf(401), ok(ACTION_BODY)],
    })

    const notice = await createImdsMetadataReader({
      fetch: transport.fetch,
    }).readInterruptionNotice()

    expect(notice?.action).toBe('terminate')
    expect(tokenRequests(transport)).toHaveLength(2)
    expect(actionRequests(transport)[1]?.headers[IMDS_TOKEN_HEADER]).toBe('TOKEN-TWO')
  })

  it('retries the refused read exactly once, never in a loop', async () => {
    const transport = transportOf({
      token: [ok('TOKEN-ONE')],
      action: [statusOf(403)],
    })

    expect(
      isCodedError(
        await rejection(
          createImdsMetadataReader({ fetch: transport.fetch }).readInterruptionNotice(),
        ),
        IMDS_UNEXPECTED_STATUS,
      ),
    ).toBe(true)
    expect(actionRequests(transport)).toHaveLength(2)
  })

  it('rejects rather than answering null when the service cannot be reached', async () => {
    const transport = transportOf({
      token: [ok('TOKEN-ONE')],
      action: [refuses('connect EHOSTUNREACH 169.254.169.254:80')],
    })

    // The distinction the whole interface turns on: an unreachable service is not "no notice".
    expect(
      isCodedError(
        await rejection(
          createImdsMetadataReader({ fetch: transport.fetch }).readInterruptionNotice(),
        ),
        IMDS_UNREACHABLE,
      ),
    ).toBe(true)
  })

  it('rejects when the token itself cannot be taken', async () => {
    const transport = transportOf({
      token: [refuses('connect EHOSTUNREACH 169.254.169.254:80')],
      action: [statusOf(404)],
    })

    expect(
      isCodedError(
        await rejection(
          createImdsMetadataReader({ fetch: transport.fetch }).readInterruptionNotice(),
        ),
        IMDS_UNREACHABLE,
      ),
    ).toBe(true)
    expect(actionRequests(transport)).toHaveLength(0)
  })

  it('refuses an empty token rather than reading with one', async () => {
    const transport = transportOf({ token: [ok('   ')], action: [statusOf(404)] })

    expect(
      isCodedError(
        await rejection(
          createImdsMetadataReader({ fetch: transport.fetch }).readInterruptionNotice(),
        ),
        IMDS_UNEXPECTED_STATUS,
      ),
    ).toBe(true)
  })

  it('rejects on a status that is neither 200 nor 404', async () => {
    const transport = transportOf({ token: [ok('TOKEN-ONE')], action: [statusOf(500)] })

    expect(
      isCodedError(
        await rejection(
          createImdsMetadataReader({ fetch: transport.fetch }).readInterruptionNotice(),
        ),
        IMDS_UNEXPECTED_STATUS,
      ),
    ).toBe(true)
  })

  it('gives up on a deadline rather than hanging the poll loop', async () => {
    const transport = transportOf({ token: [ok('TOKEN-ONE')], action: [hangs()] })
    const startedAt = Date.now()

    expect(
      isCodedError(
        await rejection(
          createImdsMetadataReader({
            fetch: transport.fetch,
            timeoutMs: 25,
          }).readInterruptionNotice(),
        ),
        IMDS_TIMEOUT,
      ),
    ).toBe(true)
    // A transport that ignores the abort signal must not be able to outlast the deadline either.
    expect(Date.now() - startedAt).toBeLessThan(2_000)
  })

  it('applies the deadline to the token round trip as well as the read', async () => {
    const transport = transportOf({ token: [hangs()], action: [statusOf(404)] })

    expect(
      isCodedError(
        await rejection(
          createImdsMetadataReader({
            fetch: transport.fetch,
            timeoutMs: 25,
          }).readInterruptionNotice(),
        ),
        IMDS_TIMEOUT,
      ),
    ).toBe(true)
  })
})

describe('parseInstanceAction', () => {
  it('keeps an action string this executor has not seen before', () => {
    const notice = parseInstanceAction(
      JSON.stringify({ action: 'rebalance-recommended', time: '2026-08-06T12:00:00Z' }),
      new Date('2026-08-06T11:00:00Z'),
    )

    expect(notice.action).toBe('rebalance-recommended')
  })

  it('assumes an imminent reclamation when the time is missing or unreadable', () => {
    const receivedAt = new Date('2026-08-06T11:00:00Z')

    expect(parseInstanceAction(JSON.stringify({ action: 'stop' }), receivedAt).reclaimAt).toEqual(
      receivedAt,
    )
    expect(
      parseInstanceAction(JSON.stringify({ action: 'stop', time: 'soon' }), receivedAt).reclaimAt,
    ).toEqual(receivedAt)
  })

  it('still reports a notice when the body is not JSON at all', () => {
    const receivedAt = new Date('2026-08-06T11:00:00Z')
    const notice = parseInstanceAction('<html>gateway</html>', receivedAt)

    // A 200 from this endpoint means a reclamation is scheduled. Discarding it because the payload
    // was unfamiliar is how a run gets reclaimed unsnapshotted (FR-054).
    expect(notice.action).toBe(UNKNOWN_INSTANCE_ACTION)
    expect(notice.reclaimAt).toEqual(receivedAt)
  })
})

/**
 * The reader is only useful if `watchForInterruption` can live with how it fails, so this pair
 * drives the real reader through the real watch — a fake transport being the only substitution.
 */
describe('the real reader under watchForInterruption', () => {
  const QUIESCED: AgentQuiescedState = {
    usage: { turns: 2, spendUsd: 0.25 },
    waitedForTurn: false,
  }

  const CAPTURED: CapturedSnapshot = {
    s3Key: 'snapshots/wf/imds.tar.zst',
    sizeBytes: 1_024,
    hasConversationState: true,
    hasWorktreeState: true,
  }

  const suspension = (): Omit<SuspendOptions, 'reason'> => ({
    sessionId: '0199a1f4-0000-7000-8000-0000000000b2',
    workspaceRoot: '/workspace',
    agent: {
      quiesce: () => Promise.resolve(QUIESCED),
      stop: () => Promise.resolve({ exitCode: 0, signal: null, forced: false }),
    },
    snapshot: { capture: () => Promise.resolve(CAPTURED) },
    registerSnapshot: () => Promise.resolve(),
    markSuspended: () => Promise.resolve(),
    releaseCompute: () => Promise.resolve(),
  })

  it('counts an unreachable IMDS as a read failure and keeps polling', async () => {
    const transport = transportOf({
      token: [ok('TOKEN-ONE')],
      action: [refuses('connect EHOSTUNREACH 169.254.169.254:80'), ok(ACTION_BODY)],
    })
    const failures: number[] = []

    const result = await watchForInterruption({
      metadata: createImdsMetadataReader({ fetch: transport.fetch }),
      suspension: suspension(),
      sleep: () => Promise.resolve(),
      onReadFailure: (_error, consecutive) => failures.push(consecutive),
    })

    // The failed read neither crashed the watch nor was mistaken for "no notice".
    expect(failures).toStrictEqual([1])
    expect(result.readFailures).toBe(1)
    expect(result.stoppedBecause).toBe('interrupted')
    expect(result.suspension?.plan.reason).toBe('interruption')
  })

  it('polls quietly through 404s and suspends the moment a notice appears', async () => {
    const transport = transportOf({
      token: [ok('TOKEN-ONE')],
      action: [statusOf(404), statusOf(404), ok(ACTION_BODY)],
    })

    const result = await watchForInterruption({
      metadata: createImdsMetadataReader({ fetch: transport.fetch }),
      suspension: suspension(),
      sleep: () => Promise.resolve(),
    })

    expect(result.polls).toBe(3)
    // Two 404s, and not one of them counted against the instance.
    expect(result.readFailures).toBe(0)
    expect(result.notice?.action).toBe('terminate')
  })
})
