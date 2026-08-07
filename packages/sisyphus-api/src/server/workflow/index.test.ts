import { describe, expect, it } from 'vitest'

import * as barrel from './index'

/**
 * The barrel is the directory's public surface, so what it does — and does not — export is a
 * contract in its own right (FR-004).
 */
describe('the workflow barrel', () => {
  it('exports the router root.ts mounts', () => {
    expect(typeof barrel.workflowRouter).toBe('object')
  })

  it('exports every scoped read, so nothing has to reach into queries.ts', () => {
    for (const name of [
      'listWorkflows',
      'readWorkflowDetail',
      'readTimeline',
      'readLogSegments',
      'readArtifacts',
      'summariseSpend',
      'countVisibleWorkflows',
    ] as const) {
      expect(typeof barrel[name]).toBe('function')
    }
  })

  it('exports the launch-configuration read, so SC-021 has one route (T188)', () => {
    for (const name of [
      'readLaunchConfiguration',
      'loadLaunchConfiguration',
      'reconstructLaunchConfiguration',
    ] as const) {
      expect(typeof barrel[name]).toBe('function')
    }
  })

  it('exports the launch path', () => {
    expect(typeof barrel.startWorkflow).toBe('function')
    expect(typeof barrel.resolveLaunchPlan).toBe('function')
    expect(typeof barrel.mayLaunchOnProfile).toBe('function')
  })

  it('exports the successor pair the router mounts', () => {
    expect(typeof barrel.continueWithChanges).toBe('function')
    expect(typeof barrel.readSuccessorChain).toBe('function')
    expect(barrel.continueWithChangesProcedure._def.type).toBe('mutation')
    expect(barrel.chainProcedure._def.type).toBe('query')
  })

  it('exports the branch guard, which is a guard and not a procedure (FR-120)', () => {
    for (const name of [
      'withBranchLocks',
      'branchLockKey',
      'branchLockPairs',
      'acquireBranchLocks',
      'findBranchHolders',
      'branchHeldError',
    ] as const) {
      expect(typeof barrel[name]).toBe('function')
    }

    expect(barrel.BRANCH_LOCK_NAMESPACE).toBe('sisyphus:workflow-branch')
    // Nothing mounts it: it wraps the launch path rather than answering a call.
    expect(Object.keys(barrel.workflowRouter._def.procedures)).not.toContain('withBranchLocks')
  })

  it('exports the override rules', () => {
    expect(typeof barrel.assertOverridesPermitted).toBe('function')
    expect(typeof barrel.readProfileOverridesInScope).toBe('function')
  })

  it('does not export the fixture seeder', () => {
    // `test-support.ts` is test support. Exporting it would put a seeder one import away from
    // application code, exactly as `admin/test-database.ts` is kept out of `admin/index.ts`.
    expect(Object.keys(barrel)).not.toContain('createTwoProfileFixture')
    expect(Object.keys(barrel)).not.toContain('readTestDatabaseUrl')
  })
})
