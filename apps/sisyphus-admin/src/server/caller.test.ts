import { describe, expect, it, vi } from 'vitest'

/**
 * The in-process caller, asserted for the two properties that are invisible at its call sites.
 *
 * **Nothing is evaluated at import time.** `next build` imports every page module while collecting
 * page data, and `headers()` throws outside a request — so a context built at module scope would
 * fail the build rather than the request.
 *
 * **The context is the real one.** `createCaller` is handed a factory that goes through
 * `createTRPCContext` with the panel's own dependencies, so a page calling a procedure is subject
 * to the same session resolution and the same `authedProcedure` gate an HTTP request is. A caller
 * built from a hand-rolled context object would be a back door that looked like a shortcut.
 */

const createTRPCContext = vi.fn((options: unknown) => Promise.resolve({ context: options }))
const createCaller = vi.fn((ctx: unknown) => ({ ctx }))
const headers = vi.fn(() => Promise.resolve(new Headers({ 'x-test': 'yes' })))
const getAuthDatabase = vi.fn(() => ({ handle: 'database' }))

vi.mock('@bluetel-ai/sisyphus-api/server', () => ({ createCaller, createTRPCContext }))
vi.mock('next/headers', () => ({ headers }))
vi.mock('@sisyphus-admin/lib/auth', () => ({ auth: vi.fn(), getAuthDatabase }))

const { createServerCaller } = await import('./caller')

describe('createServerCaller', () => {
  it('reads no request store and opens no pool until it is called', () => {
    expect(headers).not.toHaveBeenCalled()
    expect(getAuthDatabase).not.toHaveBeenCalled()
  })

  it('hands createCaller a factory rather than a context, so both stay per-request', () => {
    createServerCaller()

    expect(createCaller).toHaveBeenCalledTimes(1)
    expect(typeof createCaller.mock.calls[0]?.[0]).toBe('function')
    expect(headers).not.toHaveBeenCalled()
  })

  it('builds the context through createTRPCContext with the panel’s own dependencies', async () => {
    createServerCaller()

    const factory = createCaller.mock.calls.at(-1)?.[0] as () => Promise<unknown>
    await factory()

    const options = createTRPCContext.mock.calls.at(-1)?.[0] as {
      headers: Headers
      dependencies: { db: unknown; resolveSession: unknown; resolveMachineCredential: unknown }
    }

    expect(options.headers.get('x-test')).toBe('yes')
    expect(options.dependencies.db).toStrictEqual({ handle: 'database' })
    expect(typeof options.dependencies.resolveSession).toBe('function')
    expect(typeof options.dependencies.resolveMachineCredential).toBe('function')
  })

  it('resolves no machine credential — a page is never an executor', async () => {
    const { resolveNoMachineCredential } = await import('./machine-credential')

    createServerCaller()
    await (createCaller.mock.calls.at(-1)?.[0] as () => Promise<unknown>)()

    const options = createTRPCContext.mock.calls.at(-1)?.[0] as {
      dependencies: { resolveMachineCredential: unknown }
    }

    expect(options.dependencies.resolveMachineCredential).toBe(resolveNoMachineCredential)
  })
})
