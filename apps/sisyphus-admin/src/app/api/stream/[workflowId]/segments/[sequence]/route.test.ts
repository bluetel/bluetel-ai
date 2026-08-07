import type { SisyphusSession } from '@bluetel-ai/sisyphus-api/server'
import type * as Bundles from '@sisyphus-admin/lib/bundles'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The per-segment text read, asserted for the one thing it is most tempting to get wrong: it must
 * refuse an out-of-scope caller **identically** to the stream, before any key is looked up. A
 * segment key looks self-authorising and is not.
 *
 * Not covered here: S3 itself. The store is a stand-in, exactly as in `../../../segment-text.test`;
 * what this file proves is the wiring — that the scope decision comes first, that the row is read
 * with both the workflow and the sequence in the predicate, and that a bad sequence is answered as
 * absence.
 */

const WORKFLOW_ID = '01890a5d-ac96-774b-bcce-b302099a8057'

const session = (overrides: Partial<SisyphusSession['user']> = {}): SisyphusSession => ({
  user: {
    id: 'user-1',
    email: 'admin@bluetel.co.uk',
    displayName: 'An Admin',
    role: 'admin',
    isActive: true,
    ...overrides,
  },
  expiresAt: new Date('2099-01-01T00:00:00.000Z'),
})

interface Harness {
  readonly session: SisyphusSession | null
  readonly visible: boolean
  readonly rows?: readonly { readonly s3Key: string; readonly byteSize: number }[]
}

const predicates: unknown[] = []
const objectReads: { bucket: string; key: string }[] = []

const importRoute = async (harness: Harness) => {
  vi.resetModules()
  predicates.length = 0
  objectReads.length = 0

  vi.doMock('@sisyphus-admin/env', () => ({
    env: { AWS_REGION: 'eu-west-1', SISYPHUS_LOGS_BUCKET: 'logs' },
  }))
  vi.doMock('@sisyphus-admin/lib/auth', () => ({
    getAuthDatabase: () => ({
      select: () => ({
        from: () => ({
          where: (predicate: unknown) => {
            predicates.push(predicate)
            return { limit: () => Promise.resolve(harness.rows ?? []) }
          },
        }),
      }),
    }),
  }))
  vi.doMock('@sisyphus-admin/server', () => ({
    resolveSisyphusSession: () => Promise.resolve(harness.session),
  }))
  vi.doMock('@sisyphus-admin/lib/bundles', async (importOriginal) => {
    const original = await importOriginal<typeof Bundles>()
    return {
      ...original,
      createBundleObjectStore: () => ({
        put: () => Promise.reject(new Error('not used')),
        get: (request: { bucket: string; key: string }) => {
          objectReads.push(request)
          return Promise.resolve(new TextEncoder().encode('the run said this'))
        },
      }),
    }
  })
  vi.doMock('@bluetel-ai/sisyphus-api/server', () => ({
    createScopeResolver: () => ({
      resolve: () => Promise.resolve({ userId: 'user-1', isAdmin: true, visibleProfileIds: [] }),
    }),
    findWorkflowInScope: () =>
      Promise.resolve(harness.visible ? { id: WORKFLOW_ID, state: 'running' } : undefined),
  }))

  return import('./route')
}

const call = async (
  route: { GET: (request: Request, context: never) => Promise<Response> },
  sequence: string,
): Promise<Response> =>
  route.GET(
    new Request(`https://sisyphus.example.com/api/stream/${WORKFLOW_ID}/segments/${sequence}`),
    { params: Promise.resolve({ workflowId: WORKFLOW_ID, sequence }) } as never,
  )

afterEach(() => {
  vi.doUnmock('@sisyphus-admin/env')
  vi.doUnmock('@sisyphus-admin/lib/auth')
  vi.doUnmock('@sisyphus-admin/lib/bundles')
  vi.doUnmock('@sisyphus-admin/server')
  vi.doUnmock('@bluetel-ai/sisyphus-api/server')
})

describe('the segment text route', () => {
  it('serves a stored segment as plain text', async () => {
    const route = await importRoute({
      session: session(),
      visible: true,
      rows: [{ s3Key: 'logs/w1/1.log', byteSize: 17 }],
    })

    const response = await call(route, '1')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await response.text()).toBe('the run said this')
    expect(objectReads).toStrictEqual([{ bucket: 'logs', key: 'logs/w1/1.log' }])
  })

  it('refuses an out-of-scope caller before looking up any key (FR-190)', async () => {
    const route = await importRoute({
      session: session(),
      visible: false,
      rows: [{ s3Key: 'logs/w1/1.log', byteSize: 17 }],
    })

    const response = await call(route, '1')

    expect(response.status).toBe(404)
    expect(await response.text()).toBe(
      JSON.stringify({ error: { message: 'Workflow not found.' } }),
    )
    expect(objectReads).toStrictEqual([])
    expect(predicates).toStrictEqual([])
  })

  it('refuses a signed-out caller', async () => {
    const route = await importRoute({ session: null, visible: true })

    expect((await call(route, '1')).status).toBe(401)
  })

  it('answers a malformed sequence as absence, without a query', async () => {
    const route = await importRoute({ session: session(), visible: true })

    const response = await call(route, 'nonsense')

    expect(response.status).toBe(404)
    expect(predicates).toStrictEqual([])
  })

  it('answers a sequence with no row as absence rather than an empty log line', async () => {
    const route = await importRoute({ session: session(), visible: true, rows: [] })

    expect((await call(route, '9')).status).toBe(404)
    expect(objectReads).toStrictEqual([])
  })
})
