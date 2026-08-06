import { randomUUID } from 'node:crypto'

import type { SisyphusSession } from '@bluetel-ai/sisyphus-api/server'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  buildFixtureIdentifiers,
  createSpikeWorkflow,
  seedSpikeFixture,
  teardownSpikeFixture,
} from '../spike-fixture'

/**
 * The route, at two levels.
 *
 * **Without a database** — the refusals, which are the part FR-190 turns on. An out-of-scope
 * caller and a nonexistent workflow must be byte-identical, and neither may receive a
 * `text/event-stream` at all.
 *
 * **With one** (`SISYPHUS_TEST_DATABASE_URL`; skipped cleanly when absent) — the SQL. The pure
 * transport tests inject `readSegmentsAfter`, so only this suite proves the `sequence >` window,
 * the ascending order and the terminal close actually compose against the real `log_segments`
 * table and its `(workflow_id, sequence)` index.
 *
 * **Not covered anywhere**: a browser. Latency is measured to a Node reader here as it was in the
 * spike, and the CDN and Lambda-duration halves of the original S3 question remain open — see
 * `../SPIKE-FINDINGS.md` § Not observed.
 */

const WORKFLOW_ID = '01890a5d-ac96-774b-bcce-b302099a8057'

const adminSession = (): SisyphusSession => ({
  user: {
    id: 'user-1',
    email: 'admin@bluetel.co.uk',
    displayName: 'An Admin',
    role: 'admin',
    isActive: true,
  },
  expiresAt: new Date('2099-01-01T00:00:00.000Z'),
})

const openedPools: string[] = []

interface RouteHarness {
  readonly session: SisyphusSession | null
  readonly visible: boolean
  readonly state?: string
}

const importRoute = async (harness: RouteHarness) => {
  vi.resetModules()
  openedPools.length = 0

  vi.doMock('@sisyphus-admin/lib/auth', () => ({
    getAuthDatabase: () => {
      openedPools.push('opened')
      return { handle: 'unused' }
    },
  }))
  vi.doMock('@sisyphus-admin/server', () => ({
    resolveSisyphusSession: () => Promise.resolve(harness.session),
    recordDenial: vi.fn(() => Promise.resolve()),
  }))
  vi.doMock('@bluetel-ai/sisyphus-api/server', () => ({
    createScopeResolver: () => ({
      resolve: () => Promise.resolve({ userId: 'user-1', isAdmin: true, visibleProfileIds: [] }),
    }),
    findWorkflowInScope: () =>
      Promise.resolve(
        harness.visible ? { id: WORKFLOW_ID, state: harness.state ?? 'running' } : undefined,
      ),
  }))

  return import('./route')
}

const streamRequest = (workflowId = WORKFLOW_ID): Request =>
  new Request(`https://sisyphus.example.com/api/stream/${workflowId}`)

const params = (workflowId = WORKFLOW_ID) => ({
  params: Promise.resolve({ workflowId }),
})

afterEach(() => {
  vi.doUnmock('@sisyphus-admin/lib/auth')
  vi.doUnmock('@sisyphus-admin/server')
  vi.doUnmock('@bluetel-ai/sisyphus-api/server')
})

describe('the log stream route', () => {
  it('opens no database pool at import time, because next build imports every route', async () => {
    await importRoute({ session: adminSession(), visible: true })

    expect(openedPools).toStrictEqual([])
  })

  it('answers an out-of-scope caller exactly as it answers a nonexistent run (FR-190)', async () => {
    const { GET } = await importRoute({ session: adminSession(), visible: false })

    const outOfScope = await GET(streamRequest(), params())
    const nonexistent = await GET(
      streamRequest('01890a5d-ac96-774b-bcce-b3020000dead'),
      params('01890a5d-ac96-774b-bcce-b3020000dead'),
    )

    expect(outOfScope.status).toBe(404)
    expect(nonexistent.status).toBe(404)
    expect(await outOfScope.text()).toBe(await nonexistent.text())
    expect(outOfScope.headers.get('content-type')).toBe(nonexistent.headers.get('content-type'))
  })

  it('never opens an event stream for a caller who may not see the run', async () => {
    const { GET } = await importRoute({ session: adminSession(), visible: false })

    const response = await GET(streamRequest(), params())

    expect(response.headers.get('content-type')).not.toContain('text/event-stream')
  })

  it('refuses a signed-out caller without disclosing whether the run exists', async () => {
    const { GET } = await importRoute({ session: null, visible: true })

    const response = await GET(streamRequest(), params())

    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain(WORKFLOW_ID)
  })

  it('refuses a deactivated account at its next request (FR-175)', async () => {
    const session = adminSession()
    const { GET } = await importRoute({
      session: { ...session, user: { ...session.user, isActive: false } },
      visible: true,
    })

    const response = await GET(streamRequest(), params())

    expect(response.status).toBe(401)
  })

  it('opens an unbuffered, uncached event stream for a caller who may see the run', async () => {
    const { GET } = await importRoute({ session: adminSession(), visible: true })

    const response = await GET(streamRequest(), params())

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('x-accel-buffering')).toBe('no')
    await response.body?.cancel()
  })
})

