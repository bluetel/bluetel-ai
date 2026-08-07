import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { createTRPCSetup } from './trpc'

/**
 * These go through `fetchRequestHandler` rather than an in-process caller on purpose: the
 * transformer and the error formatter only apply on the way out over the wire, so an in-process
 * caller would assert nothing about either.
 */

interface TestDependencies {
  readonly resolveActor: () => Promise<string>
}

const buildSetup = (dependencies: TestDependencies) => {
  const setup = createTRPCSetup<{ actor: string }, TestDependencies>({
    createAdditionalContext: async (options) => ({
      actor: await options.dependencies.resolveActor(),
    }),
  })

  const router = setup.createTRPCRouter({
    whoAmI: setup.publicProcedure.query(({ ctx }) => ({
      actor: ctx.actor,
      observedAt: new Date(0),
    })),
    greet: setup.publicProcedure
      .input(z.object({ name: z.string().min(3), age: z.number().int() }))
      .query(({ input }) => `hello ${input.name}`),
  })

  const call = async (path: string, input?: unknown): Promise<Response> =>
    fetchRequestHandler({
      endpoint: '/api/trpc',
      router,
      req: new Request(
        input === undefined
          ? `http://sisyphus.test/api/trpc/${path}`
          : `http://sisyphus.test/api/trpc/${path}?input=${encodeURIComponent(
              JSON.stringify({ json: input }),
            )}`,
      ),
      createContext: () => setup.createTRPCContext({ headers: new Headers(), dependencies }),
    })

  return { setup, call }
}

describe('createTRPCSetup', () => {
  it('awaits the additional-context hook before any resolver runs', async () => {
    const resolveActor = vi.fn(() => Promise.resolve('resolved-asynchronously'))
    const { call } = buildSetup({ resolveActor })

    const response = await call('whoAmI')
    const body = (await response.json()) as { result: { data: { json: { actor: string } } } }

    expect(response.status).toBe(200)
    expect(body.result.data.json.actor).toBe('resolved-asynchronously')
    expect(resolveActor).toHaveBeenCalledTimes(1)
  })

  it('serialises with superjson, so a Date arrives as a Date rather than a string', async () => {
    const { call } = buildSetup({ resolveActor: () => Promise.resolve('anyone') })

    const response = await call('whoAmI')
    const body = (await response.json()) as {
      result: { data: { meta?: { values?: Record<string, unknown> } } }
    }

    // superjson records the reconstruction instructions alongside the payload; a plain-JSON
    // transformer would emit the ISO string with no meta and the client would hand a resolver's
    // caller a string where the inferred type says Date.
    expect(body.result.data.meta?.values).toMatchObject({ observedAt: ['Date'] })
  })

  it('flattens a ZodError into data.zodError so the panel can render it per field', async () => {
    const { call } = buildSetup({ resolveActor: () => Promise.resolve('anyone') })

    const response = await call('greet', { name: 'ab', age: 1.5 })
    const body = (await response.json()) as {
      error: {
        json: {
          code: number
          data: {
            code: string
            zodError: { fieldErrors: Record<string, string[] | undefined> } | null
          }
        }
      }
    }

    expect(response.status).toBe(400)
    expect(body.error.json.data.code).toBe('BAD_REQUEST')
    expect(Object.keys(body.error.json.data.zodError?.fieldErrors ?? {})).toStrictEqual([
      'name',
      'age',
    ])
  })

  it('leaves data.zodError null for a failure that is not a validation failure', async () => {
    const { call } = buildSetup({
      resolveActor: () => Promise.reject(new Error('session store unreachable')),
    })

    const response = await call('whoAmI')
    const body = (await response.json()) as {
      error: { json: { data: { zodError: unknown } } }
    }

    expect(body.error.json.data.zodError).toBeNull()
  })

  it('exposes the four things routers and route handlers need', () => {
    const { setup } = buildSetup({ resolveActor: () => Promise.resolve('anyone') })

    expect(typeof setup.createTRPCContext).toBe('function')
    expect(typeof setup.createCallerFactory).toBe('function')
    expect(typeof setup.createTRPCRouter).toBe('function')
    expect(typeof setup.publicProcedure.query).toBe('function')
  })

  it('keeps headers and dependencies on the context alongside the resolved values', async () => {
    const dependencies = { resolveActor: () => Promise.resolve('actor') }
    const setup = createTRPCSetup<{ actor: string }, typeof dependencies>({
      createAdditionalContext: async (options) => ({
        actor: await options.dependencies.resolveActor(),
      }),
    })

    const headers = new Headers({ 'x-request-id': 'abc' })
    const context = await setup.createTRPCContext({ headers, dependencies })

    expect(context.headers.get('x-request-id')).toBe('abc')
    expect(context.dependencies).toBe(dependencies)
    expect(context.actor).toBe('actor')
  })
})
