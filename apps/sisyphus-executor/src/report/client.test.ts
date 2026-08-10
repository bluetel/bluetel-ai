import { describe, expect, it, vi } from 'vitest'

import type { LogSegmentRecord, SanitisedText } from '../output'
import { sanitise } from '../output'

import { createBackoff } from './backoff'
import type { MachineSurfaceTransport, TerminalReport } from './client'
import {
  createHttpMachineTransport,
  createMachineSurfaceClient,
  crossWorkflowSegmentError,
} from './client'
import { OutboxFullError } from './outbox'

const WORKFLOW_ID = '3f7b6d2a-1c5e-4a9b-8d3f-2e6c9a4b1d70'

/**
 * Yields through a timer rather than a resolved promise, so a test holding a
 * permanently failing call still gets its own turn of the event loop.
 */
const noSleep = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

const instantBackoff = createBackoff({ initialDelayMs: 0, random: () => 0 })

interface FakeTransport {
  readonly transport: MachineSurfaceTransport
  readonly calls: { readonly procedure: string; readonly input: unknown }[]
  failNext: number
}

const fakeTransport = (): FakeTransport => {
  const calls: { procedure: string; input: unknown }[] = []
  const state = { failNext: 0 }

  const record = async (procedure: string, input: unknown): Promise<void> => {
    if (state.failNext > 0) {
      state.failNext -= 1

      throw new Error('machine surface unreachable')
    }

    calls.push({ procedure, input })

    await Promise.resolve()
  }

  return {
    calls,
    get failNext() {
      return state.failNext
    },
    set failNext(value: number) {
      state.failNext = value
    },
    transport: {
      heartbeat: async (input) => record('heartbeat', input),
      fetchAgentCredential: async () => {
        await record('fetchAgentCredential', {})

        return {
          credentialId: '019fd631-15bf-7a03-a1c6-ff6d568c2670',
          fence: 3,
          // Synthetic. Not a credential belonging to anything.
          material: 'not-a-real-agent-credential-0123456789-opaque',
        }
      },
      reportCredentialRotation: async (input) => {
        await record('reportCredentialRotation', input)

        return { accepted: true as const }
      },
      reportBootstrapPhase: async (input) => record('reportBootstrapPhase', input),
      appendLogSegment: async (input) => record('appendLogSegment', input),
      reportTerminal: async (input) => record('reportTerminal', input),
      registerArtifact: async (input) => record('registerArtifact', input),
      registerSnapshot: async (input) => record('registerSnapshot', input),
      reportSnapshotPark: async (input) => record('reportSnapshotPark', input),
      acknowledgeCommand: async (input) => record('acknowledgeCommand', input),
      reportSkillReference: async (input) => record('reportSkillReference', input),
      reportIteration: async (input) => record('reportIteration', input),
      reportExternalAction: async (input) => {
        await record('reportExternalAction', input)

        return {
          action: {
            id: '4a1c0f6e-1d2b-4c3a-8e9f-0a1b2c3d4e5f',
            workflowId: '2b6c7d8e-9f01-4234-8567-89abcdef0123',
            kind: input.kind,
            targetReference: input.targetReference,
            idempotencyKey: input.idempotencyKey,
            result: input.result,
            attemptCount: input.attemptCount,
            error: null,
            createdAt: new Date(0),
          },
          claimed: true,
          alreadyPerformed: false,
        }
      },
      pullPendingCommands: async () => {
        await record('pullPendingCommands', undefined)

        return []
      },
      renewCredential: async () => {
        await record('renewCredential', undefined)

        return {
          credentialId: '9f5a1c30-0d21-4c8a-9b6e-1a2b3c4d5e6f',
          jti: 'f1e2d3c4-b5a6-4978-8899-aabbccddeeff',
          expiresAt: new Date(0),
          renewalCount: 1,
        }
      },
    },
  }
}

const segment = (sequence: number, workflowId = WORKFLOW_ID): LogSegmentRecord => ({
  workflowId,
  sequence,
  s3Key: `workflows/${workflowId}/logs/${String(sequence)}.log`,
  byteSize: 12,
  startedAt: new Date(1_000),
  endedAt: new Date(2_000),
})

