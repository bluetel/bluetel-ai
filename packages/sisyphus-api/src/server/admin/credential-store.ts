import type { SQL } from 'drizzle-orm'
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm'

import type { AgentCredential, CredentialGroup, SisyphusDatabase } from '../../db'
import {
  agentCredentials,
  credentialGroups,
  credentialLeases,
  executionProfiles,
  profileCredentialGroups,
  workflows,
} from '../../db'
import type { CredentialState, WorkflowState } from '../../enums'

import type { Page } from './user-queries'

/**
 * Data access for the agent credential pool — `credential_groups`, `agent_credentials`,
 * `credential_leases` and `profile_credential_groups`.
 *
 * Kept apart from the routers in `credential-groups.ts` for the reason `bundle-store.ts` is kept
 * apart from `bundles.ts` and `profile-store.ts` from `profiles.ts`: the parts that are easy to get
 * wrong — the FR-066 reference sweep, and above all the renumbering that has to keep
 * `profile_credential_groups_position_key` satisfied at every instant rather than only at commit —
 * belong in one named place with their own test, not inline in a resolver.
 *
 * Four rules shape this module:
 *
 * 1. **No transport concerns.** Nothing here throws a `TRPCError`, reads a session or decides who
 *    may act. It answers questions and performs writes; the router decides what a `false` means to
 *    an administrator. That is what lets Phase 5's control-plane callers — which have no tRPC
 *    context at all — reach the same queries the panel does.
 * 2. **Every function takes a writer rather than importing a handle**, so a write and the audit row
 *    it belongs with commit together. Same argument as `AuditWriter` in `./audit-log`.
 * 3. **Nothing here reads or writes credential material.** `agent_credentials.secret_id` is a
 *    Secrets Manager name; the material behind it is fetched by the machine surface and never by
 *    this module (FR-011). There is no function here that could return a token, which is a property
 *    of the exported surface rather than of care taken at each call site.
 * 4. **Operations land with the phase that first needs them.** `keep_alive_runs` has no reader or
 *    writer here yet and `credential_leases` has only the two counts the FR-006 disable paths and
 *    the FR-005 delete refusal need, because inventing an acquire/release pair ahead of
 *    [the leasing protocol](../../../../../specs/003-agent-credential-pool/contracts/allocation-protocol.md)
 *    would fix the wrong shape: acquisition is a single conditional `UPDATE` plus an insert plus an
 *    audit row in one transaction, and a store function that returned control between those steps
 *    would be a seam through which the exclusivity guarantee could be lost.
 *
 * ## Positions are contiguous and 1-based, and that is load-bearing
 *
 * A profile's attachments occupy positions `1..n` with no gaps. Nothing in the schema requires it —
 * the unique index only forbids two rows sharing a position — but {@link attachCredentialGroup},
 * {@link detachCredentialGroup} and {@link reorderCredentialGroups} all maintain it, which is what
 * makes "third preference" mean the same thing to an administrator as it does to selection, and
 * what lets a reorder be validated as a permutation of the groups already attached rather than as
 * an arbitrary list of numbers. See {@link renumberAttachments} for how it is kept true mid-flight.
 */

/**
 * Anything that can run the statements this module issues — the pooled handle or a transaction
 * derived from it. Typed structurally, like `AuditWriter` and `GrantWriter`, so a caller inside
 * `db.transaction(...)` passes the transaction object without a cast.
 */
export type CredentialStoreWriter = Pick<
  SisyphusDatabase,
  'select' | 'insert' | 'update' | 'delete' | 'execute'
>

/**
 * The first row, honestly typed.
 *
 * `noUncheckedIndexedAccess` is off in this project, so `rows[0]` is typed as present even when the
 * result set is empty, and a `=== undefined` guard against it is narrowed away as unreachable.
 * Going through a function whose declared return type admits `undefined` restores the check.
 */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/** Split an over-fetched row set into a page and its cursor. */
const toPage = <TItem extends { readonly id: string }>(
  rows: readonly TItem[],
  limit: number,
): Page<TItem> => {
  const items = rows.slice(0, limit)
  return { items, nextCursor: rows.length > limit ? items[items.length - 1]?.id : undefined }
}

// ---------------------------------------------------------------------------------------------
// Credential groups
// ---------------------------------------------------------------------------------------------

/**
 * One group as `credentialGroups.list` returns it.
 *
 * The two counts are the FR-066 refusal rendered ahead of the attempt: an administrator can see
 * that a group holds four credentials and is attached to two profiles without having to click
 * delete and read the refusal. They are also the two numbers that answer "is this group worth
 * keeping", which is the question the panel exists to support.
 */
export interface CredentialGroupListing {
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly enabled: boolean
  readonly archivedAt: Date | null
  readonly createdAt: Date
  /** Members, archived ones excluded — an archived credential is not capacity. */
  readonly credentialCount: number
  /** Execution profiles that may draw from this group (FR-062). */
  readonly attachedProfileCount: number
}

/** What the list query is filtered by. */
export interface ListCredentialGroupsQuery {
  readonly enabledOnly: boolean
  readonly includeArchived: boolean
  readonly limit: number
  readonly cursor?: string
}

/** The group columns the panel reads. Deliberately not `select *`. */
const credentialGroupColumns = {
  id: credentialGroups.id,
  name: credentialGroups.name,
  description: credentialGroups.description,
  enabled: credentialGroups.enabled,
  archivedAt: credentialGroups.archivedAt,
  createdAt: credentialGroups.createdAt,
} as const

/** How many live credentials sit in each of the named groups. */
const readCredentialCounts = async (
  writer: CredentialStoreWriter,
  credentialGroupIds: readonly string[],
): Promise<Map<string, number>> => {
  if (credentialGroupIds.length === 0) {
    return new Map()
  }

  const rows = await writer
    .select({
      credentialGroupId: agentCredentials.credentialGroupId,
      total: sql<number>`count(*)::int`,
    })
    .from(agentCredentials)
    .where(
      and(
        inArray(agentCredentials.credentialGroupId, [...credentialGroupIds]),
        isNull(agentCredentials.archivedAt),
      ),
    )
    .groupBy(agentCredentials.credentialGroupId)

  return new Map(rows.map((row) => [row.credentialGroupId, row.total]))
}

/** How many execution profiles are attached to each of the named groups. */
const readAttachmentCounts = async (
  writer: CredentialStoreWriter,
  credentialGroupIds: readonly string[],
): Promise<Map<string, number>> => {
  if (credentialGroupIds.length === 0) {
    return new Map()
  }

  const rows = await writer
    .select({
      credentialGroupId: profileCredentialGroups.credentialGroupId,
      total: sql<number>`count(*)::int`,
    })
    .from(profileCredentialGroups)
    .where(inArray(profileCredentialGroups.credentialGroupId, [...credentialGroupIds]))
    .groupBy(profileCredentialGroups.credentialGroupId)

  return new Map(rows.map((row) => [row.credentialGroupId, row.total]))
}

/**
 * A page of credential groups, each with its membership and attachment counts.
 *
 * Keyset paginated on the primary key: every id is a UUID v7, so byte order is creation order and
 * `id desc` is newest-first without a second sort column.
 */
