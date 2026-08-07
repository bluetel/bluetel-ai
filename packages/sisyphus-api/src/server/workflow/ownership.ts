import { TRPCError } from '@trpc/server'
import { and, eq } from 'drizzle-orm'

import type { SisyphusDatabase, Workflow } from '../../db'
import { configurationAudit, integrations, users, workflows } from '../../db'
import type { ReassignOwnerInput } from '../../schemas'
import { reassignOwnerInput } from '../../schemas'
import { adminProcedure } from '../procedures'
import { workflowNotFoundError } from '../scope'

import { ownerNotAvailableError } from './start-ad-hoc'

/**
 * Ownership — **exactly one human is accountable for every run** (FR-132, FR-133, FR-134).
 *
 * `workflows.owner_user_id` is `not null`, so the question this module answers is never "does this
 * run have an owner" but "which single person is it". There are three sources and they are tried in
 * a fixed order, which is what makes the answer a function of the launch rather than of whoever
 * wrote the calling job:
 *
 * 1. **the initiating user**, for a manual launch (FR-132);
 * 2. **the resolved ticket assignee**, for an integration-started run where the board named one and
 *    that person is an active platform user (FR-132);
 * 3. **the integration's declared default owner** otherwise (FR-132, FR-133).
 *
 * The order runs out rather than falling through to a placeholder. An integration with no default
 * owner and no resolvable assignee is refused here (FR-133) — the alternative is an unowned
 * autonomous run, which is the exact state SC-035 says must never exist and which no later screen
 * can repair, because there is nobody to put on it.
 *
 * ## Ownership is not access
 *
 * A ticket assignee or an integration default owner may hold no grant on the profile the run
 * executes on, and that is deliberate (FR-191). Ownership confers the per-workflow rights of
 * FR-189 — see `../scope.ts`, whose base selector admits a workflow through `owner_user_id`
 * independently of any grant — and confers nothing profile-wide.
 *
 * ## The other half of reassignment
 *
 * `admin.users.setActive(false)` already flags every **non-terminal** run a deactivated user owns
 * with `needs_reassignment` (FR-176), and reactivating them clears the flag again; both live in
 * `../admin/user-changes.ts`. {@link reassignWorkflowOwner} is the half that resolves the flag by
 * actually moving the run, and the two agree on three points:
 *
 * - reassignment **clears** `needs_reassignment`, because the run now has an active accountable
 *   human and the flag records precisely that it does not;
 * - the new owner must be **active**, so a reassignment cannot re-enter the state it exists to
 *   leave — the same rule `resolveOwner` applies to an ad hoc launch, and the same refusal;
 * - reactivating the *old* owner afterwards does not un-reassign anything, because
 *   `clearReassignmentFlag` matches on `owner_user_id` and this run no longer has them on it.
 */

/** What ownership needs from a handle — satisfied by the pool or by an open transaction. */
export type OwnershipWriter = Pick<SisyphusDatabase, 'insert' | 'select' | 'update'>

/** The read-only half, for resolution during a launch that has not written anything yet. */
export type OwnershipReader = Pick<SisyphusDatabase, 'select'>

/**
 * The `configuration_audit.entity_type` a reassignment is filed under.
 *
 * `recordConfigurationChange` in `../admin/audit-log.ts` is the usual way into that table, but its
 * `AuditedEntityType` union covers configuration entities only and has no `workflow` member — a run
 * is not configuration. The column itself is plain `text`, so the row below is valid data rather
 * than a widening; what is missing is one word of vocabulary in that union, which belongs to the
 * admin surface rather than here. Written directly, in one named place, until it exists.
 */
export const WORKFLOW_AUDIT_ENTITY_TYPE = 'workflow'

/** The `configuration_audit.action` a reassignment is filed under (FR-134). */
export const OWNER_REASSIGNED_ACTION = 'owner_reassigned'

/** Where a resolved owner came from. Recorded so "why is this person accountable" has an answer. */
export type OwnerSource = 'initiator' | 'integration_default' | 'ticket_assignee'

/** One owner, and the rule that produced them. */
export interface ResolvedWorkflowOwner {
  readonly ownerUserId: string
  readonly source: OwnerSource
}

/** Everything {@link resolveWorkflowOwner} may consider. */
export interface OwnerResolutionRequest {
  /** The signed-in user, for a manual launch. Absent for an integration-started run. */
  readonly initiatedByUserId?: string | undefined
  /** The integration that started the run. Absent for a manual launch. */
  readonly integrationId?: string | undefined
  /**
   * The address the board reported for the ticket's assignee, if any.
   *
   * An address rather than an id because the connector has an external account, not a platform
   * user, and `users.email` is the join key the platform already resolves identity on (R13). An
   * assignee who is not a platform user, or is no longer active, simply does not resolve — the
   * run falls to the integration default rather than being refused.
   */
  readonly ticketAssigneeEmail?: string | undefined
}