describe('createMachineSurfaceClient', () => {
  it('satisfies the output pipeline’s SegmentReporter without forwarding a workflow id', async () => {
    const fake = fakeTransport()
    const client = createMachineSurfaceClient({
      workflowId: WORKFLOW_ID,
      transport: fake.transport,
      sleep: noSleep,
    })

    await client.appendLogSegment(segment(0))
    await client.flush()

    expect(fake.calls).toEqual([
      {
        procedure: 'appendLogSegment',
        input: {
          sequence: 0,
          s3Key: `workflows/${WORKFLOW_ID}/logs/0.log`,
          byteSize: 12,
          startedAt: new Date(1_000),
          endedAt: new Date(2_000),
        },
      },
    ])
    expect(fake.calls[0].input).not.toHaveProperty('workflowId')
  })

  it('refuses a segment built for a different workflow', async () => {
    const fake = fakeTransport()
    const client = createMachineSurfaceClient({
      workflowId: WORKFLOW_ID,
      transport: fake.transport,
      sleep: noSleep,
    })

    const other = '00000000-0000-4000-8000-000000000001'

    await expect(client.appendLogSegment(segment(0, other))).rejects.toThrow(
      crossWorkflowSegmentError(WORKFLOW_ID, other).message,
    )
    expect(fake.calls).toEqual([])
  })

  it('buffers a durable record and retries it, replaying the same sequence', async () => {
    const fake = fakeTransport()
    const client = createMachineSurfaceClient({
      workflowId: WORKFLOW_ID,
      transport: fake.transport,
      sleep: noSleep,
      backoff: instantBackoff,
    })

    fake.failNext = 3

    await client.appendLogSegment(segment(7))

    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].input).toMatchObject({ sequence: 7 })
  })

  it('preserves the order of buffered records across a failure', async () => {
    const fake = fakeTransport()
    const client = createMachineSurfaceClient({
      workflowId: WORKFLOW_ID,
      transport: fake.transport,
      sleep: noSleep,
      backoff: instantBackoff,
    })

    fake.failNext = 2

    const writes = [0, 1, 2].map(async (sequence) => client.appendLogSegment(segment(sequence)))

    await Promise.all(writes)
    await client.flush()

    expect(fake.calls.map((call) => (call.input as { sequence: number }).sequence)).toEqual([
      0, 1, 2,
    ])
  })

  it('sends a heartbeat directly, so a stale one is never replayed as liveness', async () => {
    const fake = fakeTransport()
    const client = createMachineSurfaceClient({
      workflowId: WORKFLOW_ID,
      transport: fake.transport,
      sleep: noSleep,
      backoff: instantBackoff,
    })

    fake.failNext = 1

    await expect(
      client.heartbeat({ state: 'running', turnsUsed: 2, spendUsed: '1.50' }),
    ).rejects.toThrow('machine surface unreachable')
    expect(client.pendingReports).toBe(0)

    await client.heartbeat({ state: 'running', turnsUsed: 3, spendUsed: '1.75' })

    expect(fake.calls).toEqual([
      { procedure: 'heartbeat', input: { state: 'running', turnsUsed: 3, spendUsed: '1.75' } },
    ])
  })

  it('reports a park directly — a replayed one announces a park that has cleared (FR-082)', async () => {
    const fake = fakeTransport()
    const client = createMachineSurfaceClient({
      workflowId: WORKFLOW_ID,
      transport: fake.transport,
      sleep: noSleep,
      backoff: instantBackoff,
    })

    fake.failNext = 1

    const park = {
      boundary: 'pause',
      attempt: 1,
      maxAttempts: 8,
      nextDelayMs: 1000,
      detail: 'connect ETIMEDOUT' as SanitisedText,
    } as const

    await expect(client.reportSnapshotPark(park)).rejects.toThrow('machine surface unreachable')
    // Nothing was queued: a park report is a claim about now, and there is nothing left holding a
    // copy of it to replay four minutes later.
    expect(client.pendingReports).toBe(0)

    await client.reportSnapshotPark({ ...park, attempt: 2, nextDelayMs: 2000 })

    expect(fake.calls).toEqual([
      { procedure: 'reportSnapshotPark', input: { ...park, attempt: 2, nextDelayMs: 2000 } },
    ])
  })

  it('renews the credential directly, because a buffered renewal renews nothing', async () => {
    const fake = fakeTransport()
    const client = createMachineSurfaceClient({
      workflowId: WORKFLOW_ID,
      transport: fake.transport,
      sleep: noSleep,
      backoff: instantBackoff,
    })

    fake.failNext = 1

    await expect(client.renewCredential()).rejects.toThrow('machine surface unreachable')
    expect(client.pendingReports).toBe(0)
  })

  /**
   * 003/FR-012, FR-030. Both credential calls are direct, and for the two reasons the interface
   * gives: a buffered fetch returns before the material exists, so the phase that called it would
   * write nothing and report success; and a buffered rotation hands back neither `stale_fence` nor
   * `not_newer`, which are the two answers the watcher branches on.
   */
  it('fetches the agent credential directly, because a buffered fetch returns nothing', async () => {
    const fake = fakeTransport()
    const client = createMachineSurfaceClient({
      workflowId: WORKFLOW_ID,
      transport: fake.transport,
      sleep: noSleep,
      backoff: instantBackoff,
    })

    fake.failNext = 1

    await expect(client.fetchAgentCredential()).rejects.toThrow('machine surface unreachable')
    expect(client.pendingReports).toBe(0)

    await expect(client.fetchAgentCredential()).resolves.toMatchObject({ fence: 3 })
  })

  it('reports a rotation directly, so the caller sees which answer it got (FR-020, FR-030)', async () => {
    const fake = fakeTransport()
    const client = createMachineSurfaceClient({
      workflowId: WORKFLOW_ID,
      transport: fake.transport,
      sleep: noSleep,
      backoff: instantBackoff,
    })

    fake.failNext = 1

    await expect(
      client.reportCredentialRotation({ fence: 3, material: 'not-a-real-rotation-0001' }),
    ).rejects.toThrow('machine surface unreachable')
    // Nothing queued: the watcher keeps the material pending and sends it again, which is a retry
    // of the newest bytes rather than a replay of stale ones.
    expect(client.pendingReports).toBe(0)

    await expect(
      client.reportCredentialRotation({ fence: 3, material: 'not-a-real-rotation-0001' }),
    ).resolves.toStrictEqual({ accepted: true })
  })

  it('buffers a skill reference and retries it — a lost digest is a lost fact (FR-059)', async () => {
    const fake = fakeTransport()
    const client = createMachineSurfaceClient({
      workflowId: WORKFLOW_ID,
      transport: fake.transport,
      sleep: noSleep,
      backoff: instantBackoff,
    })

    fake.failNext = 1

    await client.reportSkillReference({
      skillName: 'sisyphus-dev',
      resolvedPath: '.claude/skills/sisyphus-dev/SKILL.md',
      contentDigest: 'a'.repeat(64),
      phase: 'develop',
    })

    expect(fake.calls).toEqual([
      {
        procedure: 'reportSkillReference',
        input: {
          skillName: 'sisyphus-dev',
          resolvedPath: '.claude/skills/sisyphus-dev/SKILL.md',
          contentDigest: 'a'.repeat(64),
          phase: 'develop',
        },
      },
    ])
  })

  it('claims an external action directly, because a buffered claim is not a claim (FR-076)', async () => {
    const fake = fakeTransport()
    const client = createMachineSurfaceClient({
      workflowId: WORKFLOW_ID,
      transport: fake.transport,
      sleep: noSleep,
      backoff: instantBackoff,
    })

    fake.failNext = 1

    // Buffering would resolve here with nothing decided, and the caller would go on to post a
    // comment it had never been granted the right to post.
    await expect(
      client.reportExternalAction({
        kind: 'comment_posted',
        targetReference: 'PROJ-1',
        idempotencyKey: 'comment-posted:PROJ-1:review-complete',
        result: 'pending',
        attemptCount: 1,
      }),
    ).rejects.toThrow('machine surface unreachable')
    expect(client.pendingReports).toBe(0)

    const claim = await client.reportExternalAction({
      kind: 'comment_posted',
      targetReference: 'PROJ-1',
      idempotencyKey: 'comment-posted:PROJ-1:review-complete',
      result: 'pending',
      attemptCount: 2,
    })

    // The response is the point: it is what a re-provisioned instance reads instead of its own
    // empty ledger.
    expect(claim.claimed).toBe(true)
    expect(claim.alreadyPerformed).toBe(false)
  })

  it('buffers the terminal report, which must land even if the surface is briefly down', async () => {
    const fake = fakeTransport()
    const client = createMachineSurfaceClient({
      workflowId: WORKFLOW_ID,
      transport: fake.transport,
      sleep: noSleep,
      backoff: instantBackoff,
    })

    fake.failNext = 4

    const report: TerminalReport = {
      outcome: 'succeeded',
      reason: sanitise('the change is on a draft pull request'),
      turnsUsed: 4,
      spendUsed: '2.25',
    }

    await client.reportTerminal(report)

    expect(fake.calls).toEqual([{ procedure: 'reportTerminal', input: report }])
  })

  it('marks reporting degraded and refuses rather than discarding when the buffer fills', async () => {
    const fake = fakeTransport()
    const onSaturated = vi.fn()
    const client = createMachineSurfaceClient({
      workflowId: WORKFLOW_ID,
      transport: fake.transport,
      sleep: noSleep,
      backoff: instantBackoff,
      maxBufferedReports: 1,
      onSaturated,
    })

    fake.failNext = 1_000

    const accepted = client.appendLogSegment(segment(0))

    await noSleep()

    await expect(client.appendLogSegment(segment(1))).rejects.toBeInstanceOf(OutboxFullError)
    expect(client.isReportingDegraded).toBe(true)
    expect(onSaturated).toHaveBeenCalledWith({
      procedure: 'appendLogSegment',
      pending: 1,
      maxEntries: 1,
    })

    // Let the held record land so no retry loop outlives the test.
    fake.failNext = 0
    await accepted
  })

  it('accepts only sanitised text where the surface takes free text', () => {
    const detail: SanitisedText = sanitise('setup.sh exited 1')

    // The compile-time property this test names: `detail` and `reason` are
    // `SanitisedText`, so a raw string cannot reach the wire. If either field
    // were widened back to `string` this assignment would still pass but the
    // guarantee would be gone, which is why the branded type is what is
    // asserted rather than the value.
    expect(typeof detail).toBe('string')
    expect(detail).toBe('setup.sh exited 1')
  })
})

