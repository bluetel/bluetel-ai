import type { CredentialWaitDetail } from '@bluetel-ai/sisyphus-api/client'
import { CREDENTIAL_WAIT_WAITING_ON, credentialWaitDetail } from '@bluetel-ai/sisyphus-api/client'
import type { SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import { workflowEvents } from '@bluetel-ai/sisyphus-api/db'
import { and, desc, eq, sql } from 'drizzle-orm'

import type { WaitReason } from '../credentials/allocate'

/**
 * **How a wait for an agent credential is recorded, and how its clock is read back** (003/FR-024,
 * FR-028, FR-029, SC-006).
 *
 * Two jobs need the same two facts and neither of them owns the pair, which is why this is its own
 * module rather than a private helper inside one of them. Admission writes the entry when a run
 * enters `awaiting_credential`; the drain reads it back on every pass, to say how long a run has
 * been waiting and to decide whether that wait has passed FR-028's limit. A copy of the query in
 * each would be two places for the discriminator to be spelled differently, and the failure mode of
 * that is a limit that never fires because the expiry cannot find the entry admission wrote.
 *
 * ## Why the wait lives on the timeline and not in a column
 *
 * There is no `awaiting_credential_since` column and this does not add one. The timeline already
 * carries the fact — the run moved into the state, and that transition is an event — and a second
 * column holding the same thing would be a second thing to keep in step. The interesting failure of
 * such pairs is that they disagree: a column updated by one path and not another produces a run
 * that has been waiting for either four minutes or four hours depending on which the reader trusts.
 * `reconcile.ts` makes the same argument at length about `paused_at`, and this is that argument
 * applied to a state entered from one place.
 *
 * It also puts the **reason** where the reason has to be. FR-029's four cases differ in remedy, and
 * an engineer looking at a stalled run needs the sentence next to the run, not in a job log that
 * scrolled past — SC-006 says they must be able to tell from the workflow view alone. The detail is
 * a `jsonb` column the panel already reads on the timeline, so recording the classification costs
 * one write and no new read path.
 *
 * ## Why `queued` rather than a new event name
 *
 * `workflow_event` has no `awaiting_credential` member, and adding one is a migration that buys a
 * distinction the detail already carries. `queued` is honest here: the run is queued, and the
 * `waitingOn` discriminator says what for. `packages/sisyphus-api/src/schemas/machine.ts` does the
 * same thing for the two very different situations that share the `parked` event, and that
 * precedent is the reason this shape was chosen over a second vocabulary — see
 * {@link CREDENTIAL_WAIT_WAITING_ON}.
 *
 * The consequence is that **every read here filters on the discriminator**, never on the event name
 * alone. A run that was queued under the concurrency ceiling and later waited for a credential has
 * two `queued` entries meaning two different things, and a query that matched the name would time
 * the credential wait from the wrong one.
 *
 * ## The reason is recorded once, when the wait begins
 *
 * The drain does not rewrite it on every pass, and that is a deliberate limitation rather than an
 * oversight. Re-recording would put an entry on the timeline every few seconds for the whole of a
 * long wait, and re-recording only on change would still spend a census query per waiting run per
 * pass on a job that runs on a timer. So the entry says why the wait *began*, the expiry in
 * `drain-queue.ts` recomputes the reason at the moment it fails a run — which is when an accurate
 * answer actually matters — and a wait whose cause changes underneath it is 003's T115/T120, in the
 * phase that adds the alerting to go with it.
 */

/**
 * The timeline event a credential wait is recorded as.
 *
 * Named rather than written as a literal at each call site, so the write and the two reads cannot
 * come to disagree — which would be silent, because a mismatched read simply finds nothing.
 */
export const CREDENTIAL_WAIT_EVENT = 'queued'

/** See `admit-workflow.ts`: `noUncheckedIndexedAccess` is off, so indexing needs an honest type. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/** What can write the entry — a pooled handle or an open transaction. */
export type CredentialWaitWriter = Pick<SisyphusDatabase, 'insert'>

/** What can read it back. */
export type CredentialWaitReader = Pick<SisyphusDatabase, 'select'>

/**
 * The recorded shape of a classification, ready for `workflow_events.detail`.
 *
 * Pure, and separated from the insert so that what is written and what
 * {@link import('@bluetel-ai/sisyphus-api/client').credentialWaitDetail} parses back cannot drift
 * apart — the same split `snapshot-park.ts` makes in the API package, for the same reason.
 *
 * The census is deliberately **not** carried. It is a point-in-time count that is stale the moment
 * it is written, and a panel rendering "3 held" against a pool that has since changed would be
 * confidently wrong; the sentences say what was true without inviting arithmetic on it.
 *
 * @param reason - The classification from `credentials/allocate/wait-reason.ts`.
 */
export const credentialWaitDetailFor = (reason: WaitReason): CredentialWaitDetail => ({
  waitingOn: CREDENTIAL_WAIT_WAITING_ON,
  kind: reason.kind,
  configurationFault: reason.configurationFault,
  groups: reason.groups.map((group) => ({ name: group.name, position: group.position })),
  summary: reason.summary,
  remedy: reason.remedy,
})

/**
 * Record that a run has begun waiting for an agent credential.
 *
 * Written by the caller's transaction — the same one that moves `workflows.state` — so a run cannot
 * end up in `awaiting_credential` with no record of when or why. The two are one fact.
 *
 * @param writer - The transaction performing the state change.
 * @param options.workflowId - The run entering the wait.
 * @param options.reason - Why there was nothing for it (FR-029).
 * @returns When the wait began, as the database recorded it — the clock FR-028 counts from.
 */
export const recordCredentialWait = async (
  writer: CredentialWaitWriter,
  options: { readonly workflowId: string; readonly reason: WaitReason },
): Promise<Date> => {
  const inserted = firstRow(
    await writer
      .insert(workflowEvents)
      .values({
        workflowId: options.workflowId,
        event: CREDENTIAL_WAIT_EVENT,
        actorType: 'control_plane',
        detail: credentialWaitDetailFor(options.reason),
      })
      .returning({ createdAt: workflowEvents.createdAt }),
  )

  if (inserted === undefined) {
    throw new Error(
      `Recording the credential wait for workflow ${options.workflowId} returned no row. Committing the state change without it would leave a run waiting with nothing to say since when, and FR-028's limit would have no clock to run.`,
    )
  }

  return inserted.createdAt
}

/** One recorded wait, as read back off the timeline. */
export interface RecordedCredentialWait {
  /** When the wait began. */
  readonly since: Date
  /** The classification recorded at that moment, or `undefined` if it will not parse. */
  readonly detail: CredentialWaitDetail | undefined
}

/**
 * The run's most recent credential wait, or `undefined` if it has never waited for one.
 *
 * **Most recent** rather than "the one": a run may in principle be queued, admitted, and queued
 * again, and it is the current wait the clock is about — the same rule `reconcile.ts` applies to
 * the `paused` entry it times a pause from. Ordered by `created_at` with the id as tie-break; ids
 * are UUID v7, so two entries written in the same microsecond still have a chronological order.
 *
 * The detail is **parsed**, not cast, and a row that fails to parse yields `undefined` there while
 * still yielding its timestamp. That combination is the honest one: an entry written by an older
 * control plane still proves the run has been waiting since then, and the clock is what FR-028
 * needs; only the explanation is missing, and inventing one would be worse than saying nothing.
 *
 * @param reader - A pooled handle or an open transaction.
 * @param workflowId - The run.
 */
export const latestCredentialWait = async (
  reader: CredentialWaitReader,
  workflowId: string,
): Promise<RecordedCredentialWait | undefined> => {
  const row = firstRow(
    await reader
      .select({ createdAt: workflowEvents.createdAt, detail: workflowEvents.detail })
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.workflowId, workflowId),
          eq(workflowEvents.event, CREDENTIAL_WAIT_EVENT),
          // The discriminator, not the event name. A `queued` entry written under the FR-040
          // ceiling is a different wait about a different scarcity, and timing this one from that
          // one would report a run as having waited since it was created.
          sql`${workflowEvents.detail}->>'waitingOn' = ${CREDENTIAL_WAIT_WAITING_ON}`,
        ),
      )
      .orderBy(desc(workflowEvents.createdAt), desc(workflowEvents.id))
      .limit(1),
  )

  if (row === undefined) {
    return undefined
  }

  const parsed = credentialWaitDetail.safeParse(row.detail)

  return { since: row.createdAt, detail: parsed.success ? parsed.data : undefined }
}
