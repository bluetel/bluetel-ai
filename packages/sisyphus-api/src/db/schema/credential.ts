import { sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { boolean, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

import {
  bigIntColumn,
  citext,
  createdAtColumn,
  idColumn,
  timestampColumn,
  updatedAtColumn,
} from './columns'
import { credentialReleaseReasonEnum, credentialStateEnum } from './enums'
import { users } from './identity'
import { executionProfiles } from './profile'
import { workflows } from './workflow'

/**
 * The agent credential pool — the identities the platform can work as, the capacity groups that
 * scope them to execution profiles, and the leases that hand exactly one of them to exactly one
 * run at a time.
 *
 * **Nothing in this file holds credential material, and that is a rule about columns rather than
 * about care.** 002's convention is "payloads are not in Postgres"; this feature extends it
 * (FR-011): the material lives in AWS Secrets Manager and Postgres stores only
 * `agent_credentials.secret_id`, the identifier under which it is filed. There is no column here a
 * token could be put in without the column being obviously new, which is what
 * `credential.test.ts` asserts programmatically rather than leaving to review.
 *
 * **The tables name no agent vendor** (FR-003). Which backend a credential authenticates against
 * is configuration behind 002's agent adapter boundary; that boundary exists so the backend stays
 * swappable, and spending it on a column name here would buy nothing.
 *
 * The correctness of the whole feature reduces to one partial unique index on
 * {@link credentialLeases} — see its own note. Everything else in this file is bookkeeping around
 * that guarantee.
 */

/**
 * The unit by which capacity is reserved for a set of execution profiles (FR-060).
 *
 * A group is how an administrator says "these runs draw from these identities". It is the thing
 * profiles attach to rather than the credentials themselves, so that adding a credential to a pool
 * is one write instead of one write per profile that should be able to see it — and so that
 * capacity can be reasoned about at the size a human actually thinks in.
 *
 * Never hard-deleted while it holds a credential or is attached to a profile; the refusal names
 * which of the two conditions applies (FR-066). `enabled` is the alternative that is always
 * available: disabling withholds **every** member from future selection without evicting anything
 * currently running, which is FR-006 applied group-wide.
 */
export const credentialGroups = pgTable(
  'credential_groups',
  {
    id: idColumn(),
    /**
     * Named by an administrator and unique platform-wide, case-insensitively — `Vendor Pool` and
     * `vendor pool` are the same group to a human, and two of them would be an operational trap in
     * a screen whose whole job is saying which capacity a run is waiting on.
     */
    name: citext('name').notNull(),
    description: text('description'),
    /**
     * Enabled on creation, because a newly created group is empty and therefore harmless. This is
     * the opposite default to `execution_profiles.enabled`, and deliberately so: a profile is
     * disabled until validation proves it launchable, whereas a group has nothing to prove — the
     * gate that matters is on each credential's own `state`, which starts at `awaiting_login` and
     * is unselectable until a login is proven (FR-008).
     */
    enabled: boolean('enabled').notNull().default(true),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id),
    /** Soft delete only (FR-066); historical runs and lease rows reach through this row. */
    archivedAt: timestampColumn('archived_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [uniqueIndex('credential_groups_name_key').on(table.name)],
)

/**
 * One agent identity the platform can work as, usable by one workflow at a time (FR-001, FR-002).
 *
 * **Two columns on this table exist for reasons that are not obvious from their names.**
 *
 * `fence` is the fencing token from research R9, and it lives here rather than on
 * {@link credentialLeases} **because it must outlive the lease that raised it**. Acquisition
 * increments it and issues the new value to the lease; every rotation write presents the value it
 * was given, and the machine surface rejects anything below the credential's current one (FR-020).
 * A holder that is partitioned rather than dead keeps writing, and lease expiry cannot help with
 * that — the fence makes those writes rejectable without anyone having to decide whether the
 * holder is alive. Put on the lease, the token would vanish with the row a force-release deletes
 * the liveness of, and the displaced holder's next write would land on material the new holder now
 * owns.
 *
 * `held_by` exists because **keep-alive and a workflow reservation contend for the same idle row**
 * (FR-038). Both claim it through the same conditional `UPDATE … WHERE id = :id AND state =
 * 'available'`, so exactly one updates a row and the other sees zero — a read-then-act check would
 * let both observe `available` and proceed. Keep-alive cannot express its claim as a
 * {@link credentialLeases} row, because that table's `workflow_id` is not null and a keep-alive
 * exercise has no workflow, so the discriminator has to live on the credential. It is also what
 * gives the pool view its fourth holder kind (FR-074).
 *
 * `last_exercised_at` is deliberately **one column written by two mechanisms**. Keep-alive and real
 * workflow use are equivalent evidence that the login still works, and splitting them would let a
 * credential look idle to the keep-alive scheduler immediately after a workflow had just proved
 * otherwise.
 */
export const agentCredentials = pgTable(
  'agent_credentials',
  {
    id: idColumn(),
    /**
     * Not null: a credential belongs to exactly one group, assigned at registration (FR-061).
     * Membership is single rather than many-to-many so that "how much capacity does this group
     * have" is a count rather than a set union, and so that moving a credential between groups is
     * a decision somebody makes rather than an accident of overlapping attachments.
     */
    credentialGroupId: uuid('credential_group_id')
      .notNull()
      .references((): AnyPgColumn => credentialGroups.id),
    name: citext('name').notNull(),
    /** Only `available` is selectable; see `src/enums/credential-state.ts` for what each state means. */
    state: credentialStateEnum('state').notNull(),
    /**
     * The Secrets Manager identifier — **a name, never the material behind it** (FR-011, R8).
     *
     * Null until a login has succeeded, and null is what makes FR-008 a data rule rather than a
     * check somewhere: a credential with nowhere to fetch material from cannot be handed to a
     * workflow by any code path, whatever its state column happens to say.
     */
    secretId: text('secret_id'),
    /** Monotonic fencing token, raised on every acquisition (FR-020, research R9). */
    fence: bigIntColumn('fence').notNull().default(0),
    /** Drives least-recently-used selection, so the pool wears evenly (FR-034). */
    lastUsedAt: timestampColumn('last_used_at'),
    /** Last proof the login still works, written by a workflow **or** by keep-alive (FR-035). */
    lastExercisedAt: timestampColumn('last_exercised_at'),
    /** `workflow` | `keep_alive` while `state = 'held'`; null otherwise. See the table note. */
    heldBy: text('held_by'),
    /**
     * The provider's stated retry time, where it gave one. Null while `cooling_off` means it did
     * not — FR-078 then retries on `SISYPHUS_COOLING_OFF_RETRY_MINUTES` rather than leaving the
     * credential cooling off forever, which is the failure a null-means-wait-indefinitely reading
     * would produce.
     */
    coolingOffUntil: timestampColumn('cooling_off_until'),
    lastLoginAt: timestampColumn('last_login_at'),
    /**
     * Why this credential is unhealthy, rendered to administrators verbatim (FR-009).
     *
     * It exists so a failed login is visible **against the credential** rather than only in a log
     * nobody is reading. It holds a reason and never material; the code that writes it is
     * responsible for that, and the "no material" assertion in `credential.test.ts` is what stops
     * a future column being added next to it that would not be.
     */
    lastFailureReason: text('last_failure_reason'),
    /** Withheld from future selection without evicting a live holder (FR-006). */
    enabled: boolean('enabled').notNull().default(true),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id),
    /** Soft delete: never hard-deleted once used, because runs reference it forever (FR-005). */
    archivedAt: timestampColumn('archived_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('agent_credentials_name_key').on(table.name),
    /**
     * Least-recently-used selection **within a group** (FR-034). The column order is the query's:
     * narrow to the group, keep only `available`, then take the oldest `last_used_at`. A
     * credential never used sorts first on a null, which is the behaviour wanted — an unused seat
     * is the least recently used one.
     */
    index('agent_credentials_group_selection_idx').on(
      table.credentialGroupId,
      table.state,
      table.lastUsedAt,
    ),
    /**
     * Keep-alive scheduling (FR-035): the available credentials whose last exercise is older than
     * `SISYPHUS_KEEPALIVE_IDLE_HOURS`. Partial on `available` because FR-036 skips leased
     * credentials outright — a held credential is being exercised by the run holding it.
     */
    index('agent_credentials_keep_alive_idx')
      .on(table.state, table.lastExercisedAt)
      .where(sql`${table.state} = 'available'`),
    /**
     * The return-to-pool sweep (FR-076). Partial, because the set it walks is by design tiny and
     * a full index would be almost entirely rows the sweep never looks at.
     */
    index('agent_credentials_cooling_off_idx')
      .on(table.state, table.coolingOffUntil)
      .where(sql`${table.state} = 'cooling_off'`),
  ],
)

/**
 * One row per acquisition. Never mutated except to write the release (FR-015, FR-019).
 *
 * **`credential_leases_live_key` is the whole feature.** A partial unique index on
 * `(agent_credential_id) WHERE released_at IS NULL` is what makes FR-017 and SC-003 — one agent
 * identity, one run, never two — true *at the database* rather than in application logic. Two
 * concurrent acquisitions racing for the same idle credential both attempt an insert; the loser
 * fails on the index inside its own transaction, at a point where nothing it did is visible. No
 * amount of care in the selecting query can achieve that, because the gap between "this one looked
 * free" and "I took it" is exactly where the race lives.
 *
 * The index is **partial** rather than a plain unique constraint because a credential is
 * legitimately leased many times over its life; only one of those leases may be live at once.
 * `credential_leases_workflow_live_key` is the same shape from the other side: a workflow holds at
 * most one seat (FR-015), so a retry that has already been granted one cannot quietly accumulate a
 * second.
 *
 * **A lease belongs to the workflow, not to any instance** (FR-018). It survives pause, park, and
 * the destruction of every execution environment the run ever had (FR-019). Environment lifecycle
 * is `compute_leases`, which is a different table because it is a different thing — conflating the
 * two would release an agent identity every time an instance went away, which is precisely the
 * behaviour FR-019 forbids.
 */
export const credentialLeases = pgTable(
  'credential_leases',
  {
    id: idColumn(),
    agentCredentialId: uuid('agent_credential_id')
      .notNull()
      .references((): AnyPgColumn => agentCredentials.id),
    /** The holder. A workflow, never an instance (FR-018). */
    workflowId: uuid('workflow_id')
      .notNull()
      .references((): AnyPgColumn => workflows.id),
    /**
     * The value {@link agentCredentials.fence} was raised to when this lease was issued. Presented
     * on every rotation write and compared against the credential's current value, so a superseded
     * holder is rejected rather than believed (FR-020, research R9).
     */
    fence: bigIntColumn('fence').notNull(),
    acquiredAt: timestampColumn('acquired_at').notNull().defaultNow(),
    /** Null means live. This column, and only this column, is what the two unique indexes read. */
    releasedAt: timestampColumn('released_at'),
    /**
     * Why the seat came free. Null exactly while the lease is live — a released lease with no
     * reason is a defect, not a fourth case. See `src/enums/credential-release-reason.ts`.
     */
    releaseReason: credentialReleaseReasonEnum('release_reason'),
    /**
     * Set only when `release_reason = 'forced'` **and a person did it** (FR-057, SC-015). The
     * reconciliation sweep also records `forced` when it resolves a lease whose workflow is gone
     * (FR-022), and it leaves this null — which is what distinguishes an administrator taking a
     * seat back from the platform tidying up after a run that no longer exists.
     */
    releasedByUserId: uuid('released_by_user_id').references(() => users.id),
  },
  (table) => [
    /** FR-017, SC-003 — the exclusivity gate. See the table note; this is the load-bearing line. */
    uniqueIndex('credential_leases_live_key')
      .on(table.agentCredentialId)
      .where(sql`${table.releasedAt} is null`),
    /** FR-015 — a workflow holds at most one seat at a time. */
    uniqueIndex('credential_leases_workflow_live_key')
      .on(table.workflowId)
      .where(sql`${table.releasedAt} is null`),
    /**
     * The FR-022 reconciliation sweep walks live leases looking for ones whose workflow is no
     * longer active. Partial, for the same reason `compute_leases_unreleased_idx` is: the live set
     * is bounded by the size of the pool, while the released set grows forever.
     */
    index('credential_leases_unreleased_idx')
      .on(table.releasedAt)
      .where(sql`${table.releasedAt} is null`),
  ],
)

/**
 * The ordered attachment between an execution profile and the groups it may draw from (FR-062).
 *
 * **This attaches to the mutable `execution_profiles` row, not to `execution_profile_versions`** —
 * deliberately, and against the pattern 002 uses for every other launch value. A profile version
 * pins what a run *does*; the credential pool is capacity the platform draws on. Pinning
 * attachments to a version would mean a historical run could not be re-launched after the pool
 * changed, and that editing group attachments would mint a profile version — a configuration
 * change dressed up as a new way of running. Which credential a run actually used is recorded on
 * the run itself (`workflows.agent_credential_id`, FR-059), which is what reconstruction needs.
 *
 * A profile with no attachment cannot be launched at all, and that refusal happens at save time
 * rather than at admission — a profile that only fails when somebody tries to run it is a trap.
 */
export const profileCredentialGroups = pgTable(
  'profile_credential_groups',
  {
    id: idColumn(),
    executionProfileId: uuid('execution_profile_id')
      .notNull()
      .references((): AnyPgColumn => executionProfiles.id),
    credentialGroupId: uuid('credential_group_id')
      .notNull()
      .references((): AnyPgColumn => credentialGroups.id),
    /** Preference order; lower is tried first. Unique per profile, so the order is total. */
    position: integer('position').notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    /**
     * Deterministic preference order. Unique rather than merely indexed because two groups sharing
     * a position would make selection depend on physical row order — reproducible right up until
     * it was not, and unattributable when it stopped being.
     */
    uniqueIndex('profile_credential_groups_position_key').on(
      table.executionProfileId,
      table.position,
    ),
    /** No duplicate attachment: the same group twice would silently double a profile's apparent capacity. */
    uniqueIndex('profile_credential_groups_group_key').on(
      table.executionProfileId,
      table.credentialGroupId,
    ),
  ],
)

/**
 * Every keep-alive exercise, append-only — so no `updated_at`.
 *
 * Retained because **the idle-expiry window this feature schedules against is unmeasured**
 * (research R2). `SISYPHUS_KEEPALIVE_IDLE_HOURS` defaults to 24 hours on an assumption, and this
 * table is what turns that assumption into something production data can settle. Deleting rows
 * once the exercise succeeded would discard exactly the evidence that makes the number tunable.
 *
 * The three outcomes are not interchangeable: `failed` moves the credential to `unhealthy` and
 * alerts, `cooling_off` does neither, because a provider limit clears by itself and waking somebody
 * for it trains them to ignore the alert that matters (FR-037).
 */
export const keepAliveRuns = pgTable(
  'keep_alive_runs',
  {
    id: idColumn(),
    agentCredentialId: uuid('agent_credential_id')
      .notNull()
      .references((): AnyPgColumn => agentCredentials.id),
    ranAt: timestampColumn('ran_at').notNull().defaultNow(),
    /**
     * `succeeded` | `cooling_off` | `failed`. Text rather than a Postgres enum: nothing outside the
     * database names this set — the panel renders the credential's own `state`, and the executor
     * never sees a keep-alive at all — so it does not meet the bar `db/schema/enums.ts` sets for
     * declaring a type. When it acquires a consumer it becomes a tuple in `src/enums/` and a
     * `pgEnum` here, which is a migration and should be one.
     */
    outcome: text('outcome').notNull(),
    /** Free text for an administrator. Never contains material, for the same reason nothing here does. */
    detail: text('detail'),
  },
  (table) => [
    /** The per-credential history the pool view renders, newest first. */
    index('keep_alive_runs_credential_idx').on(table.agentCredentialId, table.ranAt.desc()),
  ],
)

export type CredentialGroup = typeof credentialGroups.$inferSelect
export type NewCredentialGroup = typeof credentialGroups.$inferInsert
export type AgentCredential = typeof agentCredentials.$inferSelect
export type NewAgentCredential = typeof agentCredentials.$inferInsert
export type CredentialLease = typeof credentialLeases.$inferSelect
export type NewCredentialLease = typeof credentialLeases.$inferInsert
export type ProfileCredentialGroup = typeof profileCredentialGroups.$inferSelect
export type NewProfileCredentialGroup = typeof profileCredentialGroups.$inferInsert
export type KeepAliveRun = typeof keepAliveRuns.$inferSelect
export type NewKeepAliveRun = typeof keepAliveRuns.$inferInsert