const connectionString = process.env.SISYPHUS_TEST_DATABASE_URL?.trim()
const describeWithDatabase =
  connectionString === undefined || connectionString === '' ? describe.skip : describe

/**
 * Read an SSE body until it closes, or until `limit` frames have arrived.
 *
 * The stream is cancelled afterwards either way, which is also what asserts the disconnect path
 * does not leave a poll loop running — a leaked loop keeps the vitest process alive.
 */
const readStream = async (response: Response, limit = 200): Promise<string> => {
  const reader = response.body?.getReader()
  if (reader === undefined) return ''

  const decoder = new TextDecoder()
  let text = ''
  let frames = 0

  try {
    while (frames < limit) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      frames += 1
      if (text.includes('log-stream-closed')) break
    }
  } finally {
    await reader.cancel()
  }

  return text
}

describeWithDatabase('the log stream route against a live database', () => {
  // The fixture is the spike's, reused rather than copied: it seeds the real
  // `users → setup_bundles → … → workflows` chain that a `log_segments` insert needs, and the
  // point of this suite is that the query runs against the actual table.
  const identifiers = buildFixtureIdentifiers()
  let sql: ReturnType<typeof postgres>
  let client: { db: unknown; close: () => Promise<void> }
  let workflowId: string

  beforeAll(async () => {
    const { createDatabaseClient } = await import('@bluetel-ai/sisyphus-api/db')
    sql = postgres(connectionString ?? '', { max: 2, prepare: false, onnotice: () => undefined })
    client = createDatabaseClient({ connectionString: connectionString ?? '' })
    await seedSpikeFixture(sql, identifiers)
    workflowId = await createSpikeWorkflow(sql, identifiers)
  })

  afterAll(async () => {
    await teardownSpikeFixture(sql, identifiers)
    await sql.end()
    await client.close()
  })

  const appendSegment = async (sequence: number): Promise<void> => {
    await sql`
      insert into log_segments
        (id, workflow_id, sequence, s3_key, byte_size, started_at, ended_at)
      values (${randomUUID()}, ${workflowId}, ${sequence},
              ${`logs/${workflowId}/${String(sequence)}.log`}, 512, now(), now())
    `
  }

  const importLiveRoute = async (session: SisyphusSession | null) => {
    vi.resetModules()
    vi.doMock('@sisyphus-admin/lib/auth', () => ({ getAuthDatabase: () => client.db }))
    vi.doMock('@sisyphus-admin/server', () => ({
      resolveSisyphusSession: () => Promise.resolve(session),
      recordDenial: vi.fn(() => Promise.resolve()),
    }))
    return import('./route')
  }

  it('delivers the whole log to a fresh connection and closes when the run ends', async () => {
    await appendSegment(1)
    await appendSegment(2)
    await sql`update workflows set state = 'succeeded' where id = ${workflowId}`

    const { GET } = await importLiveRoute(adminSession())
    const response = await GET(
      new Request(`https://sisyphus.example.com/api/stream/${workflowId}`),
      { params: Promise.resolve({ workflowId }) },
    )
    const body = await readStream(response)

    expect(body).toContain('id: 1')
    expect(body).toContain('id: 2')
    expect(body).toContain('log-stream-closed')
    expect(body).toContain('"reason":"terminal"')
  })

  it('resumes from Last-Event-ID rather than replaying the tail (spike S3, finding g)', async () => {
    await appendSegment(3)

    const { GET } = await importLiveRoute(adminSession())
    const response = await GET(
      new Request(`https://sisyphus.example.com/api/stream/${workflowId}`, {
        headers: { 'last-event-id': '2' },
      }),
      { params: Promise.resolve({ workflowId }) },
    )
    const body = await readStream(response)

    expect(body).not.toContain('id: 1')
    expect(body).not.toContain('id: 2')
    expect(body).toContain('id: 3')
  })

  it('gives a caller with no grant the same 404 a nonexistent run gets', async () => {
    const session = adminSession()
    const { GET } = await importLiveRoute({
      ...session,
      user: { ...session.user, role: 'engineer', id: randomUUID() },
    })

    const response = await GET(
      new Request(`https://sisyphus.example.com/api/stream/${workflowId}`),
      { params: Promise.resolve({ workflowId }) },
    )

    expect(response.status).toBe(404)
    expect(await response.text()).toBe(
      JSON.stringify({ error: { message: 'Workflow not found.' } }),
    )
  })
})
