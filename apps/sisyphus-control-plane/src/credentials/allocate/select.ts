import type { SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import {
  agentCredentials,
  credentialGroups,
  profileCredentialGroups,
  workflows,
} from '@bluetel-ai/sisyphus-api/db'
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm'

/**
 * Which credential a workflow should be offered — the Selection half of
 * [the allocation protocol](../../../../../specs/003-agent-credential-pool/contracts/allocation-protocol.md#selection).
 *
 * **This function is where SC-016 lives.** The criterion says work launched under an execution
 * profile is never performed by a credential outside that profile's attached groups, and there are
 * two ways to make that true: audit for violations afterwards, or arrange that no code path can
 * produce one. This is the second. Candidates are reached by joining *out from the workflow row* to
 * its own profile's attachments, so the set of credentials this query can return is bounded by the
 * scoping rather than filtered by it — and the only parameter is the workflow's id, so there is
 * nothing a caller could pass that would widen it. A `credentialGroupId` or `executionProfileId`
 * argument would be the same query with the guarantee moved to every call site, which is how an
 * invariant becomes an audit.
 *
 * **The contract's loop and this single statement are the same thing.** The protocol is written as
 * "for each attached group in `position` order, if it has candidates take its least-recently-used
 * one" — a loop, because that is how the rule reads. Executed as a loop it would be one round trip
 * per group, and the fall-through would be a decision the application made between two reads of a
 * pool that can change underneath it. Ordering by `(position, last_used_at NULLS FIRST)` and taking
 * one row is the same answer: a group with no candidates contributes no rows, so falling through to
 * the next preference is the *absence* of rows rather than a second query, and least-recently-used
 * applies within whichever group won because `position` sorts first.
 *
 * ## What is a candidate, and why each condition is here
 *
 * - **`state = 'available'`** — the only selectable state, and deliberately the only one named.
 *   Every other member of `credential_state` is a reason to pass a credential over, so a value
 *   added to that enum later is unselectable by default. That is the safe direction for a set whose
 *   failure mode is handing one identity to two runs.
 * - **The credential and its group both `enabled`** — disabling withholds from future selection
 *   without evicting a live holder (FR-006), and a disabled group applies that to every member at
 *   once. Both are checked because they are different administrator actions with the same intent.
 * - **Neither archived** — soft deletion is how this feature deletes (FR-005, FR-066). A row that
 *   has been archived is history, not capacity, and selection that saw through it would resurrect a
 *   credential an administrator believes is gone.
 * - **`secret_id is not null`** — FR-008 as a data rule. A credential with nowhere to fetch material
 *   from cannot be handed to a workflow by any code path, whatever its `state` column says. It is
 *   redundant with `available` in every state the state machine can reach, and it is here precisely
 *   because it is the condition that stays true if the state machine ever grows a path that is not.
 *
 * `last_used_at IS NULL` sorts **first**: a newly registered credential is the least recently used
 * thing there is, and proving a fresh login works early is worth more than spreading load evenly.
 * This is not Postgres's default — an ascending sort puts nulls last — so the ordering says so
 * explicitly. The credential's own id breaks the remaining ties; ids are UUID v7, so the tie-break
 * is itself chronological rather than arbitrary, and repeated selection against an untouched pool
 * returns the same row rather than shuffling.
 *
 * **Least-recently-used does not keep the pool alive**, and it is worth being clear that it was
 * never meant to. LRU applies *within* the group that was reached, so a lower-preference group can
 * receive no traffic for months and rot. That job belongs to the keep-alive schedule (FR-035), and
 * this asymmetry is the reason keep-alive exists at all.
 *
 * Selection takes **no lock and makes no claim**. Two callers can be offered the same credential;
 * that is expected, and resolving it is `lease/acquire.ts`'s conditional update and the partial
 * unique index behind it. Locking here would move the exclusivity guarantee out of the database and
 * into the gap between this read and that write, which is exactly where the race lives.
 */

/**
 * What selection needs from a handle — satisfied by a pooled client or by an open transaction, so
 * an acquiring transaction can select inside itself without a cast.
 */
export type SelectionReader = Pick<SisyphusDatabase, 'select'>

/** A credential offered to a workflow. Carries no material and no way to reach any. */
export interface SelectedCredential {
  readonly agentCredentialId: string
  readonly credentialGroupId: string
  /** For the FR-029 report, which names the groups that were searched. */
  readonly credentialGroupName: string
  /** The attachment's preference position — 1 is the profile's first choice. */
  readonly position: number
  /** The credential's fence **before** acquisition raises it. Never issued to a holder from here. */
  readonly fence: number
  /** Null for a credential that has never been used, which is why it sorted first. */
  readonly lastUsedAt: Date | null
}

export interface SelectForOptions {
  /**
   * The workflow that wants a seat. The **only** input, and that is the point — see the module
   * note. Its execution profile is resolved inside the query rather than passed in.
   */
  readonly workflowId: string
}

/**
 * The first row, honestly typed.
 *
 * `noUncheckedIndexedAccess` is off in this workspace, so `rows[0]` is typed as present even when
 * the result set is empty, and a `=== undefined` guard against it is narrowed away as unreachable.
 * A function whose declared return type admits `undefined` restores the check.
 */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/**
 * The credential this workflow should be offered, or `undefined` if its profile can reach none.
 *
 * `undefined` covers four situations the caller may want to tell apart — every reachable credential
 * held, every one cooling off, every one unhealthy or disabled, or the attached groups holding no
 * credentials at all (FR-029). It does not distinguish them, because that classification is a
 * second pass over the same rows and it belongs with the waiting state that reports it (US4). What
 * matters here is that all four mean the same thing to the caller: do not provision compute.
 *
 * @param reader - A database handle or an open transaction.
 * @param options - The workflow asking. Nothing else, deliberately.
 * @returns The least-recently-used available credential in the earliest attached group that has
 *   one, or `undefined`.
 */
export const selectFor = async (
  reader: SelectionReader,
  options: SelectForOptions,
): Promise<SelectedCredential | undefined> =>
  firstRow(
    await reader
      .select({
        agentCredentialId: agentCredentials.id,
        credentialGroupId: credentialGroups.id,
        credentialGroupName: credentialGroups.name,
        position: profileCredentialGroups.position,
        fence: agentCredentials.fence,
        lastUsedAt: agentCredentials.lastUsedAt,
      })
      // Out from the workflow, never in from the pool. A query that started at `agent_credentials`
      // and narrowed afterwards would return the whole pool for a workflow that matched nothing.
      .from(workflows)
      .innerJoin(
        profileCredentialGroups,
        eq(profileCredentialGroups.executionProfileId, workflows.executionProfileId),
      )
      .innerJoin(
        credentialGroups,
        eq(credentialGroups.id, profileCredentialGroups.credentialGroupId),
      )
      .innerJoin(agentCredentials, eq(agentCredentials.credentialGroupId, credentialGroups.id))
      .where(
        and(
          eq(workflows.id, options.workflowId),
          eq(credentialGroups.enabled, true),
          isNull(credentialGroups.archivedAt),
          eq(agentCredentials.enabled, true),
          isNull(agentCredentials.archivedAt),
          eq(agentCredentials.state, 'available'),
          isNotNull(agentCredentials.secretId),
        ),
      )
      .orderBy(
        // Preference order first: this is what makes a lower-preference group reachable only when
        // every earlier one has nothing available (FR-064).
        asc(profileCredentialGroups.position),
        // Then least-recently-used within whichever group that turned out to be (FR-034). Written
        // as SQL because `NULLS FIRST` is the opposite of Postgres's default for an ascending sort,
        // and the default would pick precisely the wrong row.
        sql`${agentCredentials.lastUsedAt} asc nulls first`,
        asc(agentCredentials.id),
      )
      .limit(1),
  )