/**
 * The first row, honestly typed.
 *
 * `noUncheckedIndexedAccess` is off in this project, so `rows[0]` is typed as present even when the
 * result set is empty — and a `=== undefined` guard against it is narrowed away as unreachable.
 * Going through a function whose *declared* return type admits `undefined` restores the check.
 */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/**
 * An integration-started run has nobody to be accountable for it (FR-133).
 *
 * FR-133 forbids enabling an integration without a default owner, so reaching this means the
 * integration was enabled before that rule was enforced or the owner's row was removed underneath
 * it. Refusing the launch is the only answer that keeps SC-035 true: an unowned autonomous run
 * cannot be repaired later, because there is nobody to ask about it.
 */
export const integrationOwnerlessError = (): TRPCError =>
  new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: 'This integration has no default owner, so it cannot start a run.',
  })

/** Neither a person nor an integration was named, so there is no rule to apply. */
export const unattributableWorkflowError = (): TRPCError =>
  new TRPCError({
    code: 'BAD_REQUEST',
    message: 'A run must be started by a user or by an integration.',
  })

/**
 * The active platform user for an address, or `undefined`.
 *
 * `users.email` is `citext`, so the comparison is case-insensitive at the database and a board
 * reporting `Ada.Lovelace@example.com` resolves the same person as `ada.lovelace@example.com`.
 * A deactivated match is treated as no match: handing a run to an account whose access was
 * withdrawn creates the `needs_reassignment` state on the day the run is created (FR-176).
 */
export const findActiveUserByEmail = async (
  reader: OwnershipReader,
  email: string,
): Promise<string | undefined> => {
  const trimmed = email.trim()
  if (trimmed === '') {
    return undefined
  }

  const row = firstRow(
    await reader
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, trimmed), eq(users.isActive, true)))
      .limit(1),
  )

  return row?.id
}

/** Whether a user exists and may be handed a run. */
export const isOwnableUser = async (reader: OwnershipReader, userId: string): Promise<boolean> => {
  const row = firstRow(
    await reader
      .select({ isActive: users.isActive })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  )

  return row?.isActive === true
}

/**
 * The integration's declared default owner, or `undefined` when it has none or theirs is inactive.
 *
 * An inactive default owner is reported as absent rather than returned, so the caller refuses the
 * launch (FR-133) instead of starting a run owned by an account that cannot act on it.
 */
export const findIntegrationDefaultOwner = async (
  reader: OwnershipReader,
  integrationId: string,
): Promise<string | undefined> => {
  const row = firstRow(
    await reader
      .select({ defaultOwnerUserId: integrations.defaultOwnerUserId, isActive: users.isActive })
      .from(integrations)
      .leftJoin(users, eq(users.id, integrations.defaultOwnerUserId))
      .where(eq(integrations.id, integrationId))
      .limit(1),
  )

  if (row?.defaultOwnerUserId == null || row.isActive !== true) {
    return undefined
  }

  return row.defaultOwnerUserId
}

/**
 * Decide the one human accountable for a run (FR-132, FR-133).
 *
 * Tried in order — initiator, ticket assignee, integration default — and refused when the order
 * runs out. Returns a single id, never a set: "exactly one human owner" is expressed by the return
 * type as much as by the column.
 *
 * @param reader - A handle or transaction. Reads only; this decides an owner, it does not set one.
 * @param request - See {@link OwnerResolutionRequest}.
 */
export const resolveWorkflowOwner = async (
  reader: OwnershipReader,
  request: OwnerResolutionRequest,
): Promise<ResolvedWorkflowOwner> => {
  const { initiatedByUserId, integrationId, ticketAssigneeEmail } = request

  // A person pressed the button, so a person is accountable. No lookup: `authedProcedure` has
  // already established that this session belongs to an active user (FR-175).
  if (initiatedByUserId !== undefined) {
    return { ownerUserId: initiatedByUserId, source: 'initiator' }
  }

  if (integrationId === undefined) {
    throw unattributableWorkflowError()
  }

  if (ticketAssigneeEmail !== undefined) {
    const assignee = await findActiveUserByEmail(reader, ticketAssigneeEmail)
    if (assignee !== undefined) {
      return { ownerUserId: assignee, source: 'ticket_assignee' }
    }
  }

  const fallback = await findIntegrationDefaultOwner(reader, integrationId)
  if (fallback === undefined) {
    throw integrationOwnerlessError()
  }

  return { ownerUserId: fallback, source: 'integration_default' }
}