export const listCredentialGroups = async (
  writer: CredentialStoreWriter,
  query: ListCredentialGroupsQuery,
): Promise<Page<CredentialGroupListing>> => {
  const filters = [
    query.enabledOnly ? eq(credentialGroups.enabled, true) : undefined,
    query.includeArchived ? undefined : isNull(credentialGroups.archivedAt),
    query.cursor === undefined ? undefined : lt(credentialGroups.id, query.cursor),
  ].filter((filter) => filter !== undefined)

  const rows = await writer
    .select(credentialGroupColumns)
    .from(credentialGroups)
    .where(filters.length === 0 ? undefined : and(...filters))
    .orderBy(desc(credentialGroups.id))
    .limit(query.limit + 1)

  const page = toPage(rows, query.limit)
  const groupIds = page.items.map((group) => group.id)

  const [credentialCounts, attachmentCounts] = await Promise.all([
    readCredentialCounts(writer, groupIds),
    readAttachmentCounts(writer, groupIds),
  ])

  return {
    items: page.items.map((group) => ({
      ...group,
      credentialCount: credentialCounts.get(group.id) ?? 0,
      attachedProfileCount: attachmentCounts.get(group.id) ?? 0,
    })),
    nextCursor: page.nextCursor,
  }
}

/** One group by id, or `undefined`. */
export const findCredentialGroup = async (
  writer: CredentialStoreWriter,
  credentialGroupId: string,
): Promise<CredentialGroup | undefined> =>
  firstRow(
    await writer
      .select()
      .from(credentialGroups)
      .where(eq(credentialGroups.id, credentialGroupId))
      .limit(1),
  )

/**
 * One group by name, or `undefined`.
 *
 * `credential_groups.name` is `citext`, so this comparison is case-insensitive **in the database**
 * and matches `credential_groups_name_key` exactly. Lower-casing in JavaScript before comparing
 * would agree with the index for ASCII and disagree with it for anything else, which is the kind of
 * near-miss that produces a duplicate-key error where a named refusal was intended.
 */
export const findCredentialGroupByName = async (
  writer: CredentialStoreWriter,
  name: string,
): Promise<CredentialGroup | undefined> =>
  firstRow(
    await writer.select().from(credentialGroups).where(eq(credentialGroups.name, name)).limit(1),
  )

export interface InsertCredentialGroupInput {
  readonly name: string
  readonly description: string | undefined
  readonly createdByUserId: string
}

/**
 * Insert a group.
 *
 * Enabled on creation, unlike `insertProfile` and `insertBundle`, which both start disabled. A new
 * group is empty and therefore cannot hand anything to anyone: the gate that matters is on each
 * credential's own `state`, which starts at `awaiting_login` and is unselectable until a login is
 * proven (FR-008). Starting disabled would make "enable the group" a step whose only effect was to
 * be forgotten later.
 */
export const insertCredentialGroup = async (
  writer: CredentialStoreWriter,
  input: InsertCredentialGroupInput,
): Promise<CredentialGroup> => {
  const row = firstRow(
    await writer
      .insert(credentialGroups)
      .values({
        name: input.name,
        description: input.description ?? null,
        createdByUserId: input.createdByUserId,
      })
      .returning(),
  )

  if (row === undefined) {
    throw new Error('Inserting a credential group returned no row.')
  }
  return row
}

export interface UpdateCredentialGroupFields {
  readonly name?: string
  readonly description?: string | null
  readonly enabled?: boolean
  /**
   * The soft delete. A group holding a credential or attached to a profile must never reach this
   * field — see {@link readCredentialGroupReferences}; disabling is what FR-066 offers instead.
   */
  readonly archivedAt?: Date | null
}

/** Update the mutable group row. */
export const updateCredentialGroup = async (
  writer: CredentialStoreWriter,
  credentialGroupId: string,
  fields: UpdateCredentialGroupFields,
): Promise<CredentialGroup | undefined> =>
  firstRow(
    await writer
      .update(credentialGroups)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(credentialGroups.id, credentialGroupId))
      .returning(),
  )

/** An execution profile that draws from a group. */
export interface AttachedProfileReference {
  readonly executionProfileId: string
  readonly name: string
  readonly position: number
}

/**
 * Everything that would break if this group went away (FR-066).
 *
 * **The two conditions are reported separately and that is the point.** FR-066 refuses deletion
 * when a group is attached to a profile *or* holds a credential, and to an administrator those are
 * different problems with different fixes: an attachment is undone by editing the profiles named
 * here, whereas a member credential has to be moved to another group or archived, and a run may be
 * holding it right now. A single `deletable: false` — or one refusal that said "this group is in
 * use" — would leave them to work out which by trial and error, on a screen that already knows the
 * answer.
 *
 * `credentialCount` counts **archived credentials too**, deliberately, and unlike the count on
 * {@link CredentialGroupListing}. An archived credential still carries `credential_group_id` as a
 * foreign key, so deleting the group underneath it would fail on the constraint — reporting the
 * group as deletable and then failing on a database error is worse than refusing honestly.
 */
export interface CredentialGroupReferences {
  readonly credentialCount: number
  readonly attachedProfiles: readonly AttachedProfileReference[]
  /** Credentials in this group that a workflow is holding right now (FR-006, group-wide). */
  readonly liveLeaseCount: number
  /** Exactly `credentialCount === 0 && attachedProfiles.length === 0`. Both are given so neither is inferred. */
  readonly deletable: boolean
}

/**
 * Credentials in this group that a workflow is holding right now.
 *
 * Read so that disabling a group can say how many runs it is *not* interrupting. FR-006 applied
 * group-wide means disabling withholds every member from future selection while leaving live
 * holders alone, and an administrator taking a group out of circulation needs to know whether that
 * is three runs or none — the number goes onto the audit entry and onto the confirmation.
 *
 * Live is `released_at is null`, the same predicate `credential_leases_live_key` is partial on, so
 * this count and the exclusivity index cannot disagree about what a live lease is.
 */
export const countLiveLeasesInGroup = async (
  writer: CredentialStoreWriter,
  credentialGroupId: string,
): Promise<number> => {
  const row = firstRow(
    await writer
      .select({ total: sql<number>`count(*)::int` })
      .from(credentialLeases)
      .innerJoin(agentCredentials, eq(credentialLeases.agentCredentialId, agentCredentials.id))
      .where(
        and(
          eq(agentCredentials.credentialGroupId, credentialGroupId),
          isNull(credentialLeases.releasedAt),
        ),
      ),
  )

  return row?.total ?? 0
}

/** Read the FR-066 reference sweep. */
export const readCredentialGroupReferences = async (
  writer: CredentialStoreWriter,
  credentialGroupId: string,
): Promise<CredentialGroupReferences> => {
  const credentials = firstRow(
    await writer
      .select({ total: sql<number>`count(*)::int` })
      .from(agentCredentials)
      .where(eq(agentCredentials.credentialGroupId, credentialGroupId)),
  )

  const attachedProfiles = await writer
    .select({
      executionProfileId: executionProfiles.id,
      name: executionProfiles.name,
      position: profileCredentialGroups.position,
    })
    .from(profileCredentialGroups)
    .innerJoin(
      executionProfiles,
      eq(profileCredentialGroups.executionProfileId, executionProfiles.id),
    )
    .where(eq(profileCredentialGroups.credentialGroupId, credentialGroupId))
    .orderBy(asc(executionProfiles.name))

  const liveLeaseCount = await countLiveLeasesInGroup(writer, credentialGroupId)
  const credentialCount = credentials?.total ?? 0

  return {
    credentialCount,
    attachedProfiles,
    liveLeaseCount,
    deletable: credentialCount === 0 && attachedProfiles.length === 0,
  }
}

