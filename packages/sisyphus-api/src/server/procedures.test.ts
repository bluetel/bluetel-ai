import { TRPCError } from '@trpc/server'
import { describe, expect, it } from 'vitest'

import type { SisyphusDatabase } from '../db'

import type {
  AuthorisationDenial,
  MachineCredential,
  SisyphusContext,
  SisyphusSession,
} from './context'
import {
  adminProcedure,
  assertMachineWorkflowMatches,
  authedProcedure,
  createCallerFactory,
  createTRPCRouter,
  machineProcedure,
  publicProcedure,
  scopedProcedure,
} from './procedures'
import { memoiseScope } from './scope'

const OWNER_ID = '11111111-1111-7111-8111-111111111111'
const WORKFLOW_ID = '33333333-3333-7333-8333-333333333333'
const OTHER_WORKFLOW_ID = '44444444-4444-7444-8444-444444444444'

const unusedDatabase = {} as SisyphusDatabase

/**
 * A router exercising all five procedure types. Each resolver returns the part of the context its
 * procedure is supposed to have guaranteed, so a middleware that stopped guaranteeing it fails
 * here rather than in whichever resolver first assumed it.
 */
const probeRouter = createTRPCRouter({
  open: publicProcedure.query(() => 'open'),
  authed: authedProcedure.query(({ ctx }) => ctx.user.email),
  admin: adminProcedure.query(({ ctx }) => ctx.user.role),
  scoped: scopedProcedure.query(({ ctx }) => ctx.scope),
  machine: machineProcedure.query(({ ctx }) => ctx.workflowId),
})

const buildSession = (overrides: Partial<SisyphusSession['user']> = {}): SisyphusSession => ({
  user: {
    id: OWNER_ID,
    email: 'engineer@example.com',
    displayName: 'An Engineer',
    role: 'engineer',
    isActive: true,
    ...overrides,
  },
  expiresAt: new Date(Date.now() + 60_000),
})

const buildCredential = (overrides: Partial<MachineCredential> = {}): MachineCredential => ({
  credentialId: '22222222-2222-7222-8222-222222222222',
  workflowId: WORKFLOW_ID,
  jti: 'jti-1',
  expiresAt: new Date(Date.now() + 60_000),
  ...overrides,
})

const buildHarness = (options: {
  readonly session?: SisyphusSession | null
  readonly credential?: MachineCredential | null
  readonly visibleProfileIds?: readonly string[]
}) => {
  const denials: AuthorisationDenial[] = []
  const state = { grantsQueries: 0 }
  const session = options.session ?? null

  const context: SisyphusContext = {
    headers: new Headers(),
    dependencies: {
      db: unusedDatabase,
      resolveSession: () => Promise.resolve(session),
      resolveMachineCredential: () => Promise.resolve(options.credential ?? null),
      recordDenial: (denial) => {
        denials.push(denial)
        return Promise.resolve()
      },
    },
    db: unusedDatabase,
    session,
    scope: memoiseScope(() => {
      state.grantsQueries += 1
      return Promise.resolve({
        userId: session?.user.id ?? OWNER_ID,
        isAdmin: session?.user.role === 'admin',
        visibleProfileIds: options.visibleProfileIds ?? [],
      })
    }),
    machineCredential: () => Promise.resolve(options.credential ?? null),
  }

  return {
    caller: createCallerFactory(probeRouter)(context),
    denials,
    state,
  }
}

describe('publicProcedure', () => {
  it('guarantees nothing and needs nothing', async () => {
    const { caller } = buildHarness({})
    await expect(caller.open()).resolves.toBe('open')
  })

  it('never resolves the caller scope, so a health check pays for no grants query (FR-190)', async () => {
    const harness = buildHarness({ session: buildSession() })
    await harness.caller.open()

    expect(harness.state.grantsQueries).toBe(0)
  })
})

