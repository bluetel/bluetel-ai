import type { ResolvedScope, ScopeIdentity, SisyphusSession } from '@bluetel-ai/sisyphus-api/server'
import { describe, expect, it, vi } from 'vitest'

import {
  createRevalidatingScope,
  decideLogStreamAccess,
  identityFor,
  refusalResponse,
  SCOPE_REVALIDATION_MS,
} from './stream-access'

const WORKFLOW_ID = '01890a5d-ac96-774b-bcce-b302099a8057'

const sessionFor = (overrides: Partial<SisyphusSession['user']> = {}): SisyphusSession => ({
  user: {
    id: 'user-1',
    email: 'engineer@bluetel.co.uk',
    displayName: 'An Engineer',
    role: 'engineer',
    isActive: true,
    ...overrides,
  },
  expiresAt: new Date('2026-08-07T00:00:00.000Z'),
})

const visible = () => Promise.resolve({ id: WORKFLOW_ID, state: 'running' })
const invisible = () => Promise.resolve(undefined)

describe('decideLogStreamAccess', () => {
  it('grants a signed-in caller the run is visible to', async () => {
    await expect(
      decideLogStreamAccess({
        session: sessionFor(),
        workflowId: WORKFLOW_ID,
        findWorkflowInScope: visible,
      }),
    ).resolves.toStrictEqual({
      outcome: 'granted',
      workflow: { id: WORKFLOW_ID, state: 'running' },
      identity: { userId: 'user-1', isAdmin: false },
    })
  })

  it('refuses a caller with no session, without reaching the database', async () => {
    const lookup = vi.fn(visible)

    await expect(
      decideLogStreamAccess({
        session: null,
        workflowId: WORKFLOW_ID,
        findWorkflowInScope: lookup,
      }),
    ).resolves.toStrictEqual({ outcome: 'unauthenticated' })
    expect(lookup).not.toHaveBeenCalled()
  })

  it('refuses a deactivated account at its next request (FR-175)', async () => {
    await expect(
      decideLogStreamAccess({
        session: sessionFor({ isActive: false }),
        workflowId: WORKFLOW_ID,
        findWorkflowInScope: visible,
      }),
    ).resolves.toStrictEqual({ outcome: 'inactive', userId: 'user-1' })
  })

  it('answers a malformed id as absent rather than as a bad request', async () => {
    await expect(
      decideLogStreamAccess({
        session: sessionFor(),
        workflowId: '',
        findWorkflowInScope: visible,
      }),
    ).resolves.toStrictEqual({ outcome: 'not-found' })

    await expect(
      decideLogStreamAccess({
        session: sessionFor(),
        workflowId: undefined,
        findWorkflowInScope: visible,
      }),
    ).resolves.toStrictEqual({ outcome: 'not-found' })
  })

  it('gives an out-of-scope caller the same answer as a nonexistent workflow (FR-190)', async () => {
    const outOfScope = await decideLogStreamAccess({
      session: sessionFor(),
      workflowId: WORKFLOW_ID,
      findWorkflowInScope: invisible,
    })
    const nonexistent = await decideLogStreamAccess({
      session: sessionFor(),
      workflowId: '01890a5d-ac96-774b-bcce-b3020000dead',
      findWorkflowInScope: invisible,
    })

    expect(outOfScope).toStrictEqual(nonexistent)
  })

  it('asks the scope for admin callers too, rather than short-circuiting on the role', async () => {
    const lookup = vi.fn(visible)

    await decideLogStreamAccess({
      session: sessionFor({ role: 'admin' }),
      workflowId: WORKFLOW_ID,
      findWorkflowInScope: lookup,
    })

    expect(lookup).toHaveBeenCalledWith({ userId: 'user-1', isAdmin: true }, WORKFLOW_ID)
  })
})

describe('identityFor', () => {
  it('reads admin off the role, which is what widens the visible set (FR-181)', () => {
    expect(identityFor(sessionFor({ role: 'admin' })).isAdmin).toBe(true)
    expect(identityFor(sessionFor({ role: 'engineer' })).isAdmin).toBe(false)
  })
})

describe('refusalResponse', () => {
  it('answers an out-of-scope read exactly as it answers a nonexistent one', async () => {
    const response = refusalResponse({ outcome: 'not-found' })

    expect(response.status).toBe(404)
    expect(await response.text()).toBe(
      JSON.stringify({ error: { message: 'Workflow not found.' } }),
    )
  })

  it('never opens an event stream on a refusal, whatever the reason', () => {
    for (const access of [
      { outcome: 'not-found' },
      { outcome: 'unauthenticated' },
      { outcome: 'inactive', userId: 'user-1' },
    ] as const) {
      expect(refusalResponse(access).headers.get('content-type')).toBe('application/json')
      expect(refusalResponse(access).headers.get('cache-control')).toBe('no-store')
    }
  })

  it('mirrors authedProcedure for a missing session and a deactivated one', async () => {
    const signedOut = refusalResponse({ outcome: 'unauthenticated' })
    const deactivated = refusalResponse({ outcome: 'inactive', userId: 'user-1' })

    expect(signedOut.status).toBe(401)
    expect(deactivated.status).toBe(401)
    expect(await signedOut.text()).toContain('Not signed in.')
    expect(await deactivated.text()).toContain('no longer active')
  })
})

describe('createRevalidatingScope', () => {
  const identity: ScopeIdentity = { userId: 'user-1', isAdmin: false }
  const scopeWith = (profileIds: readonly string[]): ResolvedScope => ({
    userId: 'user-1',
    isAdmin: false,
    visibleProfileIds: profileIds,
  })

  it('resolves once and reuses the answer inside the window', async () => {
    const resolve = vi.fn(() => Promise.resolve(scopeWith(['profile-a'])))
    let clock = 1_000
    const scope = createRevalidatingScope({ identity, resolve, now: () => clock })

    await scope.resolve()
    clock += SCOPE_REVALIDATION_MS - 1
    await scope.resolve()

    expect(resolve).toHaveBeenCalledOnce()
  })

  it('re-resolves once the window has passed, so a revoked grant lands mid-stream (FR-184)', async () => {
    const resolve = vi
      .fn<(identity: ScopeIdentity) => Promise<ResolvedScope>>()
      .mockResolvedValueOnce(scopeWith(['profile-a']))
      .mockResolvedValueOnce(scopeWith([]))
    let clock = 1_000
    const scope = createRevalidatingScope({ identity, resolve, now: () => clock })

    await expect(scope.resolve()).resolves.toStrictEqual(scopeWith(['profile-a']))
    clock += SCOPE_REVALIDATION_MS
    await expect(scope.resolve()).resolves.toStrictEqual(scopeWith([]))
  })

  it('shares one in-flight resolution between concurrent callers', async () => {
    const resolve = vi.fn(() => Promise.resolve(scopeWith([])))
    const scope = createRevalidatingScope({ identity, resolve, now: () => 0 })

    await Promise.all([scope.resolve(), scope.resolve(), scope.resolve()])

    expect(resolve).toHaveBeenCalledOnce()
  })
})