// ---------------------------------------------------------------------------------------------
// Agent credentials
// ---------------------------------------------------------------------------------------------

/**
 * **The selection predicate — the one definition of "this seat may be handed to a run".**
 *
 * Everything that decides whether a credential can be given out reads this, and nothing restates
 * it. That is the point of it being a function returning a `SQL` fragment rather than a list of
 * conditions copied into each query: FR-008's "not selectable until a login is proven", FR-006's
 * "withheld without evicting a live holder" and FR-066's group-wide equivalent are three
 * requirements that all reduce to *which rows a selector may see*, and three copies of that
 * predicate would be three chances for one of them to be forgotten. The pool view's "usable" column
 * and the allocator's `WHERE` clause are then the same sentence, so a seat that the panel reports
 * as usable is one the allocator can actually take — and, far more importantly, a seat the panel
 * reports as withheld is one the allocator cannot.
 *
 * Six conditions, each one a requirement:
 *
 * - `state = 'available'` — the only selectable state (`enums/credential-state.ts`). This alone is
 *   what keeps a freshly registered `awaiting_login` seat, a `held` one, a `cooling_off` one and an
 *   `unhealthy` one out of every candidate set.
 * - `secret_id is not null` — FR-008 again, this time as a **data** rule rather than a state one.
 *   A credential with nowhere to fetch material from cannot be used by any code path whatever its
 *   state column says, so the predicate says so too; the two conditions are deliberately redundant,
 *   because the failure they guard against is a state written without its secret.
 * - `enabled` and `archived_at is null` on the credential — FR-006 and FR-005.
 * - `enabled` and `archived_at is null` on its **group** — FR-006 applied group-wide (FR-066).
 *   This is why the fragment names `credentialGroups`: any query using it must join that table, and
 *   a caller that forgets fails to compile its SQL rather than quietly selecting from a withdrawn
 *   pool.
 *
 * Deliberately **not** here: the group-ordering and least-recently-used *ranking* of FR-064. Which
 * of several usable seats to prefer is a policy the allocator owns; whether a seat is usable at all
 * is a safety property, and mixing the two would let a change to preference order alter who may be
 * selected.
 *
 * The `?? sql`false`` is unreachable — `and` returns `undefined` only for an empty condition list —
 * and it fails closed rather than open on purpose. A predicate that lost its conditions must select
 * nothing, not everything.
 */
export const selectableCredentialCondition = (): SQL =>
  and(
    eq(agentCredentials.state, 'available'),
    isNotNull(agentCredentials.secretId),
    eq(agentCredentials.enabled, true),
    isNull(agentCredentials.archivedAt),
    eq(credentialGroups.enabled, true),
    isNull(credentialGroups.archivedAt),
  ) ?? sql`false`

/**
 * One credential as the pool view renders it (FR-009, FR-053).
 *
 * Carries the group's name as well as its id, because a seat's identity to an administrator is
 * "the third seat in the vendor pool" and a screen that showed only a UUID would make the pool
 * unreadable at exactly the moment somebody is trying to work out which one is broken.
 *
 * `secretId` is the Secrets Manager **name** and never material — the distinction the whole feature
 * rests on (FR-011). It is exposed because whether a seat has one is the visible difference between
 * a registered credential and a logged-in one, and because an administrator investigating a seat
 * needs to be able to find the secret the platform filed its login under without guessing at the
 * naming scheme.
 *
 * `lastFailureReason` is here because FR-009 requires a failed login to be visible **against the
 * credential**; a reason that lived only in a log would satisfy nobody looking at the pool.
 */
export interface AgentCredentialListing {
  readonly id: string
  readonly credentialGroupId: string
  readonly credentialGroupName: string
  readonly credentialGroupEnabled: boolean
  readonly name: string
  readonly state: AgentCredential['state']
  /** The Secrets Manager identifier, never the material behind it. Null until a login is proven. */
  readonly secretId: string | null
  readonly enabled: boolean
  readonly lastLoginAt: Date | null
  readonly lastUsedAt: Date | null
  readonly lastExercisedAt: Date | null
  readonly coolingOffUntil: Date | null
  readonly lastFailureReason: string | null
  readonly archivedAt: Date | null
  readonly createdAt: Date
  /**
   * Whether a run could be given this seat right now, computed **in the database** by
   * {@link selectableCredentialCondition}.
   *
   * Not derived in TypeScript from the fields above, deliberately. A second implementation of the
   * predicate would agree with the first until somebody changed one of them, and the disagreement
   * would surface as a panel reporting capacity the allocator cannot see — or, in the direction
   * that matters, as a panel reporting a seat as withheld while the allocator hands it out.
   */
  readonly selectable: boolean
}

/** The credential columns the pool view reads, plus whether the seat may be selected. Not `select *`. */
const agentCredentialListingColumns = {
  id: agentCredentials.id,
  credentialGroupId: agentCredentials.credentialGroupId,
  credentialGroupName: credentialGroups.name,
  credentialGroupEnabled: credentialGroups.enabled,
  name: agentCredentials.name,
  state: agentCredentials.state,
  secretId: agentCredentials.secretId,
  enabled: agentCredentials.enabled,
  lastLoginAt: agentCredentials.lastLoginAt,
  lastUsedAt: agentCredentials.lastUsedAt,
  lastExercisedAt: agentCredentials.lastExercisedAt,
  coolingOffUntil: agentCredentials.coolingOffUntil,
  lastFailureReason: agentCredentials.lastFailureReason,
  archivedAt: agentCredentials.archivedAt,
  createdAt: agentCredentials.createdAt,
  selectable: sql<boolean>`${selectableCredentialCondition()}`,
} as const

/** What the credential list is filtered by. */
export interface ListAgentCredentialsQuery {
  readonly credentialGroupId?: string
  readonly includeArchived: boolean
  readonly limit: number
  readonly cursor?: string
}

/**
 * A page of credentials with their group, and whether each may be selected.
 *
 * Keyset paginated on the primary key, like every other listing here: ids are UUID v7, so byte
 * order is creation order and `id desc` is newest-first without a second sort column.
 */
export const listAgentCredentials = async (
  writer: CredentialStoreWriter,
  query: ListAgentCredentialsQuery,
): Promise<Page<AgentCredentialListing>> => {
  const filters = [
    query.credentialGroupId === undefined
      ? undefined
      : eq(agentCredentials.credentialGroupId, query.credentialGroupId),
    query.includeArchived ? undefined : isNull(agentCredentials.archivedAt),
    query.cursor === undefined ? undefined : lt(agentCredentials.id, query.cursor),
  ].filter((filter) => filter !== undefined)

  const rows = await writer
    .select(agentCredentialListingColumns)
    .from(agentCredentials)
    .innerJoin(credentialGroups, eq(agentCredentials.credentialGroupId, credentialGroups.id))
    .where(filters.length === 0 ? undefined : and(...filters))
    .orderBy(desc(agentCredentials.id))
    .limit(query.limit + 1)

  return toPage(rows, query.limit)
}

