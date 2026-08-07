import { afterEach, describe, expect, it, vi } from 'vitest'

import { KEY_ID_HEADER, SIGNATURE_HEADER, signDelivery, TIMESTAMP_HEADER } from './verify-signature'

/**
 * The mount, asserted for what a route module can get wrong invisibly.
 *
 * 1. **Module scope.** Importing it must open no pool and read no secret, because `next build`
 *    imports every route module while collecting page data.
 * 2. **It reads the body as text.** `request.json()` would parse before verifying, which is the one
 *    thing T122 is about. Asserted by handing it a request whose `json()` throws if called.
 * 3. **It refuses an unsigned delivery** without reaching the database.
 *
 * The pipeline itself — order, replay, identity — is asserted in `handle-delivery.test.ts`, which
 * can drive it without a Next.js request or an environment.
 */

const DEPLOYMENT_SECRET = 'fixture-deployment-signing-secret'
const BOARD_A = '11111111-1111-4111-8111-111111111111'

const environment: Readonly<Record<string, string>> = {
  DATABASE_URL: 'postgres://sisyphus@db.invalid:5432/sisyphus',
  AUTH_SECRET: 'auth-secret',
  AUTH_GOOGLE_ID: 'google-client-id',
  AUTH_GOOGLE_SECRET: 'google-client-secret',
  SISYPHUS_PERMITTED_EMAIL_DOMAINS: 'bluetel.co.uk',
  SISYPHUS_MACHINE_CREDENTIAL_SECRET: 'machine-secret',
  SISYPHUS_WEBHOOK_SIGNING_SECRET: DEPLOYMENT_SECRET,
  SISYPHUS_LOGS_BUCKET: 'logs',
  SISYPHUS_BUNDLES_BUCKET: 'bundles',
  SISYPHUS_ARTIFACTS_BUCKET: 'artifacts',
  SISYPHUS_STAGE: 'test',
  NEXT_PUBLIC_NODE_ENV: 'test',
  NEXT_PUBLIC_SITE_URL: 'https://sisyphus.example.com',
}

const openedPools: string[] = []

const importRoute = async () => {
  vi.resetModules()
  vi.stubEnv('SKIP_ENV_VALIDATION', '')
  vi.stubEnv('AUTH_URL', 'https://sisyphus.example.com')
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value)

  vi.doMock('@sisyphus-admin/lib/auth', () => ({
    auth: () => Promise.resolve(null),
    getAuthDatabase: () => {
      openedPools.push('opened')
      throw new Error('the route reached the database')
    },
  }))

  return import('./route')
}

afterEach(() => {
  vi.doUnmock('@sisyphus-admin/lib/auth')
  vi.unstubAllEnvs()
  openedPools.length = 0
})

/** A request whose `json()` fails the test if the route ever calls it. */
const requestThatRefusesToBeParsed = (rawBody: string, headers: Headers): Request => {
  const request = new Request('https://sisyphus.example.com/api/webhook', {
    method: 'POST',
    headers,
    body: rawBody,
  })

  Object.defineProperty(request, 'json', {
    value: () => {
      throw new Error('the route parsed the body before verifying it')
    },
  })

  return request
}

const signedHeaders = (keyId: string, rawBody: string, now: number): Headers => {
  const timestamp = String(now)
  const headers = new Headers({ 'content-type': 'application/json' })

  headers.set(KEY_ID_HEADER, keyId)
  headers.set(TIMESTAMP_HEADER, timestamp)
  headers.set(
    SIGNATURE_HEADER,
    signDelivery({ deploymentSecret: DEPLOYMENT_SECRET, keyId, timestamp, rawBody }),
  )

  return headers
}

describe('the webhook route (T122, FR-017)', () => {
  it('mounts POST and nothing else — a webhook is never a GET', async () => {
    const route = await importRoute()

    expect(typeof route.POST).toBe('function')
    expect('GET' in route).toBe(false)
  })

  it('opens no database pool at import time, because next build imports every route', async () => {
    await importRoute()

    expect(openedPools).toStrictEqual([])
  })

  it('reads the body as text, never as JSON', async () => {
    const { POST } = await importRoute()
    const rawBody = '{"event":"issue_updated"}'

    // The database mock throws, so a *verified* delivery fails at the sink. That the failure is the
    // database and not `json()` is the assertion: verification ran on the text, and the parse — if
    // it happened at all — happened after. A route calling `request.json()` fails with the other
    // error instead.
    await expect(
      POST(requestThatRefusesToBeParsed(rawBody, signedHeaders(BOARD_A, rawBody, Date.now()))),
    ).rejects.toThrow('the route reached the database')
    expect(openedPools).toStrictEqual(['opened'])
  })

  it('refuses an unsigned delivery without touching the database', async () => {
    const { POST } = await importRoute()

    const response = await POST(
      new Request('https://sisyphus.example.com/api/webhook', { method: 'POST', body: '{}' }),
    )

    expect(response.status).toBe(401)
    expect(openedPools).toStrictEqual([])
  })

  it('says nothing about why verification failed, so the refusal is not an oracle', async () => {
    const { POST } = await importRoute()

    const response = await POST(
      new Request('https://sisyphus.example.com/api/webhook', { method: 'POST', body: '{}' }),
    )

    expect(await response.json()).toEqual({ accepted: false })
  })

  it('refuses a key id that is not an integration id, without reaching the database', async () => {
    const { POST } = await importRoute()
    const rawBody = '{"event":"issue_updated"}'

    const response = await POST(
      new Request('https://sisyphus.example.com/api/webhook', {
        method: 'POST',
        headers: signedHeaders('../../etc/passwd', rawBody, Date.now()),
        body: rawBody,
      }),
    )

    expect(openedPools).toStrictEqual([])
    expect(await response.json()).toMatchObject({ result: 'ignored' })
  })
})
