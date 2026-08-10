import { afterEach, describe, expect, it } from 'vitest'

import * as serverBarrel from './index'
import { assertServerOnly } from './index'

const realm = globalThis as { window?: unknown }

afterEach(() => {
  Reflect.deleteProperty(realm, 'window')
})

describe('assertServerOnly', () => {
  it('passes in a Node realm, where there is no window', () => {
    expect(() => {
      assertServerOnly('sisyphus-api/server')
    }).not.toThrow()
  })

  it('throws, naming the module and the safe alternative, in a browser realm', () => {
    realm.window = {}

    expect(() => {
      assertServerOnly('sisyphus-api/server')
    }).toThrow(/sisyphus-api\/server is server-only/)
    expect(() => {
      assertServerOnly('sisyphus-api/server')
    }).toThrow(/@bluetel-ai\/sisyphus-api\/client/)
  })
})

describe('the server barrel', () => {
  it('is the only supported import path — consumers never reach into a module underneath it', () => {
    // Constitution gate II. Listed explicitly rather than snapshotted so that removing one from
    // the barrel is a deliberate edit to this list rather than an accepted snapshot diff.
    for (const name of [
      'appRouter',
      'machineRouter',
      'createCaller',
      'createMachineCaller',
      'createTRPCSetup',
      'createTRPCContext',
      'createTRPCRouter',
      'createCallerFactory',
      'publicProcedure',
      'authedProcedure',
      'adminProcedure',
      'scopedProcedure',
      'machineProcedure',
      'createSisyphusAdditionalContext',
      'createScopeResolver',
      'visibleWorkflowsFilter',
      'scopedWorkflowWhere',
      'requireWorkflowInScope',
      'workflowNotFoundError',
    ]) {
      expect(serverBarrel).toHaveProperty(name)
    }
  })

  it('exposes the six procedure types and no seventh', () => {
    // `validationProcedure` is the sixth (T200, FR-147): a sibling of `machineProcedure` rather than
    // a chain on top of it, because a bundle validation run has no workflow for one to be scoped to.
    // `reportValidationProcedure` is not a *type* — it is the one mounted procedure built on it, and
    // it is filtered out by name below rather than admitted to the list.
    const procedureExports = Object.keys(serverBarrel).filter(
      (name) => name.endsWith('Procedure') && !name.startsWith('report'),
    )

    expect(procedureExports.sort()).toStrictEqual([
      'adminProcedure',
      'authedProcedure',
      'machineProcedure',
      'publicProcedure',
      'scopedProcedure',
      'validationProcedure',
    ])
  })
})