/**
 * **The selection candidate query — what an allocator draws from.**
 *
 * It exists in Phase 4, before anything allocates, for one reason: "a credential in
 * `awaiting_login` is never selectable" is a claim about the set a selector can see, and the only
 * honest way to assert it is to ask that set. A test that instead checked the credential's `state`
 * column after registration would be asserting a symptom — it would still pass against an allocator
 * that read `state` and ignored `secret_id`, or one that ignored the group's `enabled` flag.
 *
 * Ordered by {@link agentCredentials.lastUsedAt} ascending with nulls first, which is FR-034's
 * least-recently-used rule and puts a never-used seat at the front where it belongs. Ranking
 * *between* groups is FR-064's, and belongs to the allocator that knows the profile's preference
 * order — this answers "which seats in these groups are usable, least-recently-used first" and
 * stops there.
 *
 * @param credentialGroupIds - The groups to draw from. An empty list selects nothing, which is the
 *   correct answer for a profile with no attachments rather than a reason to return everything.
 */
export const listSelectableCredentials = async (
  writer: CredentialStoreWriter,
  credentialGroupIds: readonly string[],
): Promise<readonly AgentCredentialListing[]> => {
  if (credentialGroupIds.length === 0) {
    return []
  }

  return writer
    .select(agentCredentialListingColumns)
    .from(agentCredentials)
    .innerJoin(credentialGroups, eq(agentCredentials.credentialGroupId, credentialGroups.id))
    .where(
      and(
        inArray(agentCredentials.credentialGroupId, [...credentialGroupIds]),
        selectableCredentialCondition(),
      ),
    )
    .orderBy(sql`${agentCredentials.lastUsedAt} asc nulls first`, asc(agentCredentials.id))
}

/** One credential by id, or `undefined`. */
export const findAgentCredential = async (
  writer: CredentialStoreWriter,
  agentCredentialId: string,
): Promise<AgentCredential | undefined> =>
  firstRow(
    await writer
      .select()
      .from(agentCredentials)
      .where(eq(agentCredentials.id, agentCredentialId))
      .limit(1),
  )

/** One credential as the pool view renders it, or `undefined`. */
export const findAgentCredentialListing = async (
  writer: CredentialStoreWriter,
  agentCredentialId: string,
): Promise<AgentCredentialListing | undefined> =>
  firstRow(
    await writer
      .select(agentCredentialListingColumns)
      .from(agentCredentials)
      .innerJoin(credentialGroups, eq(agentCredentials.credentialGroupId, credentialGroups.id))
      .where(eq(agentCredentials.id, agentCredentialId))
      .limit(1),
  )

/**
 * One credential by name, or `undefined`.
 *
 * `agent_credentials.name` is `citext`, so this comparison is case-insensitive **in the database**
 * and matches `agent_credentials_name_key` exactly — same argument as
 * {@link findCredentialGroupByName}: lower-casing in JavaScript would agree with the index for
 * ASCII and disagree for anything else, turning a named refusal into a duplicate-key error.
 */
export const findAgentCredentialByName = async (
  writer: CredentialStoreWriter,
  name: string,
): Promise<AgentCredential | undefined> =>
  firstRow(
    await writer.select().from(agentCredentials).where(eq(agentCredentials.name, name)).limit(1),
  )

export interface InsertAgentCredentialInput {
  readonly name: string
  readonly credentialGroupId: string
  readonly createdByUserId: string
}

/**
 * Register a seat (FR-061, FR-008).
 *
 * **`state` and `secret_id` are set here and are not parameters.** Every registration starts in
 * `awaiting_login` with no secret, because that pair is what makes a credential unselectable by
 * every path at once — the state keeps it out of the selection predicate, and the null `secret_id`
 * means there would be nothing to fetch even if something reached past it. A caller able to choose
 * either could register a credential straight into `available`, which is the exact outcome FR-008
 * forbids, and no amount of validation in the router would make that signature safe.
 *
 * `enabled` defaults to true, matching {@link insertCredentialGroup}: the gate on a new seat is its
 * state, not a second flag somebody has to remember to flip.
 */
export const insertAgentCredential = async (
  writer: CredentialStoreWriter,
  input: InsertAgentCredentialInput,
): Promise<AgentCredential> => {
  const row = firstRow(
    await writer
      .insert(agentCredentials)
      .values({
        name: input.name,
        credentialGroupId: input.credentialGroupId,
        state: 'awaiting_login',
        secretId: null,
        createdByUserId: input.createdByUserId,
      })
      .returning(),
  )

  if (row === undefined) {
    throw new Error('Inserting an agent credential returned no row.')
  }
  return row
}

/**
 * How many leases have **ever** referenced this credential — the FR-005 delete gate.
 *
 * Every lease, not merely the live ones, and that is the whole requirement: FR-005 refuses deletion
 * of a credential *any workflow has used*, so that historical attribution survives. A count of live
 * leases would report a seat as deletable the moment its run finished, and deleting it would either
 * break the foreign key on `credential_leases.agent_credential_id` or, worse, succeed and leave a
 * finished run unable to say what identity it worked as.
 */
export const countLeasesForCredential = async (
  writer: CredentialStoreWriter,
  agentCredentialId: string,
): Promise<number> => {
  const row = firstRow(
    await writer
      .select({ total: sql<number>`count(*)::int` })
      .from(credentialLeases)
      .where(eq(credentialLeases.agentCredentialId, agentCredentialId)),
  )

  return row?.total ?? 0
}

/** Credentials this one run is holding right now. At most one, by `credential_leases_live_key`. */
export const countLiveLeasesForCredential = async (
  writer: CredentialStoreWriter,
  agentCredentialId: string,
): Promise<number> => {
  const row = firstRow(
    await writer
      .select({ total: sql<number>`count(*)::int` })
      .from(credentialLeases)
      .where(
        and(
          eq(credentialLeases.agentCredentialId, agentCredentialId),
          isNull(credentialLeases.releasedAt),
        ),
      ),
  )

  return row?.total ?? 0
}

/** The live lease on one seat, as a force-release needs to see it. */
export interface LiveLeaseReference {
  readonly leaseId: string
  /** The run holding the seat. The whole reason this query exists rather than a count. */
  readonly workflowId: string
  /** The fence the holder was issued. The next acquisition raises the credential's above it. */
  readonly fence: number
  readonly acquiredAt: Date
}

/**
 * The one live lease on a credential, or `undefined` (FR-057).
 *
 * `credential_leases_live_key` — the partial unique index on `(agent_credential_id) WHERE
 * released_at IS NULL` — is what makes "the" correct rather than "a": at most one such row can
 * exist, and that index is the exclusivity guarantee itself rather than a hint about it.
 *
 * Distinct from {@link countLiveLeasesForCredential}, which answers "is anybody on this seat" for
 * the FR-006 disable path and deliberately says nothing about who. A force-release has to name the
 * run, because resolving that run to a recorded state is half of what FR-057 asks for — and a
 * caller that guessed the workflow from somewhere else could end somebody else's run.
 */
