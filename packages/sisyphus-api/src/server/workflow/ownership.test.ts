import { TRPCError } from '@trpc/server'
import { and, desc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { SisyphusDatabase } from '../../db'
import { configurationAudit, integrations, users, workflows } from '../../db'
import { setUserActive } from '../admin/user-changes'

import {
  findActiveUserByEmail,
  findIntegrationDefaultOwner,
  integrationOwnerlessError,
  isOwnableUser,
  OWNER_REASSIGNED_ACTION,
  reassignWorkflowOwner,
  resolveWorkflowOwner,
  unattributableWorkflowError,
  WORKFLOW_AUDIT_ENTITY_TYPE,
} from './ownership'
import type { TwoProfileFixture, TwoProfileIds } from './test-support'
import { createTwoProfileFixture, readTestDatabaseUrl, refusalOf } from './test-support'

/**
 * **Exactly one human owner (T083).** FR-132, FR-133 and FR-134 against a live database.
 *
 * Three things are proved here that a unit test with a stubbed reader could not:
 *
 * 1. the fallback order really is initiator → ticket assignee → integration default, including the
 *    case where the assignee resolves to somebody who is not an active platform user;
 * 2. an integration whose default owner is missing or deactivated **refuses** the launch rather
 *    than starting an unowned run (FR-133, SC-035);
 * 3. reassignment and `admin.users.setActive` agree. That one has to be live: it asserts against
 *    the flag `../admin/user-changes.ts` writes, through the real function, rather than against
 *    this file's belief about what that function does.
 *
 * Skipped — not failed — when `SISYPHUS_TEST_DATABASE_URL` is absent, so a plain `vitest run` on a
 * machine with no Postgres stays green.
 */

const connectionString = readTestDatabaseUrl()

describe.skipIf(connectionString === undefined)(
  'workflow ownership (FR-132, FR-133, FR-134)',
  () => {
    let fixture: TwoProfileFixture
    let db: SisyphusDatabase
    let ids: TwoProfileIds

    beforeAll(async () => {
      fixture = createTwoProfileFixture(connectionString ?? '')
      await fixture.open()
      db = fixture.db()
      ids = fixture.ids()
    }, 60_000)

    afterAll(async () => {
      await fixture.close()
    }, 30_000)

    const emailOf = async (userId: string): Promise<string> => {
      const rows = await db.select({ email: users.email }).from(users).where(eq(users.id, userId))
      return rows[0]?.email ?? ''
    }

    const ownerOf = async (workflowId: string): Promise<string | undefined> => {
      const rows = await db
        .select({ ownerUserId: workflows.ownerUserId })
        .from(workflows)
        .where(eq(workflows.id, workflowId))
      return rows[0]?.ownerUserId
    }

    const needsReassignment = async (workflowId: string): Promise<boolean | undefined> => {
      const rows = await db
        .select({ flag: workflows.needsReassignment })
        .from(workflows)
        .where(eq(workflows.id, workflowId))
      return rows[0]?.flag
    }

    describe('resolveWorkflowOwner', () => {
      it('gives a manual launch to the person who started it (FR-132)', async () => {
        await expect(
          resolveWorkflowOwner(db, { initiatedByUserId: ids.alice }),
        ).resolves.toStrictEqual({ ownerUserId: ids.alice, source: 'initiator' })
      })

      it('prefers the initiator over anything an integration would have said', async () => {
        // Both named. A manual launch is a manual launch: FR-132 gives it to the initiator, and the
        // integration default is the fallback for runs nobody pressed a button for.
        await expect(
          resolveWorkflowOwner(db, {
            initiatedByUserId: ids.alice,
            integrationId: ids.b.integrationId,
            ticketAssigneeEmail: await emailOf(ids.bob),
          }),
        ).resolves.toStrictEqual({ ownerUserId: ids.alice, source: 'initiator' })
      })

      it('gives an integration run to the resolved ticket assignee (FR-132)', async () => {
        // Integration A's declared default owner is alice; the ticket names bob. The assignee wins.
        await expect(
          resolveWorkflowOwner(db, {
            integrationId: ids.a.integrationId,
            ticketAssigneeEmail: await emailOf(ids.bob),
          }),
        ).resolves.toStrictEqual({ ownerUserId: ids.bob, source: 'ticket_assignee' })
      })

      it('matches the assignee address case-insensitively', async () => {
        const shouted = (await emailOf(ids.bob)).toUpperCase()

        await expect(
          resolveWorkflowOwner(db, {
            integrationId: ids.a.integrationId,
            ticketAssigneeEmail: shouted,
          }),
        ).resolves.toStrictEqual({ ownerUserId: ids.bob, source: 'ticket_assignee' })
      })

      it('falls back to the integration default when the board names nobody (FR-132)', async () => {
        await expect(
          resolveWorkflowOwner(db, { integrationId: ids.a.integrationId }),
        ).resolves.toStrictEqual({ ownerUserId: ids.alice, source: 'integration_default' })
      })

      it('falls back when the assignee is not a platform user at all', async () => {
        await expect(
          resolveWorkflowOwner(db, {
            integrationId: ids.a.integrationId,
            ticketAssigneeEmail: 'someone.who.never.signed.in@sisyphus.test',
          }),
        ).resolves.toStrictEqual({ ownerUserId: ids.alice, source: 'integration_default' })
      })

      it('refuses when nothing at all was named', async () => {
        const refusal = await refusalOf(async () => resolveWorkflowOwner(db, {}))

        expect(refusal).toBeInstanceOf(TRPCError)
        expect(refusal.code).toBe(unattributableWorkflowError().code)
      })
    })

    /**
     * FR-133's teeth. An integration with no usable default owner cannot start a run — because the
     * alternative is a row `workflows.owner_user_id` could not hold anyway, and because an unowned
     * autonomous run is unrepairable after the fact.
     */
    describe('an integration with no usable default owner (FR-133)', () => {
      it('refuses the launch when the column is null', async () => {
        await db
          .update(integrations)
          .set({ defaultOwnerUserId: null })
          .where(eq(integrations.id, ids.b.integrationId))

        const refusal = await refusalOf(async () =>
          resolveWorkflowOwner(db, { integrationId: ids.b.integrationId }),
        )

        expect(refusal.code).toBe(integrationOwnerlessError().code)
        expect(refusal.message).toBe(integrationOwnerlessError().message)

        await db
          .update(integrations)
          .set({ defaultOwnerUserId: ids.bob })
          .where(eq(integrations.id, ids.b.integrationId))
      })

      it('refuses when the declared default owner has been deactivated', async () => {
        await db.update(users).set({ isActive: false }).where(eq(users.id, ids.bob))

        await expect(findIntegrationDefaultOwner(db, ids.b.integrationId)).resolves.toBeUndefined()

        const refusal = await refusalOf(async () =>
          resolveWorkflowOwner(db, { integrationId: ids.b.integrationId }),
        )
        expect(refusal.code).toBe(integrationOwnerlessError().code)

        await db.update(users).set({ isActive: true }).where(eq(users.id, ids.bob))
      })

      it('does not resolve a deactivated assignee either', async () => {
        await db.update(users).set({ isActive: false }).where(eq(users.id, ids.bob))

        await expect(findActiveUserByEmail(db, await emailOf(ids.bob))).resolves.toBeUndefined()
        await expect(isOwnableUser(db, ids.bob)).resolves.toBe(false)

        // Falls through to integration A's default rather than handing the run to a withdrawn
        // account — which would create the FR-176 state on the day the run was created.
        await expect(
          resolveWorkflowOwner(db, {
            integrationId: ids.a.integrationId,
            ticketAssigneeEmail: await emailOf(ids.bob),
          }),
        ).resolves.toStrictEqual({ ownerUserId: ids.alice, source: 'integration_default' })

        await db.update(users).set({ isActive: true }).where(eq(users.id, ids.bob))
      })
    })

    describe('reassignWorkflowOwner (FR-134)', () => {
      it('moves the run and records who did it and when', async () => {
        const before = new Date(Date.now() - 1_000)

        const result = await reassignWorkflowOwner(db, {
          workflowId: ids.a.workflowId,
          ownerUserId: ids.bob,
          actorUserId: ids.admin,
        })

        expect(result.changed).toBe(true)
        expect(result.previousOwnerUserId).toBe(ids.alice)
        expect(result.workflow.ownerUserId).toBe(ids.bob)
        await expect(ownerOf(ids.a.workflowId)).resolves.toBe(ids.bob)

        const trail = await db
          .select()
          .from(configurationAudit)
          .where(
            and(
              eq(configurationAudit.entityType, WORKFLOW_AUDIT_ENTITY_TYPE),
              eq(configurationAudit.entityId, ids.a.workflowId),
            ),
          )
          .orderBy(desc(configurationAudit.createdAt))
          .limit(1)

        expect(trail[0]?.action).toBe(OWNER_REASSIGNED_ACTION)
        expect(trail[0]?.actorUserId).toBe(ids.admin)
        expect(trail[0]?.detail).toStrictEqual({ from: ids.alice, to: ids.bob })
        expect(trail[0]?.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime())

        // Put it back, so the ordering of the cases below is data rather than history.
        await reassignWorkflowOwner(db, {
          workflowId: ids.a.workflowId,
          ownerUserId: ids.alice,
          actorUserId: ids.admin,
        })
      })

      it('is not an event when the run already has that owner', async () => {
        const result = await reassignWorkflowOwner(db, {
          workflowId: ids.a.workflowId,
          ownerUserId: ids.alice,
          actorUserId: ids.admin,
        })

        expect(result.changed).toBe(false)
        expect(result.workflow.ownerUserId).toBe(ids.alice)

        const trail = await db
          .select({ id: configurationAudit.id })
          .from(configurationAudit)
          .where(
            and(
              eq(configurationAudit.entityType, WORKFLOW_AUDIT_ENTITY_TYPE),
              eq(configurationAudit.entityId, ids.a.workflowId),
            ),
          )

        // Two from the case above — the move and the move back — and nothing from this no-op.
        expect(trail).toHaveLength(2)
      })

      it('refuses a deactivated nominee, so a reassignment cannot re-enter FR-176', async () => {
        await db.update(users).set({ isActive: false }).where(eq(users.id, ids.bob))

        const refusal = await refusalOf(async () =>
          reassignWorkflowOwner(db, {
            workflowId: ids.a.workflowId,
            ownerUserId: ids.bob,
            actorUserId: ids.admin,
          }),
        )

        expect(refusal.code).toBe('BAD_REQUEST')
        await expect(ownerOf(ids.a.workflowId)).resolves.toBe(ids.alice)

        await db.update(users).set({ isActive: true }).where(eq(users.id, ids.bob))
      })

      it('reports an unknown workflow as absent, disclosing nothing', async () => {
        const refusal = await refusalOf(async () =>
          reassignWorkflowOwner(db, {
            workflowId: '00000000-0000-7000-8000-000000000000',
            ownerUserId: ids.alice,
            actorUserId: ids.admin,
          }),
        )

        expect(refusal.code).toBe('NOT_FOUND')
      })
    })

    /**
     * **The two halves agreeing (FR-176).**
     *
     * `admin.users.setActive(false)` raises `needs_reassignment` on the deactivated owner's
     * non-terminal runs. This asserts that a reassignment lowers it again, and — the part that is
     * easy to get wrong — that reactivating the *old* owner afterwards does not quietly undo the
     * reassignment or re-raise the flag on a run that is no longer theirs.
     */
    describe('agreement with admin.users.setActive (FR-176)', () => {
      it('clears the flag deactivation raised, and reactivation does not resurrect it', async () => {
        // Workflow A is `running`, so it is in ACTIVE_WORKFLOW_STATES and gets flagged.
        const deactivated = await db.transaction(async (tx) =>
          setUserActive({ writer: tx, actorUserId: ids.admin, userId: ids.alice, isActive: false }),
        )

        expect(deactivated.changed).toBe(true)
        expect(deactivated.workflowsFlaggedForReassignment).toBeGreaterThanOrEqual(1)
        await expect(needsReassignment(ids.a.workflowId)).resolves.toBe(true)

        await reassignWorkflowOwner(db, {
          workflowId: ids.a.workflowId,
          ownerUserId: ids.bob,
          actorUserId: ids.admin,
        })

        await expect(needsReassignment(ids.a.workflowId)).resolves.toBe(false)

        const reactivated = await db.transaction(async (tx) =>
          setUserActive({ writer: tx, actorUserId: ids.admin, userId: ids.alice, isActive: true }),
        )

        // `clearReassignmentFlag` matches on `owner_user_id`, and this run no longer has alice on
        // it — so reactivating her touches nothing here and bob keeps the run.
        expect(reactivated.workflowsFlaggedForReassignment).toBe(0)
        await expect(ownerOf(ids.a.workflowId)).resolves.toBe(ids.bob)
        await expect(needsReassignment(ids.a.workflowId)).resolves.toBe(false)
      })
    })
  },
)
