import { inArray } from 'drizzle-orm'

import type { SisyphusDatabase } from '../../db'
import { corrections, supervisionCommands, workflowEvents } from '../../db'
import type { WorkflowState } from '../../enums'
import { createUserFixtures, readTestDatabaseUrl } from '../admin/test-database'
import type {
  AuthorisationDenial,
  MachineCredential,
  SisyphusContext,
  SisyphusSession,
} from '../context'
import type { MachineContext } from '../machine'
import type { ResolvedScope } from '../scope'
import { createScopeResolver, memoiseScope } from '../scope'

/**
 * **Test support for the supervision suites. Not production code.**
 *
 * It lives in `src/` because that is where the tests that import it live and where the type checker
 * and linter can see it, and it is deliberately **not** re-exported from `./index.ts` — exporting it
 * would put a fixture seeder one import away from application code, exactly as `test-support.ts` and
 * `admin/test-database.ts` are kept out of their barrels.
 *
 * ## Why not `test-support.ts`
 *
 * The two-profile fixture next door seeds the disjoint worlds FR-190 assertions need, and it wraps
 * `createUserFixtures` without re-exposing `backendsWaitingOnLocks`. T094's racing test needs exactly
 * that — a way to ask Postgres whether a backend is genuinely parked on a lock — because a
 * sequential test of a locking read passes just as happily with the lock deleted. So this builds on
 * the same database harness one level lower down, rather than adding a second one.
 *
 * ## Why cleanup is written here
 *
 * `createUserFixtures.removeAll` deletes workflows, and `corrections`, `supervision_commands` and
 * `workflow_events` all reference them. Left in place they turn `removeAll` into a foreign-key
 * violation whose message says nothing about supervision. {@link SupervisionFixture.clean} deletes
 * the children first and then delegates.
 */

export { readTestDatabaseUrl }

/** A user the fixture seeded. */
export interface FixtureUser {
  readonly id: string
  readonly email: string
}

export interface SupervisionFixture {
  readonly db: () => SisyphusDatabase
  /** Create and migrate a private scratch database. Call from `beforeAll` with a long timeout. */
  readonly open: () => Promise<void>
  /** Drop it. Call from `afterAll`. */
  readonly close: () => Promise<void>
  readonly seedUser: (label: string) => Promise<FixtureUser>
  readonly seedWorkflow: (options: {
    readonly ownerUserId: string
    readonly state: WorkflowState
  }) => Promise<string>
  /** The real resolver, not a hand-built scope object. */
  readonly scopeFor: (userId: string, isAdmin?: boolean) => Promise<ResolvedScope>
  /** A machine-surface context pinned to one workflow, as `machineProcedure` would build it. */
  readonly machineContextFor: (workflowId: string) => MachineContext
  /** An interactive context carrying one signed-in human, for a `scopedProcedure` caller. */
  readonly contextFor: (user: FixtureUser) => Promise<SisyphusContext>
  /** Delete the supervision rows, then everything the base fixture created. */
  readonly clean: () => Promise<void>
  /** Backends parked on a lock, for proving that a racing transaction really did wait. */
  readonly backendsWaitingOnLocks: () => Promise<number>
}

/** A promise plus its resolver, for holding a transaction open at a chosen moment. */
export const createGate = (): { readonly opened: Promise<void>; readonly open: () => void } => {
  let open = (): void => undefined
  const opened = new Promise<void>((resolve) => {
    open = () => {
      resolve()
    }
  })

  return { opened, open }
}

export const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

/**
 * Wait until Postgres reports a backend parked on a lock.
 *
 * Returns the count. A caller that does not assert it is greater than zero has written a test that
 * cannot tell "the loser waited on the lock" from "the loser happened to run second", and only the
 * first of those proves anything.
 *
 * @param fixture - The open fixture.
 * @param attempts - Polls of 25ms. The default is five seconds.
 */
export const waitForBlockedBackend = async (
  fixture: SupervisionFixture,
  attempts = 200,
): Promise<number> => {
  let blocked = 0

  for (let attempt = 0; attempt < attempts && blocked === 0; attempt += 1) {
    await sleep(25)
    blocked = await fixture.backendsWaitingOnLocks()
  }

  return blocked
}

/**
 * Build the fixture.
 *
 * @param connectionString - From {@link readTestDatabaseUrl}. The caller has already skipped when it
 *   is `undefined`, so this never has to decide what to do without one.
 */
export const createSupervisionFixture = (connectionString: string): SupervisionFixture => {
  const base = createUserFixtures(connectionString)
  const seededWorkflowIds: string[] = []
  const denials: AuthorisationDenial[] = []

  const fixture: SupervisionFixture = {
    db: base.db,
    open: base.open,
    close: base.close,
    backendsWaitingOnLocks: base.backendsWaitingOnLocks,

    seedUser: (label) => base.seedUser({ label }),

    seedWorkflow: async (options) => {
      const id = await base.seedWorkflow(options)
      seededWorkflowIds.push(id)

      return id
    },

    scopeFor: (userId, isAdmin = false) =>
      createScopeResolver({ db: base.db(), identity: { userId, isAdmin } }).resolve(),

    machineContextFor: (workflowId) => {
      const credential: MachineCredential = {
        credentialId: `fixture-credential-${workflowId}`,
        workflowId,
        jti: `fixture-jti-${workflowId}`,
        expiresAt: new Date(Date.now() + 60_000),
      }

      return {
        workflowId,
        credential,
        db: base.db(),
        dependencies: {
          db: base.db(),
          resolveSession: () => Promise.resolve(null),
          resolveMachineCredential: () => Promise.resolve(credential),
          recordDenial: (denial) => {
            denials.push(denial)

            return Promise.resolve()
          },
        },
      }
    },

    contextFor: async (user) => {
      const db = base.db()
      const session: SisyphusSession = {
        user: {
          id: user.id,
          email: user.email,
          displayName: user.email,
          role: 'engineer',
          isActive: true,
        },
        expiresAt: new Date(Date.now() + 60_000),
      }
      const scope = await createScopeResolver({
        db,
        identity: { userId: user.id, isAdmin: false },
      }).resolve()

      return {
        headers: new Headers(),
        dependencies: {
          db,
          resolveSession: () => Promise.resolve(session),
          resolveMachineCredential: () => Promise.resolve(null),
          recordDenial: (denial) => {
            denials.push(denial)

            return Promise.resolve()
          },
        },
        db,
        session,
        scope: memoiseScope(() => Promise.resolve(scope)),
        machineCredential: () => Promise.resolve(null),
      }
    },

    clean: async () => {
      const db = base.db()

      if (seededWorkflowIds.length > 0) {
        await db.delete(corrections).where(inArray(corrections.workflowId, seededWorkflowIds))
        await db
          .delete(supervisionCommands)
          .where(inArray(supervisionCommands.workflowId, seededWorkflowIds))
        await db.delete(workflowEvents).where(inArray(workflowEvents.workflowId, seededWorkflowIds))
        seededWorkflowIds.length = 0
      }

      await base.removeAll()
    },
  }

  return fixture
}