export const findLiveLeaseForCredential = async (
  writer: CredentialStoreWriter,
  agentCredentialId: string,
): Promise<LiveLeaseReference | undefined> =>
  firstRow(
    await writer
      .select({
        leaseId: credentialLeases.id,
        workflowId: credentialLeases.workflowId,
        fence: credentialLeases.fence,
        acquiredAt: credentialLeases.acquiredAt,
      })
      .from(credentialLeases)
      .where(
        and(
          eq(credentialLeases.agentCredentialId, agentCredentialId),
          isNull(credentialLeases.releasedAt),
        ),
      )
      .limit(1),
  )

export interface RecordLoginInput {
  /** The identifier the secret store filed the captured material under. A name, never a value. */
  readonly secretId: string
  readonly lastLoginAt: Date
}

/**
 * The states a login may complete from — first login, and re-login on a broken seat (FR-010,
 * FR-072).
 *
 * Exported because the router refuses out of it and {@link recordAgentCredentialLogin} writes
 * conditional on it, and a second copy is how the two would come to disagree about whether a
 * `cooling_off` seat may be logged in. It is deliberately **not** every non-`held` state: a seat
 * that is `available` already works, and re-logging it in would replace material the pool is about
 * to hand out for no stated reason. `cooling_off` is excluded for the same kind of reason — it
 * recovers by itself (FR-076), and a login started against it would race that recovery.
 */
export const LOGIN_ENTRY_STATES = ['awaiting_login', 'unhealthy'] as const

/**
 * Point a credential at its captured material and make it selectable — the one write that moves a
 * seat into `available` (FR-008, FR-070).
 *
 * **A narrow writer rather than a field on {@link UpdateAgentCredentialFields}, and conditional on
 * the states it expects.** `state` and `secret_id` are excluded from the general-purpose setter for
 * the reasons given there, and this function is the exception that proves them: it is allowed to
 * write both precisely because it writes them together and only from a state a login can complete
 * from.
 *
 * The `AND state IN (…)` is load-bearing rather than defensive. Without it, a capture landing while
 * the credential is `held` would flip a seat a run is currently authenticated as back to
 * `available` — and the next acquisition would hand that same identity to a second run, which is
 * the double-use this entire feature exists to prevent. The caller checks the state first so an
 * administrator gets a sentence rather than a silent no-op; this condition is what makes the check
 * unnecessary for correctness, because a concurrent acquisition between the read and this write
 * would otherwise slip through.
 *
 * `last_failure_reason` is cleared in the same statement. It describes why the credential was
 * unusable, and leaving it against a seat that now works would put a stale explanation in front of
 * the next administrator looking at the pool (FR-009).
 *
 * @returns The updated row, or `undefined` when the credential was not in a state a login completes
 *   from — which the caller must treat as a refusal and not as a missing row.
 */
export const recordAgentCredentialLogin = async (
  writer: CredentialStoreWriter,
  agentCredentialId: string,
  input: RecordLoginInput,
): Promise<AgentCredential | undefined> =>
  firstRow(
    await writer
      .update(agentCredentials)
      .set({
        secretId: input.secretId,
        state: 'available',
        lastLoginAt: input.lastLoginAt,
        lastFailureReason: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentCredentials.id, agentCredentialId),
          inArray(agentCredentials.state, [...LOGIN_ENTRY_STATES]),
        ),
      )
      .returning(),
  )

/**
 * Write why a login could not be completed, without touching anything else (FR-009).
 *
 * Separate from {@link updateAgentCredential} because it is the one column an *unsuccessful*
 * administrative act writes, and separate from {@link recordAgentCredentialLogin} because a failure
 * must move no state: the seat stays exactly where it was — unselectable if it was unselectable —
 * and gains a sentence saying why. A failure path that also wrote `state` would be a second way for
 * a login to change what the pool may hand out, and there must be exactly one.
 *
 * The reason is a **reason and never material**; every caller of this function passes a fixed
 * sentence or a store's own error text, and `credentials.test.ts` scans the rendered value.
 */
export const recordAgentCredentialLoginFailure = async (
  writer: CredentialStoreWriter,
  agentCredentialId: string,
  reason: string,
): Promise<AgentCredential | undefined> =>
  firstRow(
    await writer
      .update(agentCredentials)
      .set({ lastFailureReason: reason, updatedAt: new Date() })
      .where(eq(agentCredentials.id, agentCredentialId))
      .returning(),
  )

export interface UpdateAgentCredentialFields {
  readonly name?: string
  /** Moving a credential between groups. Exactly one group at all times (FR-061). */
  readonly credentialGroupId?: string
  readonly enabled?: boolean
  /** The soft delete: a credential any workflow has used is never hard-deleted (FR-005). */
  readonly archivedAt?: Date | null
}

/**
 * Update a credential's administrative fields.
 *
 * **`state`, `fence`, `held_by` and `secret_id` are deliberately absent from
 * {@link UpdateAgentCredentialFields}.** Those four are the leasing protocol's, not an
 * administrator's: `state` and `held_by` only ever move under the conditional
 * `UPDATE … WHERE state = 'available'` that resolves the FR-038 race, and `fence` only ever moves
 * with an acquisition. A general-purpose setter reaching them would be a path by which a panel
 * request could overwrite a claim a workflow already holds, and the resulting double-use is the one
 * failure this whole feature exists to prevent. The phases that own those transitions add their own
 * narrow writers.
 */
export const updateAgentCredential = async (
  writer: CredentialStoreWriter,
  agentCredentialId: string,
  fields: UpdateAgentCredentialFields,
): Promise<AgentCredential | undefined> =>
  firstRow(
    await writer
      .update(agentCredentials)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(agentCredentials.id, agentCredentialId))
      .returning(),
  )

// ---------------------------------------------------------------------------------------------
// Profile attachments
// ---------------------------------------------------------------------------------------------

/**
 * One attachment as the profile editor renders it (FR-062).
 *
 * Carries the group's `enabled` flag as well as its name, because a profile whose only attached
 * group is disabled has capacity on paper and none in practice — and an editor that showed the
 * attachment without the flag would make that indistinguishable from a working configuration.
 */
export interface ProfileCredentialGroupAttachment {
  readonly id: string
  readonly credentialGroupId: string
  readonly name: string
  readonly enabled: boolean
  readonly archivedAt: Date | null
  readonly position: number
}

/**
 * A profile's attached groups, in preference order (FR-062, FR-064).
 *
 * `position` ascending is the order selection walks: first attached group with an available
 * credential wins, and LRU decides within it. Ordering here rather than leaving it to the caller
 * means "preference order" has one definition in the codebase.
 */