describe('authedProcedure', () => {
  it('refuses an unauthenticated request with UNAUTHORIZED and no workflow data (FR-011)', async () => {
    const { caller } = buildHarness({})

    await expect(caller.authed()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Not signed in.',
    })
  })

  it('refuses a deactivated user at the next request, not at next sign-in (FR-175)', async () => {
    const harness = buildHarness({ session: buildSession({ isActive: false }) })

    await expect(harness.caller.authed()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(harness.denials).toStrictEqual([
      { reason: 'inactive_user', userId: OWNER_ID, path: 'authed' },
    ])
  })

  it('grants nothing to an executor credential — that is the machine surface only (FR-005)', async () => {
    const { caller } = buildHarness({ session: null, credential: buildCredential() })

    await expect(caller.authed()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('sets ctx.user for an active session', async () => {
    const { caller } = buildHarness({ session: buildSession() })

    await expect(caller.authed()).resolves.toBe('engineer@example.com')
  })
})

describe('adminProcedure', () => {
  it('refuses a non-admin with FORBIDDEN and records the denial (FR-169)', async () => {
    const harness = buildHarness({ session: buildSession() })

    await expect(harness.caller.admin()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(harness.denials).toStrictEqual([
      { reason: 'not_admin', userId: OWNER_ID, path: 'admin' },
    ])
  })

  it('states a reason — nothing about anyone else’s data is disclosed by doing so', async () => {
    const harness = buildHarness({ session: buildSession() })

    await expect(harness.caller.admin()).rejects.toThrow(/requires the admin role/)
  })

  it('admits an admin and records nothing', async () => {
    const harness = buildHarness({ session: buildSession({ role: 'admin' }) })

    await expect(harness.caller.admin()).resolves.toBe('admin')
    expect(harness.denials).toStrictEqual([])
  })

  it('still refuses a deactivated admin, because it builds on authedProcedure', async () => {
    const harness = buildHarness({ session: buildSession({ role: 'admin', isActive: false }) })

    await expect(harness.caller.admin()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })
})

describe('scopedProcedure', () => {
  it('resolves the caller scope once and hands it to the resolver', async () => {
    const harness = buildHarness({
      session: buildSession(),
      visibleProfileIds: ['55555555-5555-7555-8555-555555555555'],
    })

    await expect(harness.caller.scoped()).resolves.toStrictEqual({
      userId: OWNER_ID,
      isAdmin: false,
      visibleProfileIds: ['55555555-5555-7555-8555-555555555555'],
    })
    expect(harness.state.grantsQueries).toBe(1)
  })

  it('requires a session first, so there is no unscoped path into a workflow read', async () => {
    const { caller } = buildHarness({})

    await expect(caller.scoped()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })
})

describe('machineProcedure', () => {
  it('refuses a request with no credential and records it', async () => {
    const harness = buildHarness({})

    await expect(harness.caller.machine()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(harness.denials).toStrictEqual([
      { reason: 'machine_credential_missing', path: 'machine' },
    ])
  })

  it('refuses an interactive session presented on the machine surface', async () => {
    const harness = buildHarness({
      session: buildSession(),
      credential: buildCredential(),
    })

    await expect(harness.caller.machine()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(harness.denials.map((denial) => denial.reason)).toStrictEqual(['surface_confusion'])
  })

  it('refuses an expired credential rather than trusting its workflow id', async () => {
    const harness = buildHarness({
      credential: buildCredential({ expiresAt: new Date(Date.now() - 1) }),
    })

    await expect(harness.caller.machine()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(harness.denials.map((denial) => denial.reason)).toStrictEqual([
      'machine_credential_invalid',
    ])
  })

  it('pins the request to the credential’s workflow', async () => {
    const harness = buildHarness({ credential: buildCredential() })

    await expect(harness.caller.machine()).resolves.toBe(WORKFLOW_ID)
    expect(harness.denials).toStrictEqual([])
  })
})

describe('assertMachineWorkflowMatches', () => {
  const buildMachineContext = () => {
    const denials: AuthorisationDenial[] = []
    return {
      denials,
      ctx: {
        workflowId: WORKFLOW_ID,
        credential: buildCredential(),
        dependencies: {
          db: unusedDatabase,
          resolveSession: () => Promise.resolve(null),
          resolveMachineCredential: () => Promise.resolve(null),
          recordDenial: (denial: AuthorisationDenial) => {
            denials.push(denial)
            return Promise.resolve()
          },
        },
      },
    }
  }

  it('passes a write naming its own workflow', async () => {
    const { ctx, denials } = buildMachineContext()

    await expect(assertMachineWorkflowMatches(ctx, WORKFLOW_ID)).resolves.toBeUndefined()
    expect(denials).toStrictEqual([])
  })

  it('refuses a cross-workflow write with FORBIDDEN and records a security event (FR-018)', async () => {
    const { ctx, denials } = buildMachineContext()

    await expect(
      assertMachineWorkflowMatches(ctx, OTHER_WORKFLOW_ID, 'appendLogSegment'),
    ).rejects.toBeInstanceOf(TRPCError)
    expect(denials).toStrictEqual([
      {
        reason: 'cross_workflow_write',
        workflowId: WORKFLOW_ID,
        path: 'appendLogSegment',
        detail: 'write named a workflow the credential does not cover',
      },
    ])
  })

  it('does not name the other workflow in the message', async () => {
    const { ctx } = buildMachineContext()
    const error = await assertMachineWorkflowMatches(ctx, OTHER_WORKFLOW_ID).catch(
      (caught: unknown) => caught,
    )

    expect((error as Error).message).not.toContain(OTHER_WORKFLOW_ID)
  })
})

describe('the denial recorder', () => {
  it('stays quiet for an ordinary signed-out request', async () => {
    // A signed-out browser hitting a page is ordinary traffic. Recording it would bury the
    // refusals that actually indicate someone using access they no longer have.
    const harness = buildHarness({})

    await expect(harness.caller.authed()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(harness.denials).toStrictEqual([])
  })
})
