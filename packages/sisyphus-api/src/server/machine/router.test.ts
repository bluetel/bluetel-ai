import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import type { SisyphusDatabase } from '../../db'
import type {
  AuthorisationDenial,
  MachineCredential,
  SisyphusContext,
  SisyphusSession,
} from '../context'
import { createCallerFactory } from '../procedures'

import { machineSurfaceRouter } from './router'

/**
 * The machine router's shape and the boundary it sits on.
 *
 * The behaviour of each reporter is settled against a real Postgres in its own suite. What is
 * settled here is the part those suites construct away by handing the resolver a credential: that
 * the surface **cannot be reached without one**, and that presenting a human session alongside one
 * is refused rather than honoured. That second rule is FR-005 from the other direction — an
 * executor credential grants nothing on the interactive surface, and an interactive session grants
 * nothing here — and a mistake in it would not be visible in any live test above.
 */

const unreachableDatabase = new Proxy(
  {},
  {
    get: () => {
      throw new Error('an unauthorised machine request must be refused before any query')
    },
  },
) as SisyphusDatabase

const liveCredential = (): MachineCredential => ({
  credentialId: randomUUID(),
  workflowId: randomUUID(),
  jti: randomUUID(),
  expiresAt: new Date(Date.now() + 60_000),
})

const callerWith = (options: {
  readonly credential: MachineCredential | null
  readonly session?: SisyphusSession | null
  readonly denials?: AuthorisationDenial[]
}) => {
  const session = options.session ?? null
  const context: SisyphusContext = {
    headers: new Headers(),
    dependencies: {
      db: unreachableDatabase,
      resolveSession: () => Promise.resolve(session),
      resolveMachineCredential: () => Promise.resolve(options.credential),
      recordDenial: (denial) => {
        options.denials?.push(denial)
        return Promise.resolve()
      },
    },
    db: unreachableDatabase,
    session,
    scope: { resolve: () => Promise.reject(new Error('the machine surface has no scope')) },
    machineCredential: () => Promise.resolve(options.credential),
  }

  return createCallerFactory(machineSurfaceRouter)(context)
}

const heartbeatPayload = { state: 'running', turnsUsed: 1, spendUsed: '0' } as const

describe('machineSurfaceRouter', () => {
  it('exposes exactly the procedures the executor may call', () => {
    expect(Object.keys(machineSurfaceRouter._def.procedures).sort()).toStrictEqual([
      'acknowledgeCommand',
      'acknowledgeCorrection',
      'appendLogSegment',
      // The two credential calls, and the only two shapes on this surface that carry material
      // (003/FR-012, 003/FR-020, 003/FR-032). Neither has a parameter for naming a seat — see
      // `./agent-credential.ts` and its suite.
      'fetchAgentCredential',
      'heartbeat',
      // The two polls. Mutations rather than queries, so nothing on this surface can be served
      // from a cacheable GET — see the note on each procedure.
      'pullPendingCommands',
      'pullPendingCorrections',
      'registerArtifact',
      'registerSnapshot',
      'renewCredential',
      'reportBootstrapPhase',
      'reportCredentialRotation',
      'reportEntryCheckout',
      'reportEntryResult',
      // The durable half of FR-076. Called *before* the action, so its response is what decides
      // whether the caller may act — see `./external-actions.ts`.
      'reportExternalAction',
      'reportIteration',
      'reportReviewerSummary',
      // The write half of `workflow.skillReferences`, which read an unwritten table until T179.
      'reportSkillReference',
      // `registerSnapshot`'s counterpart: the boundary that could **not** be written, which the
      // run is holding at and retrying. A live run waiting on storage, never the
      // `parked_resumable` outcome — see `./snapshot-park.ts` (T184, FR-082).
      'reportSnapshotPark',
      'reportTerminal',
    ])
  })

  it('refuses the two newly mounted reporters without a credential, before any query', async () => {
    const caller = callerWith({ credential: null })

    await expect(caller.reportReviewerSummary({ summary: 'anything' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
    await expect(
      caller.reportEntryResult({
        entryId: randomUUID(),
        resolvedCommit: 'a'.repeat(40),
        wasChanged: false,
        entryResult: 'unchanged',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('refuses reportEntryCheckout and registerSnapshot without a credential, before any query', async () => {
    const caller = callerWith({ credential: null })

    await expect(
      caller.reportEntryCheckout({ entryId: randomUUID(), resolvedCommit: 'b'.repeat(40) }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(
      caller.registerSnapshot({
        sessionId: randomUUID(),
        s3Key: 'snapshots/anything.tar.zst',
        sizeBytes: 1,
        boundary: 'completion',
        hasConversationState: true,
        hasWorktreeState: true,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(
      caller.reportSnapshotPark({
        boundary: 'pause',
        attempt: 1,
        maxAttempts: 8,
        nextDelayMs: 1000,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('refuses the skill and external-action reporters without a credential, before any query', async () => {
    const caller = callerWith({ credential: null })

    await expect(
      caller.reportSkillReference({ skillName: 'sisyphus-dev', contentDigest: 'a'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(
      caller.reportExternalAction({
        kind: 'comment_posted',
        targetReference: 'PROJ-1',
        idempotencyKey: 'comment-posted:PROJ-1:review-complete',
        result: 'pending',
        attemptCount: 1,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('is every one a mutation — nothing on this surface is a cacheable read', () => {
    for (const procedure of Object.values(machineSurfaceRouter._def.procedures)) {
      expect((procedure as { _def: { type: string } })._def.type).toBe('mutation')
    }
  })

  describe('without a credential', () => {
    it('refuses and records the missing credential', async () => {
      const denials: AuthorisationDenial[] = []

      await expect(
        callerWith({ credential: null, denials }).heartbeat(heartbeatPayload),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })

      expect(denials[0]).toMatchObject({ reason: 'machine_credential_missing' })
    })

    it('never reaches the database', async () => {
      // The proxy handle throws on any access, so a refusal that happened after a query would
      // surface as that error rather than as UNAUTHORIZED.
      await expect(callerWith({ credential: null }).renewCredential()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      })
    })
  })

  describe('with an expired credential', () => {
    it('refuses and records it as invalid', async () => {
      const denials: AuthorisationDenial[] = []
      const expired = { ...liveCredential(), expiresAt: new Date(Date.now() - 1000) }

      await expect(
        callerWith({ credential: expired, denials }).heartbeat(heartbeatPayload),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })

      expect(denials[0]).toMatchObject({ reason: 'machine_credential_invalid' })
    })
  })

  describe('with a human session presented alongside the credential', () => {
    it('refuses, so the two surfaces cannot lend each other authority (FR-005)', async () => {
      const denials: AuthorisationDenial[] = []
      const session: SisyphusSession = {
        user: {
          id: randomUUID(),
          email: 'someone@sisyphus.test',
          displayName: 'Someone',
          role: 'admin',
          isActive: true,
        },
        expiresAt: new Date(Date.now() + 60_000),
      }

      await expect(
        callerWith({ credential: liveCredential(), session, denials }).heartbeat(heartbeatPayload),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })

      expect(denials[0]).toMatchObject({ reason: 'surface_confusion' })
    })
  })
})
