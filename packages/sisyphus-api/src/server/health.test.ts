import { describe, expect, it } from 'vitest'

import type { SisyphusDatabase } from '../db'

import type { SisyphusContext } from './context'
import { healthRouter } from './health'
import { createCallerFactory } from './procedures'

/**
 * The health check runs with a context that throws on any database access and a scope resolver
 * that throws if resolved. Anything the check touches therefore fails the test rather than
 * quietly adding a query to a path polled every few seconds (FR-190).
 */
const hostileContext = (): SisyphusContext => {
  const db = new Proxy(
    {},
    {
      get: () => {
        throw new Error('the health check must not touch the database')
      },
    },
  ) as SisyphusDatabase

  return {
    headers: new Headers(),
    dependencies: {
      db,
      resolveSession: () => Promise.resolve(null),
      resolveMachineCredential: () => Promise.resolve(null),
      recordDenial: () => Promise.resolve(),
    },
    db,
    session: null,
    scope: {
      resolve: () => Promise.reject(new Error('the health check must not resolve the scope')),
    },
    machineCredential: () =>
      Promise.reject(new Error('the health check must not verify a credential')),
    validationCredential: () =>
      Promise.reject(new Error('the health check must not verify a credential')),
  }
}

describe('healthRouter', () => {
  it('answers without a session', async () => {
    const caller = createCallerFactory(healthRouter)(hostileContext())

    await expect(caller.check()).resolves.toMatchObject({ status: 'ok' })
  })

  it('costs no grants query and no credential verification', async () => {
    const caller = createCallerFactory(healthRouter)(hostileContext())
    const result = await caller.check()

    expect(result.status).toBe('ok')
  })

  it('reports a Date, which is what the superjson transformer has to preserve', async () => {
    const caller = createCallerFactory(healthRouter)(hostileContext())
    const result = await caller.check()

    expect(result.checkedAt).toBeInstanceOf(Date)
  })
})
