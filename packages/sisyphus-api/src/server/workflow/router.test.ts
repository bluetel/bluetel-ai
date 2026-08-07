import { describe, expect, it, vi } from 'vitest'

import type { SisyphusDatabase } from '../../db'
import type { SisyphusContext } from '../context'
import { createCallerFactory } from '../procedures'

import { workflowRouter } from './router'

/**
 * The `workflow` router's shape and its authorisation floor.
 *
 * What the resolvers *return* is settled against a real Postgres in `queries.test.ts` and
 * `start.test.ts`. What is settled here is the thing those suites cannot see, because they supply
 * a scope by construction: that **no** procedure on this router is reachable without a session.
 * A procedure accidentally built on `publicProcedure` would answer every one of those live tests
 * exactly the same way and would be a complete disclosure of every workflow in the platform.
 */

const WORKFLOW_ID = '88888888-8888-7888-8888-888888888888'
const PROFILE_ID = '99999999-9999-7999-8999-999999999999'

/** A database handle that fails loudly: nothing here should reach a query. */
const unreachableDatabase = new Proxy(
  {},
  {
    get: () => {
      throw new Error('an unauthenticated request must be refused before it reaches the database')
    },
  },
) as SisyphusDatabase

const signedOutCaller = () => {
  const context: SisyphusContext = {
    headers: new Headers(),
    dependencies: {
      db: unreachableDatabase,
      resolveSession: () => Promise.resolve(null),
      resolveMachineCredential: () => Promise.resolve(null),
      recordDenial: () => Promise.resolve(),
    },
    db: unreachableDatabase,
    session: null,
    scope: {
      resolve: () => Promise.reject(new Error('the scope must not be resolved without a session')),
    },
    machineCredential: () => Promise.resolve(null),
  }

  return createCallerFactory(workflowRouter)(context)
}

describe('workflowRouter', () => {
  it('exposes exactly the procedures the contract names', () => {
    // `spendSummary` is here as well as the six T064 names: api-surface.md puts it on this router,
    // and the leak contract has to be able to call it as a mounted procedure rather than as a
    // helper nothing exercises.
    expect(Object.keys(workflowRouter._def.procedures).sort()).toStrictEqual([
      'adHocWorkspaces',
      'artifacts',
      'byId',
      // T101/T102: the successor pair. `chain` is the only read on this router that answers about
      // more than one run, and it is scoped at every hop rather than once at the entry (FR-152).
      'chain',
      'continueWithChanges',
      'correct',
      'corrections',
      // T127: scoped, so an out-of-scope run refuses rather than answering with an empty history.
      'iterations',
      'list',
      'logSegments',
      // US11's four: `watch`/`unwatch` are scoped so neither can confirm an out-of-scope run
      // exists; the two preference procedures name no workflow, so they are `authedProcedure`.
      'notificationPreferences',
      // FR-140's half of the settings screen: the caller's own Slack identity, returned alongside
      // their preferences because the screen shows both. `admin.users.list` is the only other read
      // carrying `slack_user_id` and it is admin-only. No input, so it cannot name anybody else.
      'notificationSettings',
      'pause',
      'reassignOwner',
      'resume',
      'setNotificationPreference',
      // T119/T120: `skillReferences` explains a finished run, and `spendAttribution` is the
      // FR-156 view of the same aggregate `spendSummary` produces — one row for a non-admin
      // asking a per-individual grouping, every row for an admin.
      'skillReferences',
      'spendAttribution',
      'spendSummary',
      'start',
      'startAdHoc',
      'stop',
      'timeline',
      'unwatch',
      'watch',
    ])
  })

  describe('without a session', () => {
    const calls: readonly { readonly name: string; readonly run: () => Promise<unknown> }[] = [
      { name: 'list', run: () => signedOutCaller().list({ limit: 10 }) },
      { name: 'byId', run: () => signedOutCaller().byId({ workflowId: WORKFLOW_ID }) },
      { name: 'timeline', run: () => signedOutCaller().timeline({ workflowId: WORKFLOW_ID }) },
      {
        name: 'logSegments',
        run: () => signedOutCaller().logSegments({ workflowId: WORKFLOW_ID, fromSequence: 0 }),
      },
      { name: 'artifacts', run: () => signedOutCaller().artifacts({ workflowId: WORKFLOW_ID }) },
      { name: 'iterations', run: () => signedOutCaller().iterations({ workflowId: WORKFLOW_ID }) },
      { name: 'spendSummary', run: () => signedOutCaller().spendSummary({ groupBy: 'profile' }) },
      {
        name: 'spendAttribution',
        run: () => signedOutCaller().spendAttribution({ groupBy: 'user' }),
      },
      {
        name: 'skillReferences',
        run: () => signedOutCaller().skillReferences({ workflowId: WORKFLOW_ID }),
      },
      {
        name: 'start',
        run: () =>
          signedOutCaller().start({ executionProfileId: PROFILE_ID, prompt: 'Do the thing.' }),
      },
      { name: 'adHocWorkspaces', run: () => signedOutCaller().adHocWorkspaces() },
      { name: 'chain', run: () => signedOutCaller().chain({ workflowId: WORKFLOW_ID }) },
      {
        name: 'continueWithChanges',
        run: () => signedOutCaller().continueWithChanges({ workflowId: WORKFLOW_ID, turnCap: 50 }),
      },
      {
        name: 'startAdHoc',
        run: () =>
          signedOutCaller().startAdHoc({
            setupBundleVersionId: PROFILE_ID,
            workflowType: 'delegated',
            model: 'claude-opus-5',
            instanceType: 'm7i.large',
            purchaseMode: 'spot',
            prompt: 'Do the thing.',
            workspace: { source: 'workspace', workspaceVersionId: WORKFLOW_ID },
          }),
      },
    ]

    for (const call of calls) {
      it(`${call.name} is UNAUTHORIZED and never reaches the database`, async () => {
        await expect(call.run()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      })
    }

    it('says nothing about any workflow in the refusal (FR-011)', async () => {
      let message = ''
      try {
        await signedOutCaller().byId({ workflowId: WORKFLOW_ID })
      } catch (caught) {
        message = (caught as { message: string }).message
      }

      expect(message).toBe('Not signed in.')
      expect(message).not.toContain(WORKFLOW_ID)
    })
  })

  it('imports nothing that could reach the control plane', async () => {
    // The guard `start.test.ts` places on the resolver, placed again on the module graph: loading
    // the router must not so much as construct an HTTP client.
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await import('./router')

    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