/** What {@link reassignWorkflowOwner} answers with. */
export interface OwnerReassignment {
  readonly workflow: Workflow
  readonly previousOwnerUserId: string
  /** False when the run already had this owner. Not a refusal — simply not an event (FR-134). */
  readonly changed: boolean
}

/** A reassignment, and the admin performing it. */
export interface ReassignOwnerRequest extends ReassignOwnerInput {
  readonly actorUserId: string
}

/**
 * Record who reassigned a run and when (FR-134).
 *
 * Takes the surrounding transaction, so the trail cannot survive a reassignment that rolled back —
 * the rule `../admin/audit-log.ts` states for every other audited change.
 */
const recordReassignment = async (
  writer: OwnershipWriter,
  entry: {
    readonly actorUserId: string
    readonly workflowId: string
    readonly from: string
    readonly to: string
  },
): Promise<void> => {
  await writer.insert(configurationAudit).values({
    actorUserId: entry.actorUserId,
    entityType: WORKFLOW_AUDIT_ENTITY_TYPE,
    entityId: entry.workflowId,
    action: OWNER_REASSIGNED_ACTION,
    detail: { from: entry.from, to: entry.to },
  })
}

/**
 * Hand a run to a different accountable human (FR-134, FR-176).
 *
 * One transaction: the row moves, the flag clears and the audit entry lands together. Refuses a
 * deactivated nominee with the same message an ad hoc launch gives, because it is the same rule —
 * a run owned by an account that cannot act on it is the state `needs_reassignment` exists to
 * escape, not one to reassign into.
 *
 * `NOT_FOUND` for a workflow that does not exist. The caller is `adminProcedure`, so there is no
 * scope to consult and nothing to disclose: an admin sees every run (FR-183).
 *
 * @param writer - A handle or transaction covering the whole change.
 * @param request - See {@link ReassignOwnerRequest}.
 */
export const reassignWorkflowOwner = async (
  writer: OwnershipWriter,
  request: ReassignOwnerRequest,
): Promise<OwnerReassignment> => {
  const { workflowId, ownerUserId, actorUserId } = request

  const existing = firstRow(
    await writer
      .select({ id: workflows.id, ownerUserId: workflows.ownerUserId })
      .from(workflows)
      .where(eq(workflows.id, workflowId))
      .limit(1)
      .for('update'),
  )

  if (existing === undefined) {
    throw workflowNotFoundError()
  }

  if (!(await isOwnableUser(writer, ownerUserId))) {
    throw ownerNotAvailableError()
  }

  if (existing.ownerUserId === ownerUserId) {
    const unchanged = firstRow(
      await writer.select().from(workflows).where(eq(workflows.id, workflowId)).limit(1),
    )
    if (unchanged === undefined) {
      throw workflowNotFoundError()
    }
    return { workflow: unchanged, previousOwnerUserId: ownerUserId, changed: false }
  }

  const updated = firstRow(
    await writer
      .update(workflows)
      // The flag says "this run's owner was deactivated and somebody must take it over". Somebody
      // just did, so it is no longer true (FR-176).
      .set({ ownerUserId, needsReassignment: false })
      .where(eq(workflows.id, workflowId))
      .returning(),
  )

  if (updated === undefined) {
    throw workflowNotFoundError()
  }

  await recordReassignment(writer, {
    actorUserId,
    workflowId,
    from: existing.ownerUserId,
    to: ownerUserId,
  })

  return { workflow: updated, previousOwnerUserId: existing.ownerUserId, changed: true }
}

/**
 * `workflow.reassignOwner` — ready to mount (FR-134).
 *
 * `adminProcedure`, per api-surface.md. Reassignment decides who is accountable for somebody
 * else's work and is the mechanism that resolves a deactivation (FR-176); a non-admin who could
 * perform it could also hand themselves a run, which is the ownership half of the access model
 * (FR-179). The refusal is recorded by the procedure itself before this resolver is reached.
 */
export const reassignOwnerProcedure = adminProcedure
  .input(reassignOwnerInput)
  .mutation(
    async ({ ctx, input }): Promise<OwnerReassignment> =>
      ctx.db.transaction(async (tx) =>
        reassignWorkflowOwner(tx, { ...input, actorUserId: ctx.user.id }),
      ),
  )
