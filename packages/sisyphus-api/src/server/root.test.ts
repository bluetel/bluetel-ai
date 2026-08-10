import { describe, expect, it } from 'vitest'

import type { SisyphusDatabase } from '../db'

import type { SisyphusContext } from './context'
import { appRouter, createCaller, createMachineCaller, machineRouter } from './root'
import { createUnauthenticatedScopeResolver } from './scope'

const unusedDatabase = {} as SisyphusDatabase

const anonymousContext = (): SisyphusContext => ({
  headers: new Headers(),
  dependencies: {
    db: unusedDatabase,
    resolveSession: () => Promise.resolve(null),
    resolveMachineCredential: () => Promise.resolve(null),
    recordDenial: () => Promise.resolve(),
  },
  db: unusedDatabase,
  session: null,
  scope: createUnauthenticatedScopeResolver(),
  machineCredential: () => Promise.resolve(null),
  validationCredential: () => Promise.resolve(null),
})

const procedurePaths = (router: { _def: { procedures: Record<string, unknown> } }): string[] =>
  Object.keys(router._def.procedures).sort()

describe('appRouter', () => {
  it('mounts the health check', () => {
    expect(procedurePaths(appRouter)).toContain('health.check')
  })

  it('is callable in-process, which is how the control plane reaches it (R4)', async () => {
    const caller = createCaller(anonymousContext())

    await expect(caller.health.check()).resolves.toMatchObject({ status: 'ok' })
  })

  it('runs the real resolvers rather than a privileged back door', async () => {
    // The in-process caller is handed an ordinary context and goes through the same middleware
    // chain the panel does, so a job that reads workflows is subject to the same FR-190 rules.
    const context = anonymousContext()
    const caller = createCaller(context)

    await expect(caller.health.check()).resolves.toBeDefined()
    await expect(context.scope.resolve()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })
})

describe('machineRouter', () => {
  it('is a separate router, so no interactive procedure is reachable from the machine mount', () => {
    const interactivePaths = procedurePaths(appRouter)

    for (const path of procedurePaths(machineRouter)) {
      expect(interactivePaths).not.toContain(path)
    }
  })

  it('has its own in-process caller', () => {
    expect(typeof createMachineCaller).toBe('function')
    expect(() => createMachineCaller(anonymousContext())).not.toThrow()
  })
})
