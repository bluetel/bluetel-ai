import { TRPCError } from '@trpc/server'
import { describe, expect, it } from 'vitest'

import type { SisyphusDatabase } from '../db'

import type {
  AuthorisationDenial,
  MachineCredential,
  SisyphusContext,
  SisyphusSession,
  ValidationRunCredential,
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
  validationProcedure,
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
  validation: validationProcedure.query(({ ctx }) => ctx.validationRunId),
  validationKeys: validationProcedure.query(({ ctx }) => Object.keys(ctx)),
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

const VALIDATION_RUN_ID = '55555555-5555-7555-8555-555555555555'

const buildValidationCredential = (
  overrides: Partial<ValidationRunCredential> = {},
): ValidationRunCredential => ({
  credentialId: '66666666-6666-7666-8666-666666666666',
  validationRunId: VALIDATION_RUN_ID,
  jti: 'validation-jti-1',
  expiresAt: new Date(Date.now() + 60_000),
  ...overrides,
})

const buildHarness = (options: {
  readonly session?: SisyphusSession | null
  readonly credential?: MachineCredential | null
  readonly validationCredential?: ValidationRunCredential | null
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
    validationCredential: () => Promise.resolve(options.validationCredential ?? null),
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

describe('validationProcedure', () => {
  it('refuses a request with no credential and records it (T200, FR-147)', async () => {
    // Also the shape a host that has not wired `resolveValidationCredential` produces: the
    // dependency is optional and an unwired one resolves `null`, so a misconfigured deployment
    // refuses reports rather than accepting unauthenticated ones.
    const harness = buildHarness({})

    await expect(harness.caller.validation()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(harness.denials).toStrictEqual([
      { reason: 'machine_credential_missing', path: 'validation' },
    ])
  })

  it('refuses an interactive session presented on the machine surface (FR-005)', async () => {
    const harness = buildHarness({
      session: buildSession(),
      validationCredential: buildValidationCredential(),
    })

    await expect(harness.caller.validation()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(harness.denials).toStrictEqual([
      {
        reason: 'surface_confusion',
        userId: OWNER_ID,
        validationRunId: VALIDATION_RUN_ID,
        path: 'validation',
        detail: 'human session presented on the machine surface',
      },
    ])
  })

  it('refuses an expired credential rather than trusting its run id', async () => {
    const harness = buildHarness({
      validationCredential: buildValidationCredential({ expiresAt: new Date(Date.now() - 1) }),
    })

    await expect(harness.caller.validation()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(harness.denials).toStrictEqual([
      {
        reason: 'machine_credential_invalid',
        validationRunId: VALIDATION_RUN_ID,
        path: 'validation',
        detail: 'expired',
      },
    ])
  })

  it('pins the request to the credential’s validation run', async () => {
    const harness = buildHarness({ validationCredential: buildValidationCredential() })

    await expect(harness.caller.validation()).resolves.toBe(VALIDATION_RUN_ID)
    expect(harness.denials).toStrictEqual([])
  })

  it('is not satisfied by a workflow credential, and does not satisfy a machine procedure', async () => {
    // The two are siblings rather than a chain, and this is what that buys: neither resolver's
    // credential is admissible to the other's procedure, so no resolver can be reached with the
    // wrong one. Nothing in either middleware has to remember to check.
    const workflowOnly = buildHarness({ credential: buildCredential() })
    await expect(workflowOnly.caller.validation()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })

    const validationOnly = buildHarness({ validationCredential: buildValidationCredential() })
    await expect(validationOnly.caller.machine()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('puts no workflow id on the context under any name', async () => {
    // A validation run has no workflow. A `ctx.workflowId` here — even one holding the validation
    // run's id — would let a validation credential satisfy `assertMachineWorkflowMatches` against a
    // row that does not exist. `validationKeys` returns the resolver's whole context.
    const harness = buildHarness({ validationCredential: buildValidationCredential() })

    await expect(harness.caller.validationKeys()).resolves.not.toContain('workflowId')
    await expect(harness.caller.validationKeys()).resolves.toContain('validationRunId')
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