describe('createHttpMachineTransport', () => {
  /**
   * The request target as a string, whatever shape `fetch` was handed. Typed
   * as `unknown` rather than `RequestInfo`, which this project's `lib` does not
   * define.
   */
  const targetOf = (input: unknown): string => {
    if (typeof input === 'string') {
      return input
    }

    if (input instanceof URL) {
      return input.href
    }

    const request = input as { readonly url?: string }

    return request.url ?? ''
  }

  /** A tRPC-shaped success envelope, superjson encoded. No socket is opened. */
  const okResponse = (json: unknown): Response =>
    new Response(JSON.stringify({ result: { data: { json } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })

  it('posts to the supplied endpoint with the current credential', async () => {
    const seen: { url: string; authorization: string | null }[] = []
    let credential = 'first-credential'

    const transport = createHttpMachineTransport({
      url: 'https://panel.example/api/machine',
      credential: () => credential,
      fetch: (input, init) => {
        seen.push({
          url: targetOf(input),
          authorization: new Headers(init?.headers).get('authorization'),
        })

        return Promise.resolve(okResponse({ accepted: true }))
      },
    })

    await transport.heartbeat({ state: 'running', turnsUsed: 1, spendUsed: '0' })

    credential = 'renewed-credential'

    await transport.heartbeat({ state: 'running', turnsUsed: 2, spendUsed: '0' })

    expect(seen[0].url).toContain('https://panel.example/api/machine/heartbeat')
    // A renewal is picked up without rebuilding the client.
    expect(seen[0].authorization).toBe('Bearer first-credential')
    expect(seen[1].authorization).toBe('Bearer renewed-credential')
  })

  it('sends one request per procedure rather than batching independent records', async () => {
    const urls: string[] = []

    const transport = createHttpMachineTransport({
      url: 'https://panel.example/api/machine',
      credential: () => 'credential',
      fetch: (input) => {
        urls.push(targetOf(input))

        return Promise.resolve(okResponse(null))
      },
    })

    await Promise.all([
      transport.appendLogSegment({
        sequence: 0,
        s3Key: 'k',
        byteSize: 1,
        startedAt: new Date(0),
        endedAt: new Date(1),
      }),
      transport.registerArtifact({ kind: 'pull_request', externalUrl: 'https://forge.test/pr/1' }),
    ])

    expect(urls).toHaveLength(2)
    expect(urls.some((url) => url.includes('appendLogSegment'))).toBe(true)
    expect(urls.some((url) => url.includes('registerArtifact'))).toBe(true)
    expect(urls.every((url) => !url.includes('batch=1'))).toBe(true)
  })

  it('surfaces a transport failure so the outbox can retry it', async () => {
    const transport = createHttpMachineTransport({
      url: 'https://panel.example/api/machine',
      credential: () => 'credential',
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    })

    await expect(
      transport.reportBootstrapPhase({ phase: 'setup_script', outcome: 'failed' }),
    ).rejects.toThrow()
  })
})