export const readProfileCredentialGroups = async (
  writer: CredentialStoreWriter,
  executionProfileId: string,
): Promise<readonly ProfileCredentialGroupAttachment[]> =>
  writer
    .select({
      id: profileCredentialGroups.id,
      credentialGroupId: profileCredentialGroups.credentialGroupId,
      name: credentialGroups.name,
      enabled: credentialGroups.enabled,
      archivedAt: credentialGroups.archivedAt,
      position: profileCredentialGroups.position,
    })
    .from(profileCredentialGroups)
    .innerJoin(credentialGroups, eq(profileCredentialGroups.credentialGroupId, credentialGroups.id))
    .where(eq(profileCredentialGroups.executionProfileId, executionProfileId))
    .orderBy(asc(profileCredentialGroups.position))

/**
 * Rewrite a profile's attachment positions to `1..n` in the order given, **without the unique index
 * ever being violated in between**.
 *
 * `profile_credential_groups_position_key` is a plain unique index, so it cannot be deferred to
 * commit: Postgres checks it as each row is written, and the order rows are written in inside a
 * single multi-row `UPDATE` is not something the statement's author chooses. That rules out the
 * obvious implementations. `set position = position + 1` fails the moment the row moving into slot
 * 3 is written before the row currently sitting there has moved out; assigning final positions
 * one row at a time fails for the same reason whenever the new order overlaps the old, which is
 * every reorder that is not a pure append.
 *
 * So this is two passes, and the first one is the whole trick:
 *
 * 1. **Park.** One statement moves every attachment of this profile to `-position - 1`. The
 *    mapping is injective, and every value it produces is negative while every value it replaces
 *    is positive, so no row it writes can collide with a row it has already written or with one it
 *    has yet to write — whatever order the executor picks.
 * 2. **Place.** Each row is then written to its final position, which is `>= 1`. Every row still
 *    parked is negative, so again there is nothing for a new value to collide with.
 *
 * The `- 1` looks superfluous next to 1-based positions and is kept on purpose: it makes the
 * negation total, so a row that somehow reached position `0` still parks somewhere negative rather
 * than staying exactly where it was.
 *
 * @param orderedCredentialGroupIds - The group ids in their new preference order. Must be exactly
 *   the set already attached to this profile; the caller validates that, because "you left one out"
 *   is a refusal an administrator needs worded, not an invariant this function can restore.
 */
const renumberAttachments = async (
  writer: CredentialStoreWriter,
  executionProfileId: string,
  orderedCredentialGroupIds: readonly string[],
): Promise<void> => {
  await writer
    .update(profileCredentialGroups)
    .set({ position: sql`-${profileCredentialGroups.position} - 1` })
    .where(eq(profileCredentialGroups.executionProfileId, executionProfileId))

  for (const [index, credentialGroupId] of orderedCredentialGroupIds.entries()) {
    await writer
      .update(profileCredentialGroups)
      .set({ position: index + 1 })
      .where(
        and(
          eq(profileCredentialGroups.executionProfileId, executionProfileId),
          eq(profileCredentialGroups.credentialGroupId, credentialGroupId),
        ),
      )
  }
}

/**
 * Attach a group to a profile at the end of its preference order (FR-062).
 *
 * Appended rather than inserted at a chosen position: an administrator adding a fallback pool
 * almost always wants it tried last, and the one who wants it first reorders — which is one
 * explicit act with its own audit entry rather than a position argument whose meaning depends on
 * what was already there.
 *
 * @returns The new attachment, or `undefined` when the group is already attached. A duplicate is a
 *   repeated request rather than an error — the same reading `grants.grant` takes — and the caller
 *   distinguishes the two so it can skip writing a second audit entry for a change that did not
 *   happen.
 */
export const attachCredentialGroup = async (
  writer: CredentialStoreWriter,
  input: { readonly executionProfileId: string; readonly credentialGroupId: string },
): Promise<ProfileCredentialGroupAttachment | undefined> => {
  const attached = await readProfileCredentialGroups(writer, input.executionProfileId)

  if (attached.some((row) => row.credentialGroupId === input.credentialGroupId)) {
    return undefined
  }

  const inserted = firstRow(
    await writer
      .insert(profileCredentialGroups)
      .values({
        executionProfileId: input.executionProfileId,
        credentialGroupId: input.credentialGroupId,
        position: attached.length + 1,
      })
      .returning({ id: profileCredentialGroups.id }),
  )

  if (inserted === undefined) {
    throw new Error('Attaching a credential group returned no row.')
  }

  const group = await findCredentialGroup(writer, input.credentialGroupId)
  if (group === undefined) {
    // Unreachable: the insert above holds a foreign key onto this row.
    throw new Error('Attaching a credential group referenced a group that does not exist.')
  }

  return {
    id: inserted.id,
    credentialGroupId: group.id,
    name: group.name,
    enabled: group.enabled,
    archivedAt: group.archivedAt,
    position: attached.length + 1,
  }
}

/**
 * Detach a group from a profile and close the gap it leaves.
 *
 * The remaining attachments are renumbered rather than left with a hole, so `1..n` continues to
 * hold and second preference is still called second. Closing the gap has the same
 * write-ordering hazard as a reorder — decrementing every position above the removed one collides
 * the instant two rows are written in the wrong order — so it goes through the same
 * {@link renumberAttachments} rather than through an `UPDATE … SET position = position - 1` that
 * would work until it did not.
 *
 * @returns The remaining attachments in their new order, or `undefined` when the group was not
 *   attached in the first place.
 */
export const detachCredentialGroup = async (
  writer: CredentialStoreWriter,
  input: { readonly executionProfileId: string; readonly credentialGroupId: string },
): Promise<readonly ProfileCredentialGroupAttachment[] | undefined> => {
  const attached = await readProfileCredentialGroups(writer, input.executionProfileId)

  if (!attached.some((row) => row.credentialGroupId === input.credentialGroupId)) {
    return undefined
  }

  await writer
    .delete(profileCredentialGroups)
    .where(
      and(
        eq(profileCredentialGroups.executionProfileId, input.executionProfileId),
        eq(profileCredentialGroups.credentialGroupId, input.credentialGroupId),
      ),
    )

  await renumberAttachments(
    writer,
    input.executionProfileId,
    attached
      .filter((row) => row.credentialGroupId !== input.credentialGroupId)
      .map((row) => row.credentialGroupId),
  )

  return readProfileCredentialGroups(writer, input.executionProfileId)
}

/**
 * Put a profile's attachments into the order given (FR-062).
 *
 * @param orderedCredentialGroupIds - Every currently attached group, exactly once, in its new
 *   preference order. Validated by the caller.
 */
export const reorderCredentialGroups = async (
  writer: CredentialStoreWriter,
  executionProfileId: string,
  orderedCredentialGroupIds: readonly string[],
): Promise<readonly ProfileCredentialGroupAttachment[]> => {
  await renumberAttachments(writer, executionProfileId, orderedCredentialGroupIds)
  return readProfileCredentialGroups(writer, executionProfileId)
}

// ---------------------------------------------------------------------------------------------
// The pool view (FR-053, FR-054, FR-055, FR-074)
// ---------------------------------------------------------------------------------------------

