import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The route is a mount, and the things worth asserting about a mount are that both verbs are
 * exported, that importing it opens nothing, and that it answers on the path the client is
 * pointed at. The last one is the drift this file exists to catch: the endpoint and the
 * `httpBatchLink` URL both come from `SISYPHUS_TRPC_ENDPOINT`, and a handler mounted at a
 * different path returns 404 for every procedure while type-checking perfectly.
 */

const environment: Readonly<Record<string, string>> = {
  DATABASE_URL: 'postgres://sisyphus@db.invalid:5432/sisyphus',
  AUTH_SECRET: 'auth-secret',
  AUTH_GOOGLE_ID: 'google-client-id',
  AUTH_GOOGLE_SECRET: 'google-client-secret',
  SISYPHUS_PERMITTED_EMAIL_DOMAINS: 'bluetel.co.uk',
  SISYPHUS_MACHINE_CREDENTIAL_SECRET: 'machine-secret',
  SISYPHUS_LOGS_BUCKET: 'logs',
  SISYPHUS_BUNDLES_BUCKET: 'bundles',
  SISYPHUS_ARTIFACTS_BUCKET: 'artifacts',
  SISYPHUS_STAGE: 'test',
  NEXT_PUBLIC_NODE_ENV: 'test',
  NEXT_PUBLIC_SITE_URL: 'https://sisyphus.example.com',
}

/**
 * The database handle is replaced so importing the route cannot open a pool, and `auth()` answers
 * "nobody" so the one procedure exercised below runs the real middleware chain and refuses.
 */
const importRoute = async () => {
  vi.resetModules()
  vi.stubEnv('SKIP_ENV_VALIDATION', '')
  vi.stubEnv('AUTH_URL', 'https://sisyphus.example.com')
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value)

  vi.doMock('@sisyphus-admin/lib/auth', () => ({
    auth: () => Promise.resolve(null),
    getAuthDatabase: () => ({ handle: 'unused' }),
  }))

  return import('./route')
}

afterEach(() => {
  vi.doUnmock('@sisyphus-admin/lib/auth')
  vi.unstubAllEnvs()
})

const call = async (
  handler: (request: Request) => Promise<Response>,
  procedure: string,
): Promise<Response> => handler(new Request(`https://sisyphus.example.com/api/trpc/${procedure}`))

describe('the interactive tRPC route', () => {
  it('mounts both verbs, so queries and mutations both have a handler', async () => {
    const { GET, POST } = await importRoute()

    expect(typeof GET).toBe('function')
    expect(typeof POST).toBe('function')
  })

  it('mounts the same handler on both verbs', async () => {
    const { GET, POST } = await importRoute()

    expect(GET).toBe(POST)
  })

  it('answers on the endpoint the client is pointed at', async () => {
    const { GET } = await importRoute()

    // A path mismatch would surface as a tRPC "no procedure" error rather than a resolved call.
    const body: unknown = await (await call(GET, 'health.ping')).json()

    expect(JSON.stringify(body)).not.toContain('No "query"-procedure on path')
  })

  it('refuses an admin procedure for a caller with no session, through the real middleware', async () => {
    const { GET } = await importRoute()

    const response = await call(GET, 'admin.users.list')

    expect(response.status).toBe(401)
  })
})
