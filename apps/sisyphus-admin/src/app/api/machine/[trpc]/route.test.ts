import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The mount, asserted for the three things a mount can get wrong invisibly.
 *
 * 1. **The path.** The endpoint here and the `machineSurfaceUrl` the control plane hands the
 *    executor both derive from `SISYPHUS_MACHINE_ENDPOINT`; a handler mounted elsewhere returns
 *    404 for every procedure while type-checking perfectly.
 * 2. **The router.** An interactive procedure must not be reachable from this path — that is
 *    FR-005 as a property of the mount rather than of a check.
 * 3. **Module scope.** Importing the route must open no pool and read no secret, because
 *    `next build` imports it.
 *
 * Not covered here: a *valid* executor credential end to end. That needs a `scoped_credentials`
 * row against a live database and is exercised where the row is written.
 */

const environment: Readonly<Record<string, string>> = {
  DATABASE_URL: 'postgres://sisyphus@db.invalid:5432/sisyphus',
  AUTH_SECRET: 'auth-secret',
  AUTH_GOOGLE_ID: 'google-client-id',
  AUTH_GOOGLE_SECRET: 'google-client-secret',
  SISYPHUS_PERMITTED_EMAIL_DOMAINS: 'bluetel.co.uk',
  SISYPHUS_MACHINE_CREDENTIAL_SECRET: 'machine-secret',
  SISYPHUS_SLACK_BOT_TOKEN: 'slack-bot-token-fixture',
  SISYPHUS_PANEL_URL: 'https://sisyphus.example.com',
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
    auth: () => Promise.resolve({ user: { id: 'a-signed-in-human' } }),
    getAuthDatabase: () => {
      openedPools.push('opened')
      return { handle: 'unused' }
    },
  }))

  return import('./route')
}

afterEach(() => {
  vi.doUnmock('@sisyphus-admin/lib/auth')
  vi.unstubAllEnvs()
  openedPools.length = 0
})

const call = async (
  handler: (request: Request) => Promise<Response>,
  procedure: string,
): Promise<Response> =>
  handler(new Request(`https://sisyphus.example.com/api/machine/${procedure}`))

/** Every machine procedure is a mutation, so reaching one means POST. */
const post = async (
  handler: (request: Request) => Promise<Response>,
  procedure: string,
): Promise<Response> =>
  handler(
    new Request(`https://sisyphus.example.com/api/machine/${procedure}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  )

describe('the machine tRPC route', () => {
  it('mounts both verbs, so queries and mutations both have a handler', async () => {
    const { GET, POST } = await importRoute()

    expect(typeof GET).toBe('function')
    expect(typeof POST).toBe('function')
  })

  it('opens no database pool at import time, because next build imports every route', async () => {
    await importRoute()

    expect(openedPools).toStrictEqual([])
  })

  it('answers on /api/machine, the path the executor is handed', async () => {
    const { POST } = await importRoute()

    const response = await post(POST, 'renewCredential')

    // Not 404-as-unmounted: the handler recognised the procedure and refused it for want of a
    // credential. A wrongly-mounted handler cannot tell the difference, which is why the body is
    // read rather than only the status.
    expect(await response.text()).not.toContain('No procedure found on path')
  })

  it('does not expose an interactive procedure on the machine path (FR-005)', async () => {
    const { GET } = await importRoute()

    const response = await call(GET, 'workflow.list')

    expect(await response.text()).toContain('No procedure found on path')
  })

  it('refuses an executor procedure presented with no credential, even with a panel session', async () => {
    // `auth()` is mocked to return a signed-in human above. The machine mount resolves no session
    // at all, so the cookie buys nothing here.
    const { POST } = await importRoute()

    const response = await post(POST, 'renewCredential')

    expect(response.status).toBeGreaterThanOrEqual(400)
  })
})
