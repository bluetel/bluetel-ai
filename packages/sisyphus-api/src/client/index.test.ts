import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, expectTypeOf, it } from 'vitest'

import type { RouterInputs, RouterOutputs } from './index'
import * as client from './index'
import { SISYPHUS_MACHINE_ENDPOINT, SISYPHUS_TRPC_ENDPOINT } from './index'

describe('SISYPHUS_TRPC_ENDPOINT', () => {
  it('is the interactive surface path documented in api-surface.md', () => {
    expect(SISYPHUS_TRPC_ENDPOINT).toBe('/api/trpc')
  })

  it('is root-relative, so it resolves against whichever origin serves the panel', () => {
    expect(SISYPHUS_TRPC_ENDPOINT.startsWith('/')).toBe(true)
    expect(SISYPHUS_TRPC_ENDPOINT.endsWith('/')).toBe(false)
  })
})

describe('SISYPHUS_MACHINE_ENDPOINT', () => {
  it('is a different path from the interactive surface (FR-005)', () => {
    expect(SISYPHUS_MACHINE_ENDPOINT).toBe('/api/machine')
    expect(SISYPHUS_MACHINE_ENDPOINT).not.toBe(SISYPHUS_TRPC_ENDPOINT)
  })
})

describe('the client barrel', () => {
  it('carries the schemas and the enums, so a panel form needs no second import', () => {
    expect(client).toHaveProperty('startWorkflowInput')
    expect(client).toHaveProperty('listWorkflowsInput')
    expect(client).toHaveProperty('CLAUDE_MODELS')
    expect(client).toHaveProperty('WORKFLOW_STATES')
    expect(client).toHaveProperty('USER_ROLES')
  })

  it('carries no runtime value from the server — the router crosses as a type only', async () => {
    // This is the whole FR-005 boundary. `appRouter` reaching this barrel as a *value* would put
    // `postgres`, Drizzle and every resolver one import away from a panel client component, and
    // would defeat the exports map that deliberately omits a root barrel.
    expect(client).not.toHaveProperty('appRouter')
    expect(client).not.toHaveProperty('machineRouter')
    expect(client).not.toHaveProperty('createCaller')
    expect(client).not.toHaveProperty('createTRPCContext')
    expect(client).not.toHaveProperty('scopedProcedure')

    const source = await readFile(path.join(import.meta.dirname, 'index.ts'), 'utf8')
    const serverImports = [...source.matchAll(/^import (?<kind>type )?.*'\.\.\/server[^']*'/gmu)]

    expect(serverImports).toHaveLength(1)
    expect(serverImports[0]?.groups?.kind).toBe('type ')
  })

  it('uses local imports with no file extension', async () => {
    const source = await readFile(path.join(import.meta.dirname, 'index.ts'), 'utf8')

    expect(source).not.toContain(".js'")
  })
})

describe('RouterInputs and RouterOutputs', () => {
  it('infer from the router rather than restating it', () => {
    // The sanctioned way to type anything API-derived. A hand-written DTO mirroring a procedure
    // drifts silently, because nothing fails when the procedure changes and the copy does not.
    expectTypeOf<RouterOutputs['health']['check']>().toEqualTypeOf<{
      status: 'ok'
      checkedAt: Date
    }>()
  })

  it('exposes one entry per mounted sub-router, so a new one is inferrable the moment it lands', () => {
    expectTypeOf<keyof RouterInputs>().toEqualTypeOf<'health' | 'admin' | 'workflow'>()
    expectTypeOf<keyof RouterOutputs>().toEqualTypeOf<'health' | 'admin' | 'workflow'>()
  })

  it('infers admin inputs without a hand-written mirror of the procedure', () => {
    // The same point as above, on a sub-router that actually takes input: `setRole` gets its shape
    // from the resolver's `.input()` schema, so changing the schema changes this type.
    expectTypeOf<RouterInputs['admin']['users']['setRole']>().toExtend<{ userId: string }>()
  })
})
