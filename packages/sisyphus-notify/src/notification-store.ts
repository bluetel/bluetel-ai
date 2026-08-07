import type {
  NotificationEvent,
  TerminalOutcome,
  WorkflowState,
} from '@bluetel-ai/sisyphus-api/client'
import type { Notification, SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import {
  integrations,
  notificationPreferences,
  notifications,
  users,
  workflows,
  workflowWatchers,
  workspaces,
  workspaceVersions,
} from '@bluetel-ai/sisyphus-api/db'
import { and, desc, eq, gte, inArray } from 'drizzle-orm'

/**
 * **The notify path's entire access to the database — and it cannot write workflow state.**
 *
 * This is how FR-141 is made structural rather than advisory. The requirement is that a delivery
 * failure never alters the workflow's own state or outcome: a run that succeeded and could not be
 * announced is a successful run with a failed notification, not a failed run. The usual way to
 * honour that is a comment asking the next author to be careful, which lasts until the next author.
 *
 * Instead, **nothing on the delivery path is given a database handle**. `./delivery.ts` takes a
 * {@link NotificationStore} and a `SlackDirectMessenger`, and neither type has a method that
 * touches `workflows` — four reads and exactly one write, into the append-only `notifications`
 * table. There is no `update`, no `transaction`, and no escape hatch back to the handle. A future
 * edit that wanted to fail the run on a delivery error would have to add a method to this interface
 * first, which is a visible change to a file whose whole subject is that it must not happen.
 *
 * It follows the seam-plus-recording-fake shape the control plane's `src/aws/` established, for the
 * same reason: the
 * delivery tests must be able to produce a Slack outage and an unnotifiable user on demand, and
 * neither is arrangeable against a real service.
 */

/** What a message needs to say about the run it concerns (FR-137). */
export interface NotificationSubject {
  readonly workflowId: string
  readonly state: WorkflowState
  readonly terminalOutcome: TerminalOutcome | null
  readonly outcomeReason: string | null
  readonly ticketReference: string | null
  readonly workspaceName: string | null
  readonly integrationName: string | null
  readonly ownerUserId: string
  readonly turnsUsed: number
  readonly turnCap: number | null
  readonly spendUsed: string
  readonly spendCap: string | null
}

/** How a person comes to be in the audience for a run's notifications (FR-138). */
export type AudienceRelation = 'owner' | 'watcher'

/**
 * One candidate recipient, as read.
 *
 * Deliberately **unfiltered**: `preferenceEnabled` is the raw left-join result, `null` where the
 * user has no row for this event, and `slackUserId` is `null` for a user with no resolvable Slack
 * identity. Deciding what those absences mean is `./recipients.ts`'s job, so the two rules that
 * matter — "no preference row means enabled" and "no Slack id means unnotifiable" — are pure
 * functions with tests rather than clauses buried in SQL.
 */
export interface AudienceMember {
  readonly userId: string
  readonly displayName: string
  readonly slackUserId: string | null
  readonly isActive: boolean
  readonly relation: AudienceRelation
  /** `null` means no row exists, which means **enabled** (FR-138). */
  readonly preferenceEnabled: boolean | null
}

/** A message that reached someone, for the coalescing window to measure against (FR-139). */
export interface RecentDelivery {
  readonly recipientUserId: string
  readonly deliveredAt: Date
}

/** One delivery attempt, as it is recorded (FR-141). */
export interface NotificationAttempt {
  /**
   * `null` for an integration-tick summary, which is one message about many runs (FR-139).
   * Recording it against an arbitrary one of them would be a lie, and not recording it would leave
   * the one message a user actually received absent from the audit.
   */
  readonly workflowId: string | null
  readonly recipientUserId: string
  readonly event: NotificationEvent
  readonly outcome: Notification['outcome']
  /** How many transitions this one message stood for. `1` when nothing was folded. */
  readonly coalescedCount?: number
  readonly error?: string | null
}

/**
 * The store. **Four reads and one append.**
 *
 * Every method is about notifications, preferences, watchers or the people involved. None of them
 * can change a workflow's state, outcome, caps or consumption, and that is the point — see the
 * module comment.
 */
export interface NotificationStore {
  /** What the message will say about the run, or `undefined` when the run is gone. */
  readonly readSubject: (workflowId: string) => Promise<NotificationSubject | undefined>
  /** The run's owner and watchers, with their preference for this event as stored (FR-138). */
  readonly readAudience: (input: {
    readonly workflowId: string
    readonly event: NotificationEvent
  }) => Promise<readonly AudienceMember[]>
  /** The same shape for a named set of people, for the workflow-less tick summary (FR-139). */
  readonly readAudienceByUser: (input: {
    readonly userIds: readonly string[]
    readonly event: NotificationEvent
  }) => Promise<readonly AudienceMember[]>
  /** Deliveries for one run since a moment, newest first — the coalescing input (FR-139). */
  readonly readRecentDeliveries: (input: {
    readonly workflowId: string
    readonly since: Date
  }) => Promise<readonly RecentDelivery[]>
  /** Append one attempt. The only write this interface admits (FR-141). */
  readonly recordAttempt: (attempt: NotificationAttempt) => Promise<Notification>
}

/** What the store needs from a handle. Narrower than the handle, and never widened. */
export type NotificationReader = Pick<SisyphusDatabase, 'insert' | 'select'>

/**
 * The first row, honestly typed.
 *
 * `noUncheckedIndexedAccess` is off in this project, so `rows[0]` is typed as present even when the
 * result set is empty — and a `=== undefined` guard against it is narrowed away as unreachable.
 * Going through a function whose *declared* return type admits `undefined` restores the check.
 */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/**
 * Bind the store to a database handle.
 *
 * The handle stays captured in this closure and is never handed on: what leaves this function is a
 * {@link NotificationStore}, which is exactly the five operations above.
 *
 * @param options - The handle to read and append through.
 */
export const createNotificationStore = (options: {
  readonly db: NotificationReader
}): NotificationStore => {
  const { db } = options

  return {
    readSubject: async (workflowId) =>
      firstRow(
        await db
          .select({
            workflowId: workflows.id,
            state: workflows.state,
            terminalOutcome: workflows.terminalOutcome,
            outcomeReason: workflows.outcomeReason,
            ticketReference: workflows.ticketReference,
            workspaceName: workspaces.name,
            integrationName: integrations.name,
            ownerUserId: workflows.ownerUserId,
            turnsUsed: workflows.turnsUsed,
            turnCap: workflows.turnCap,
            spendUsed: workflows.spendUsed,
            spendCap: workflows.spendCap,
          })
          .from(workflows)
          .leftJoin(workspaceVersions, eq(workspaceVersions.id, workflows.workspaceVersionId))
          .leftJoin(workspaces, eq(workspaces.id, workspaceVersions.workspaceId))
          .leftJoin(integrations, eq(integrations.id, workflows.originatingIntegrationId))
          .where(eq(workflows.id, workflowId))
          .limit(1),
      ),

    readAudience: async ({ workflowId, event }) => {
      // Two queries rather than one union, because the owner is a column on `workflows` and the
      // watchers are rows in another table — expressing both as one statement would need a union
      // whose branches share no join shape, for no saving worth the illegibility.
      const owners = await db
        .select({
          userId: users.id,
          displayName: users.displayName,
          slackUserId: users.slackUserId,
          isActive: users.isActive,
          preferenceEnabled: notificationPreferences.enabled,
        })
        .from(workflows)
        .innerJoin(users, eq(users.id, workflows.ownerUserId))
        // Left, never inner: an inner join would silently drop every user who has never opened
        // their preferences, which is most of them, and the default is not silence (FR-138).
        .leftJoin(
          notificationPreferences,
          and(
            eq(notificationPreferences.userId, users.id),
            eq(notificationPreferences.event, event),
          ),
        )
        .where(eq(workflows.id, workflowId))
        .limit(1)

      const watchers = await db
        .select({
          userId: users.id,
          displayName: users.displayName,
          slackUserId: users.slackUserId,
          isActive: users.isActive,
          preferenceEnabled: notificationPreferences.enabled,
        })
        .from(workflowWatchers)
        .innerJoin(users, eq(users.id, workflowWatchers.userId))
        .leftJoin(
          notificationPreferences,
          and(
            eq(notificationPreferences.userId, users.id),
            eq(notificationPreferences.event, event),
          ),
        )
        .where(eq(workflowWatchers.workflowId, workflowId))

      return [
        ...owners.map((row) => ({ ...row, relation: 'owner' as const })),
        ...watchers.map((row) => ({ ...row, relation: 'watcher' as const })),
      ]
    },

    readAudienceByUser: async ({ userIds, event }) => {
      if (userIds.length === 0) {
        return []
      }

      const rows = await db
        .select({
          userId: users.id,
          displayName: users.displayName,
          slackUserId: users.slackUserId,
          isActive: users.isActive,
          preferenceEnabled: notificationPreferences.enabled,
        })
        .from(users)
        .leftJoin(
          notificationPreferences,
          and(
            eq(notificationPreferences.userId, users.id),
            eq(notificationPreferences.event, event),
          ),
        )
        .where(inArray(users.id, [...userIds]))

      // Everyone reached this way is reached because they own one of the runs the tick started.
      return rows.map((row) => ({ ...row, relation: 'owner' as const }))
    },

    readRecentDeliveries: async ({ workflowId, since }) => {
      const rows = await db
        .select({
          recipientUserId: notifications.recipientUserId,
          deliveredAt: notifications.createdAt,
        })
        .from(notifications)
        .where(
          and(
            eq(notifications.workflowId, workflowId),
            eq(notifications.outcome, 'delivered'),
            gte(notifications.createdAt, since),
          ),
        )
        .orderBy(desc(notifications.createdAt))

      return rows
    },

    recordAttempt: async (attempt) => {
      const row = firstRow(
        await db
          .insert(notifications)
          .values({
            workflowId: attempt.workflowId,
            recipientUserId: attempt.recipientUserId,
            event: attempt.event,
            channel: 'slack_dm',
            outcome: attempt.outcome,
            coalescedCount: attempt.coalescedCount ?? 1,
            error: attempt.error ?? null,
          })
          .returning(),
      )

      if (row === undefined) {
        throw new Error('Recording a notification attempt returned no row.')
      }

      return row
    },
  }
}