/**
 * **Three reads, and none of them touches a table this feature invented for reporting.**
 *
 * The pool view is the one screen that has to answer "should we buy another seat", and the
 * temptation on a screen like that is to keep a summary somewhere — a per-group counter, a queue
 * table, a per-credential spend ledger — so the page is one `SELECT`. Every one of those would be a
 * second source of truth for something the rows below already know, and the failure mode is not a
 * slow page but a **wrong** one: a counter that drifted says a group has capacity it does not, and
 * the decision the screen exists to support is then made on a number nobody can reconcile.
 *
 * So the three reads are:
 *
 * 1. {@link readCredentialPool} — one row per seat, with its group, its live lease and the state of
 *    the workflow holding it. The holder breakdown FR-074 asks for is *this* join, not a column.
 * 2. {@link readCredentialQueueByGroup} and {@link readCredentialQueueTotals} — the FR-054 queue,
 *    derived from `workflows` in `awaiting_credential`. See their own notes.
 * 3. {@link readCredentialConsumption} — FR-055 spend, aggregated through
 *    `workflows.agent_credential_id`.
 *
 * All three are reads. Nothing in this section writes, and that is worth stating: a reporting query
 * that repaired what it found would make the pool's state depend on somebody having the page open.
 */

/**
 * One seat as the pool view reads it, **before** any of it is interpreted (FR-053, FR-074).
 *
 * Deliberately flat and deliberately raw. The two facts an administrator actually acts on — what
 * kind of holder this is, and whether the seat is healthy — are derived from these columns by pure
 * functions in `credential-pool.ts`, so they can be tested against every combination without a
 * database. What is *not* derived in TypeScript is {@link CredentialPoolRow.selectable}: that comes
 * from {@link selectableCredentialCondition} evaluated in the database, for the reason given on
 * {@link AgentCredentialListing.selectable}.
 *
 * `hasSecret` rather than `secretId`. Whether a login has been captured is what the pool view needs
 * — a seat with nowhere to fetch material from is not capacity (FR-008) — and the identifier itself
 * belongs on the credential's own page, where an administrator is looking at one seat rather than
 * at every seat on the platform. It is a name and never material either way (FR-011); this is about
 * not putting a hundred secret names on one screen that has no use for them.
 */
export interface CredentialPoolRow {
  readonly id: string
  readonly credentialGroupId: string
  readonly credentialGroupName: string
  readonly credentialGroupEnabled: boolean
  readonly name: string
  readonly state: CredentialState
  readonly enabled: boolean
  readonly selectable: boolean
  /** Whether a login has been captured for this seat. Never the identifier, never the material. */
  readonly hasSecret: boolean
  /** `workflow` | `keep_alive` while `state = 'held'`; null otherwise. The FR-074 discriminator. */
  readonly heldBy: string | null
  readonly lastUsedAt: Date | null
  readonly lastExercisedAt: Date | null
  readonly lastLoginAt: Date | null
  readonly coolingOffUntil: Date | null
  readonly lastFailureReason: string | null
  readonly archivedAt: Date | null
  /** The run holding it under a **live** lease, or null. Null for a keep-alive: it has no workflow. */
  readonly holderWorkflowId: string | null
  readonly holderWorkflowState: WorkflowState | null
  /** When the live lease was taken — what hold duration is measured from (FR-053). */
  readonly holderAcquiredAt: Date | null
}

/** The pool columns, plus the database's own verdict on whether a seat may be selected. Not `select *`. */
const credentialPoolColumns = {
  id: agentCredentials.id,
  credentialGroupId: agentCredentials.credentialGroupId,
  credentialGroupName: credentialGroups.name,
  credentialGroupEnabled: credentialGroups.enabled,
  name: agentCredentials.name,
  state: agentCredentials.state,
  enabled: agentCredentials.enabled,
  selectable: sql<boolean>`${selectableCredentialCondition()}`,
  hasSecret: sql<boolean>`${agentCredentials.secretId} is not null`,
  heldBy: agentCredentials.heldBy,
  lastUsedAt: agentCredentials.lastUsedAt,
  lastExercisedAt: agentCredentials.lastExercisedAt,
  lastLoginAt: agentCredentials.lastLoginAt,
  coolingOffUntil: agentCredentials.coolingOffUntil,
  lastFailureReason: agentCredentials.lastFailureReason,
  archivedAt: agentCredentials.archivedAt,
  holderWorkflowId: credentialLeases.workflowId,
  holderWorkflowState: workflows.state,
  holderAcquiredAt: credentialLeases.acquiredAt,
} as const

/**
 * Every seat, with its group and whatever is holding it (FR-053, FR-074).
 *
 * **The lease join is `LEFT` and partial on `released_at is null`, and both halves matter.** Left,
 * because most seats are free and an inner join would return only the busy ones — which is the
 * shape that makes an exhausted pool and an idle one look identical. Partial on the live predicate,
 * because a seat is legitimately leased many times over its life and joining on all of them would
 * multiply each seat by its own history; the predicate is the same one `credential_leases_live_key`
 * is partial on, so this query and the exclusivity index cannot disagree about what a live lease is.
 *
 * The workflow join hangs off the lease and is left for the same reason — and it is what turns
 * FR-074 from a column somebody would have to remember to write into a fact about the run: a parked
 * holder is a live lease whose workflow is in `parked_resumable`, which is true whether or not
 * anything told the credential so.
 *
 * Not paginated, unlike {@link listAgentCredentials}. The pool is bounded by how many identities an
 * organisation has bought, the whole point of the screen is the totals per group, and a page-two
 * that changed the answer to "is this group under-sized" would be worse than a long page.
 *
 * @param options - `includeArchived` keeps FR-005's archived seats in the result. Off by default:
 *   an archived credential is a historical record, not capacity, and counting it as capacity is the
 *   specific way this screen could lie about how many seats exist.
 */
export const readCredentialPool = async (
  writer: CredentialStoreWriter,
  options: { readonly includeArchived: boolean } = { includeArchived: false },
): Promise<readonly CredentialPoolRow[]> =>
  writer
    .select(credentialPoolColumns)
    .from(agentCredentials)
    .innerJoin(credentialGroups, eq(agentCredentials.credentialGroupId, credentialGroups.id))
    .leftJoin(
      credentialLeases,
      and(
        eq(credentialLeases.agentCredentialId, agentCredentials.id),
        isNull(credentialLeases.releasedAt),
      ),
    )
    .leftJoin(workflows, eq(workflows.id, credentialLeases.workflowId))
    .where(options.includeArchived ? undefined : isNull(agentCredentials.archivedAt))
    .orderBy(asc(credentialGroups.name), asc(agentCredentials.name))

/**
 * The groups the pool view is laid out by — **every one of them, including the empty ones**.
 *
 * The spine of the view is the group list rather than the credentials, and that is not a
 * presentation choice. A group with zero seats and three runs waiting on it is the most under-sized
 * a group can possibly be, and it contributes no row to {@link readCredentialPool} at all; a view
 * assembled from seats outward would omit exactly the group an administrator most needs to see.
 *
 * Archived groups are excluded. They hold no capacity by definition — FR-066 refuses to archive a
 * group that still holds a credential — so a row for one would be a permanently empty line.
 */
export const readPoolCredentialGroups = async (
  writer: CredentialStoreWriter,
): Promise<readonly Pick<CredentialGroup, 'id' | 'name' | 'enabled'>[]> =>
  writer
    .select({
      id: credentialGroups.id,
      name: credentialGroups.name,
      enabled: credentialGroups.enabled,
    })
    .from(credentialGroups)
    .where(isNull(credentialGroups.archivedAt))
    .orderBy(asc(credentialGroups.name))

/** How many runs are waiting on one group, and since when (FR-054). */
export interface CredentialQueueRow {
  readonly credentialGroupId: string
  readonly depth: number
  /** The oldest waiting run's `created_at` — what the longest current wait is measured from. */
  readonly waitingSince: Date
}

/**
 * **The FR-054 queue, per group — derived, because there is no queue table and there must not be.**
 *
 * The waiting set is `workflows` in `awaiting_credential`, joined to the credential groups its
 * execution profile is attached to. data-model.md states the rule: a table would be a second source
 * of truth for something the workflow row already knows, and it would need reconciling against that
 * row every time a run ended in a way the queue did not observe — a cancelled run, a failed
 * admission, a reconciliation sweep. Every one of those would leave a phantom in the queue, and a
 * phantom in *this* queue is a purchase order for a seat nobody needed.
 *
 * `workflows_awaiting_credential_idx` is partial on the state precisely so this scan reads the rows
 * that are waiting and nothing else.
 *
 * **A waiting run is counted against every group its profile is attached to, so these depths do not
 * sum to the platform total.** That is the honest arithmetic rather than a rounding error: a run
 * whose profile attaches to two groups is waiting on both, and would start the moment either freed
 * a seat. Charging it to its first-preference group alone would understate the second's pressure;
 * splitting it fractionally would produce a queue depth of 0.5, which is not a thing an
 * administrator can buy a seat against. {@link readCredentialQueueTotals} gives the distinct count
 * separately, and `credential-pool.ts` reports the two as different figures for that reason.
 */
export const readCredentialQueueByGroup = async (
  writer: CredentialStoreWriter,
): Promise<readonly CredentialQueueRow[]> =>
  writer
    .select({
      credentialGroupId: profileCredentialGroups.credentialGroupId,
      depth: sql<number>`count(distinct ${workflows.id})::int`,
      /**
       * `mapWith` is not decoration. A bare `sql` fragment carries no column mapper, so the driver
       * hands back `timestamptz` as the string it arrived as and every duration computed from it is
       * `NaN` — silently, because subtracting a string produces a number-shaped nothing. Mapping it
       * through the column it aggregates makes the aggregate the same type the column is.
       */
      waitingSince: sql`min(${workflows.createdAt})`.mapWith(workflows.createdAt),
    })
    .from(workflows)
    .innerJoin(
      profileCredentialGroups,
      eq(profileCredentialGroups.executionProfileId, workflows.executionProfileId),
    )
    .where(eq(workflows.state, 'awaiting_credential'))
    .groupBy(profileCredentialGroups.credentialGroupId)

/** The whole platform's waiting set, counted once per run (FR-054). */
export interface CredentialQueueTotals {
  /** Distinct waiting runs. Never the sum of the per-group depths — see the note on the group read. */
  readonly depth: number
  readonly waitingSince: Date | null
  /**
   * Waiting runs that belong to **no** group's queue, because they were launched without an
   * execution profile.
   *
   * Reported rather than folded in, because it is a different problem with a different remedy. A
   * run waiting on a group is waiting on capacity somebody can buy; an ad hoc run with no profile is
   * attached to no group at all (FR-126 allows the launch, FR-063 gives it nothing to draw on), and
   * no amount of extra capacity clears it. Adding it to a group's depth would send an administrator
   * to buy a seat that the run could not have been given.
   */
  readonly unattributableDepth: number
}

/** Read the platform-wide waiting figures. */
export const readCredentialQueueTotals = async (
  writer: CredentialStoreWriter,
): Promise<CredentialQueueTotals> => {
  const row = firstRow(
    await writer
      .select({
        depth: sql<number>`count(*)::int`,
        /** Mapped through the column, for the reason given on the per-group read. */
        waitingSince: sql`min(${workflows.createdAt})`.mapWith(workflows.createdAt),
        unattributableDepth: sql<number>`(count(*) filter (where ${workflows.executionProfileId} is null))::int`,
      })
      .from(workflows)
      .where(eq(workflows.state, 'awaiting_credential')),
  )

  return {
    depth: row?.depth ?? 0,
    waitingSince: row?.waitingSince ?? null,
    unattributableDepth: row?.unattributableDepth ?? 0,
  }
}

/** What one agent credential has consumed, across every run that used it (FR-055). */
export interface CredentialConsumptionRow {
  readonly agentCredentialId: string
  /** Runs that named this credential, terminal ones included — spend does not stop mattering. */
  readonly workflowCount: number
  readonly turnsUsed: number
  /** Inference spend, as `numeric(12,4)` renders it. A string, never a float. */
  readonly spendUsed: string
  /** Compute charged to those runs (FR-041), reported beside inference and never blended into it. */
  readonly computeCostBasis: string
}

/**
 * **Per-credential consumption, by joining through `workflows.agent_credential_id` — FR-055 with no
 * second ledger, and therefore no drift.**
 *
 * 002 already accrues `turns_used`, `spend_used` and `compute_cost_basis` on the workflow row, and
 * 003 records which identity each run worked as on that same row (FR-059). "What has this seat
 * cost" is therefore a `GROUP BY` over columns that already exist. The alternative — accruing a
 * per-credential total as runs report consumption — would be a second copy of a number the first
 * copy is still updating, and the two would diverge on exactly the events that are hardest to
 * replay: a run that failed mid-report, a successor workflow inheriting a chain (FR-152), a
 * correction applied to `spend_used` after the fact.
 *
 * The money columns are `numeric(12,4)` and the sum is cast back to the same type before it leaves
 * the database. Summing into a float would introduce error in the third decimal place of a figure
 * whose entire purpose is to be reconciled against an invoice.
 *
 * `coalesce` on all four aggregates: a seat that has been logged in and never used has consumed
 * nothing, and the honest report of that is `0`, not an absent row the caller has to remember to
 * default. Credentials with no runs simply do not appear here, and the assembler defaults them.
 *
 * @param agentCredentialIds - The seats to report. Empty selects nothing, which is the right answer
 *   for an empty pool rather than a reason to aggregate the whole `workflows` table.
 */
export const readCredentialConsumption = async (
  writer: CredentialStoreWriter,
  agentCredentialIds: readonly string[],
): Promise<readonly CredentialConsumptionRow[]> => {
  if (agentCredentialIds.length === 0) {
    return []
  }

  return writer
    .select({
      agentCredentialId: sql<string>`${workflows.agentCredentialId}`,
      workflowCount: sql<number>`count(*)::int`,
      turnsUsed: sql<number>`coalesce(sum(${workflows.turnsUsed}), 0)::int`,
      spendUsed: sql<string>`coalesce(sum(${workflows.spendUsed}), 0)::numeric(12,4)`,
      computeCostBasis: sql<string>`coalesce(sum(${workflows.computeCostBasis}), 0)::numeric(12,4)`,
    })
    .from(workflows)
    .where(inArray(workflows.agentCredentialId, [...agentCredentialIds]))
    .groupBy(workflows.agentCredentialId)
}
