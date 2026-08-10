# Phase 1 Data Model: Sisyphus

**Feature**: `specs/002-sisyphus-workflow-platform` | **Date**: 2026-08-05

PostgreSQL, owned exclusively by `packages/sisyphus-api` (FR-005, R5). Conventions throughout:

- **Keys** — UUID v7 primary keys (`id`), time-ordered so they sort naturally and index well.
- **Timestamps** — `timestamptz`, UTC. `created_at` on everything; `updated_at` where mutable.
- **Money** — `numeric(12,4)` for spend. Never floating point.
- **Enums** — Postgres enums generated from the TypeScript enums in `src/enums/`, so a new value is a migration
  plus one code change and a stale literal fails `typecheck` (FR-009).
- **Append-only tables** carry no `updated_at` and are never mutated: `workflow_events`, `corrections`,
  `external_actions`, `log_segments`, `role_changes`, `configuration_audit`, `notifications`,
  `integration_runs`, `profile_access_grants` (revocation is a new row, not an edit).
- **Soft delete** — configuration entities use `archived_at`/`enabled`, never hard delete, because in-flight
  and historical workflows reference them (FR-092, FR-128).
- **Payloads live in S3**, never in Postgres. Tables hold keys and digests only.

---

## Entity overview

```
users ──┬─< profile_access_grants >─┬── execution_profiles ──< execution_profile_versions
        │                            │                              │        │
        ├─< role_changes             │        workspaces ──< workspace_versions ──< workspace_entries
        │                            │                                       │
        ├─< notification_preferences │           setup_bundles ──< setup_bundle_versions
        ├─< notifications            │                                        │
        └─< workflow_watchers        │                              < validation_runs
                                     │
integrations ──< integration_mappings ┘
     │  └──< integration_runs
     │  └──< ticket_claims
     ▼
  workflows ──┬──< workflow_entries      (per workspace entry, per run)
              ├──< workflow_events        (append-only timeline)
              ├──< bootstrap_phases
              ├──< log_segments
              ├──< session_snapshots
              ├──< corrections
              ├──< supervision_commands   (pause / resume / stop delivery)
              ├──< skill_references
              ├──< artifacts
              ├──< external_actions
              ├──< iterations ──< review_findings
              ├──< profile_overrides
              ├──< scoped_credentials
              ├──< compute_leases
              └──> workflows (predecessor_id — successor chain)
```

---

## Identity and access

### `users`

Auto-created on first successful sign-in with role `engineer` (FR-170).

| Column            | Type             | Notes                                           |
| ----------------- | ---------------- | ----------------------------------------------- |
| `id`              | uuid pk          |                                                 |
| `email`           | citext unique    | The join key to Slack identity (R13)            |
| `google_subject`  | text unique      | Stable IdP identifier; email can change         |
| `display_name`    | text             |                                                 |
| `role`            | `user_role`      | `engineer` \| `admin` (FR-166)                  |
| `is_active`       | boolean          | Deactivation, not deletion (FR-176)             |
| `slack_user_id`   | text null        | Cached resolution; null ⇒ unnotifiable (FR-140) |
| `last_sign_in_at` | timestamptz null |                                                 |

**Rules.** At least one `is_active` admin must exist at all times — enforced in a transaction that re-counts
active admins before committing a revocation or deactivation, so the check cannot race (FR-173). Deactivation
never deletes history; owned workflows are flagged for reassignment (FR-176). Role and activation changes take
effect on the next request because sessions are database-backed (FR-175, R9).

**The first admin comes from configuration, not from the panel (FR-174).** Every route to `admin` requires an
existing admin to grant it, and users are auto-created as `engineer` — so without a seed there is no admin, and
no configuration of any kind can be performed. That is a hard deadlock on the foundational slice, not an
inconvenience.

Resolution: a `SISYPHUS_BOOTSTRAP_ADMIN_EMAILS` value in deploy-time configuration, read by an idempotent
reconcile step that runs after migration on every deploy. For each listed address it **promotes the existing user
row, or creates one pre-authorised** so the promotion also covers someone who has not yet signed in. Every
promotion writes a `role_changes` row with a `system` actor, so a bootstrap grant is as auditable as a
human-issued one (FR-177) and "who made this person an admin" always has an answer.

It is a reconcile rather than a one-shot migration so that recovering from the never-zero-admins state — every
admin deactivated, nobody able to re-grant — is a redeploy rather than a manual database edit. Removing an
address does **not** demote anyone: revocation stays an explicit, attributed action.

### `role_changes` _(append-only)_

`id`, `actor_user_id → users`, `subject_user_id → users`, `change` (`grant_admin` | `revoke_admin` | `activate`
| `deactivate`), `created_at`. Never edited or deleted (FR-177).

### `profile_access_grants` _(append-only)_

`id`, `user_id → users`, `execution_profile_id → execution_profiles`, `granted_by_user_id → users`,
`granted_at`, `revoked_at` null, `revoked_by_user_id` null.

**Rules.** A grant is live when `revoked_at is null`. Revocation writes `revoked_at` rather than deleting, so
the audit trail survives (FR-184). Partial unique index on `(user_id, execution_profile_id) WHERE revoked_at IS
NULL` prevents duplicate live grants. **This table is the input to every scoped query** — see
[Access scoping](#access-scoping).

---

## Configuration

### `setup_bundles` / `setup_bundle_versions`

Split because bundles are **immutable once registered**: replacing contents creates a version, never mutates
one (FR-090).

`setup_bundles`: `id`, `name` unique, `description`, `enabled`, `spend_caps_enforceable` boolean (FR-093),
`created_by_user_id`, `archived_at` null.

`setup_bundle_versions`: `id`, `setup_bundle_id`, `version` int, `s3_key`, `content_digest` (sha256),
`size_bytes`, `registered_by_user_id`, `created_at`. Unique on `(setup_bundle_id, version)`.

**Rules.** Registering, replacing, enabling and disabling all require `admin` (FR-167, FR-168). Any
authenticated user may **read** the enabled list, because selecting one is part of building a profile (FR-086).
A bundle referenced by a live integration or non-terminal workflow cannot be archived (FR-092).

### `validation_runs`

`id`, `setup_bundle_version_id`, `outcome` (`passed` | `failed`), `phase_results` jsonb, `output_s3_key`,
`triggered_by_user_id`, `started_at`, `ended_at`. Proves a bundle without starting an agent (FR-147, FR-148).

### `workspaces` / `workspace_versions` / `workspace_entries`

Split for the same reason bundles are: FR-125 requires an edit to create a **new version** leaving in-flight runs
untouched. A single mutable row with a `version` integer cannot do that — the number would point at content that
no longer exists, and FR-065's "record what it ran with" would record a lie.

`workspaces`: `id`, `name` unique, `description`, `enabled`, `current_version_id`, `archived_at` null.

`workspace_versions`: `id`, `workspace_id`, `version` int, `created_by_user_id`, `created_at`. Unique on
`(workspace_id, version)`. Immutable once created.

`workspace_entries`: `id`, `workspace_version_id`, `repository_url`, `base_branch`, `subdirectory`, `is_primary`
boolean, `position` int. **Entries hang off the version, not the workspace** — that is what makes the spec's
"workspace grows an entry mid-run" edge case harmless: the running workflow still resolves the version it started
with.

**Rules.** Exactly one `is_primary` per version — partial unique index on `(workspace_version_id) WHERE
is_primary` (FR-110). `subdirectory` unique per version and validated to resolve inside the pinned root, rejected
at validation time otherwise (FR-111). Editing creates a version and advances `current_version_id`; workflows
already running keep their `workspace_version_id` (FR-125, FR-149).

### `execution_profile_versions`

`id`, `execution_profile_id`, `version` int, plus a snapshot of **every** launch value the version carries
(`workspace_version_id`, `setup_bundle_version_id`, `model`, `instance_type`, `purchase_mode`, `turn_cap`,
`spend_cap`, `default_workflow_type`, `prompt_preamble`, `locked_fields`), `created_by_user_id`, `created_at`.
Unique on `(execution_profile_id, version)`. Immutable.

**Rules.** The mutable `execution_profiles` row holds only identity and pointer state — name, `enabled`,
`current_version_id`, `archived_at`. Everything a run depends on lives on the version, so
`workflows.execution_profile_version_id` reconstructs the exact launch configuration for the retention period
(FR-065, FR-125, FR-126, SC-021). Note the version pins the **bundle version and workspace version**, not just
their ids: a profile that validated against one bundle version has not been silently re-pointed at another.

### `execution_profiles`

The launch preset **and the unit of access control** (FR-121, FR-179).

Identity and pointer state only — every launch value lives on `execution_profile_versions` above.

| Column               | Type                         | Notes                                                        |
| -------------------- | ---------------------------- | ------------------------------------------------------------ |
| `id`                 | uuid pk                      |                                                              |
| `name`               | text unique                  |                                                              |
| `current_version_id` | → execution_profile_versions | Advanced by an edit (FR-125)                                 |
| `enabled`            | boolean                      | Gated by the FR-124 validation check                         |
| `archived_at`        | timestamptz null             | Soft delete; referenced profiles never hard-deleted (FR-128) |

**Rules.** Cannot be enabled until validation confirms the profile has a published version, its pinned bundle
and workspace version rows are readable, the setup bundle is enabled and not archived, and the workspace is not
archived and holds at least one entry (FR-124). Repository reachability is **not** checked — see
`specs/004-remove-reachability-gate`. Not deletable while referenced; disable instead (FR-128).

### `integrations` / `integration_mappings`

`integrations`: `id`, `type` (`jira`), `name` unique, `base_url`, `credential_secret_arn` (write-only from the
panel — never returned), `project_prefix`, `label`, `extra_filters` jsonb, `default_owner_user_id`,
`prompt_intro` text, `cron_expression`, `timezone`, `per_tick_ceiling`, `rolling_period_ceiling`,
`rolling_period_minutes`, `enabled`, `consecutive_failures`, `auto_disabled_reason` null, `schedule_arn` null.

`integration_mappings`: `id`, `integration_id`, `position` int, `criteria` jsonb, `execution_profile_id`,
`is_default` boolean. Unique on `(integration_id, position)`.

**Rules.** Admin-only (FR-186). Carries **no** repository, branch, model, caps or bundle — those come from the
resolved profile (FR-096). Mappings resolve first-match by `position`; a ticket matching none is skipped with
the reason recorded, never started under a guessed profile (FR-130). Cannot be enabled without a default owner
(FR-133). `schedule_arn` is the registered schedule, kept in lockstep with `enabled` and `cron_expression`
(FR-100).

`prompt_intro` is **required, not null** — it is the layer describing how work from this board should be
approached, and it sits between the profile's `prompt_preamble` and the ticket content in the assembled prompt
(FR-158, FR-159). An integration cannot be enabled with it empty, for the same reason it cannot be enabled
without a default owner: a run started from an empty intro is a run nobody described. For a manually-started
workflow the engineer's own prompt occupies this layer instead (FR-165).

### `integration_runs` _(append-only)_

`id`, `integration_id`, `trigger` (`scheduled` | `manual`), `started_at`, `ended_at`, `examined_count`,
`matched_count`, `started_count`, `skipped_count`, `skip_reasons` jsonb, `error` null. The history that makes a
silently-failing connector visible (FR-105).

### `ticket_claims`

`id`, `integration_id`, `external_id`, `workflow_id` null, `claimed_at`.

**Rules.** **Unique on `(integration_id, external_id)`** — this index, not application logic, is what makes
exactly-once claiming hold across restarts and overlapping ticks (FR-102, R8). Written in the same transaction
that creates the workflow. Where two integrations match one ticket, the deterministic winner is the lower
`integrations.id`, recorded on the losing run's `skip_reasons` (FR-104).

---

## Workflow

### `workflows`

| Column                                                                 | Type                               | Notes                                                        |
| ---------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------ |
| `id`                                                                   | uuid pk                            |                                                              |
| `type`                                                                 | `workflow_type`                    | `delegated` \| `autonomous` \| `review`                      |
| `state`                                                                | `workflow_state`                   | See [state machine](#workflow-state-machine)                 |
| `terminal_outcome`                                                     | `terminal_outcome` null            | Exactly one when terminal (FR-064)                           |
| `outcome_reason`                                                       | text null                          |                                                              |
| `initiated_by_user_id`                                                 | → users, null                      | Null when integration-started                                |
| `originating_integration_id`                                           | → integrations, null               |                                                              |
| `originating_mapping_id`                                               | → integration_mappings, null       | Why it got these settings (FR-131)                           |
| `owner_user_id`                                                        | → users                            | **Not null** — exactly one human owner (FR-132)              |
| `execution_profile_id`                                                 | → execution_profiles, null         | Null ⇒ ad hoc (FR-126)                                       |
| `execution_profile_version_id`                                         | → execution_profile_versions, null | Reconstructs the exact launch config (FR-065, FR-126)        |
| `setup_bundle_version_id`                                              | → setup_bundle_versions            |                                                              |
| `workspace_version_id`                                                 | → workspace_versions               | The entry set as it was at launch (FR-125)                   |
| `ticket_reference`                                                     | text null                          |                                                              |
| `result_branch_name`                                                   | text null                          | Shared across entries (FR-116)                               |
| `assembled_prompt`                                                     | text null                          | **As sent**; null only for a validation run (FR-162, FR-147) |
| `prompt_truncated`                                                     | boolean                            | Oldest-first comment truncation occurred (FR-163)            |
| `model` / `instance_type` / `purchase_mode` / `turn_cap` / `spend_cap` |                                    | Resolved job spec, **immutable** (FR-149)                    |
| `turns_used` / `spend_used`                                            | int / numeric(12,4)                |                                                              |
| `compute_cost_basis`                                                   | numeric(12,4) null                 | For total attribution (FR-041)                               |
| `predecessor_workflow_id`                                              | → workflows, null                  | Successor chain (FR-150)                                     |
| `session_id`                                                           | uuid                               | Platform-assigned, pre-agent (FR-052, R2)                    |
| `current_snapshot_id`                                                  | → session_snapshots, null          |                                                              |
| `reviewer_summary`                                                     | text null                          | Written for the reviewer (FR-153)                            |
| `needs_reassignment`                                                   | boolean                            | Owner deactivated (FR-176)                                   |

**Rules.** The job-spec columns are write-once: continuing with changed configuration creates a **successor**
workflow inheriting the snapshot, never an edit (FR-150, FR-151). Consumption is summable across a chain via
`predecessor_workflow_id` (FR-152). An autonomous workflow cannot be created without both caps (FR-055).
A delegated workflow's PRs are draft and no ticket transition is attempted unless explicitly requested (FR-060).

### `workflow_entries`

Per workspace entry, per run — the multi-repo unit (FR-114, FR-115, FR-118).

`id`, `workflow_id`, `workspace_entry_id`, `repository_url`, `base_branch`, `subdirectory`, `is_primary`,
`resolved_commit`, `was_changed` boolean, `pull_request_url` null, `entry_result` (`unchanged` | `landed` |
`failed`) null, `staleness_note` null.

**Rules.** Resolved commit recorded at checkout so a run is reproducible; staleness evaluated **per entry**
(FR-079, FR-114). At most one PR per entry (FR-115). If any entry is `failed` while another is `landed`, the
workflow's terminal outcome states the partial state and must not be plain success (FR-118).

### `compute_leases`

`id`, `workflow_id`, `provider_instance_id`, `instance_type`, `purchase_mode`, `requested_at`,
`ready_at` null, `released_at` null, `last_heartbeat_at` null, `release_reason` null.

**Rules.** Tagged with the workflow id for cost attribution (FR-041). The reconciliation sweep reads this table
in both directions: a lease with no live workflow is released; a workflow whose lease vanished or whose
heartbeat lapsed moves to `parked_resumable` or `failed` with the reason recorded (FR-039, FR-048).

### `bootstrap_phases`

`id`, `workflow_id`, `phase` (`provisioning` | `bundle_download` | `bundle_verify` | `bundle_unpack` |
`setup_script` | `entry_checkout` | `agent_start`), `entry_id` null, `sequence` int, `started_at`,
`ended_at` null, `outcome` (`succeeded` | `failed` | `timed_out`) null, `detail` null.

**Rules.** Each phase has its own timeout; exceeding it fails the workflow **naming the phase** rather than
producing a generic bootstrap timeout (FR-146). This is what turns an opaque multi-minute "provisioning" state
into an attributable one (FR-145, SC-037).

### `session_snapshots`

`id`, `workflow_id`, `session_id`, `s3_key`, `size_bytes`, `boundary` (`completion` | `pause` | `interruption`
| `stop`), `has_conversation_state` boolean, `has_worktree_state` boolean, `truncation_repaired` boolean,
`is_current` boolean, `expires_at`, `created_at`.

**Rules.** A snapshot missing either state flag is **not resumable** (FR-050). Partial unique index on
`(workflow_id) WHERE is_current` — one current snapshot per workflow (FR-050). `truncation_repaired` records the
discarded trailing line as a normal outcome (FR-053). `expires_at` drives retention; a successor cannot be
created from an expired snapshot and is refused with the retention limit stated.

### `log_segments`

`id`, `workflow_id`, `sequence` bigint, `s3_key`, `byte_size`, `started_at`, `ended_at`.

**Rules.** Unique on `(workflow_id, sequence)`. Segments concatenate across resumptions into one continuous
ordered log, reconciled by sequence rather than arrival time (FR-046, R6). Content is sanitised and redacted
**before** it is written, so an unsanitised copy never exists at rest (FR-019, FR-045, FR-072).

### `workflow_events` _(append-only)_

`id`, `workflow_id`, `event` (`provisioned` | `started` | `paused` | `corrected` | `resumed` |
`snapshot_registered` | `interrupted` | `capped` | `succeeded` | `access_denied` | …), `actor_type` (`user` |
`executor` | `control_plane` | `reconciler` | `integration`), `actor_user_id` null, `detail` jsonb,
`created_at`.

**Rules.** Every state transition is timestamped and attributed to the actor that caused it (FR-064). This is
the timeline the panel renders.

### `corrections` _(append-only)_

`id`, `workflow_id`, `author_user_id`, `body`, `workflow_state_at_submission`, `sequence` int,
`delivery_outcome` (`pending` | `delivered` | `failed` | `rejected`), `delivered_at` null, `failure_reason` null.

**Rules.** Delivered in submission order by `sequence`; a correction that cannot be delivered fails **visibly**
rather than being dropped (FR-049). A correction against a terminal workflow is `rejected` with an
already-finished reason, not accepted and lost (FR-081).

### `supervision_commands` _(append-only)_

`id`, `workflow_id`, `command` (`pause` | `resume` | `stop`), `requested_by_user_id`, `sequence` int,
`delivery_outcome` (`pending` | `acknowledged` | `superseded` | `rejected`), `acknowledged_at` null,
`failure_reason` null. Unique on `(workflow_id, sequence)`.

**Rules.** This table is **how the executor learns it has been paused.** Without it, the panel's `pause` mutation
writes a state row that nothing on the instance ever reads, and SC-003's 10-second pause is unreachable — the
executor's `suspend()` routine would be fully specified and never invoked. Corrections got a pull procedure;
supervision commands need the same, for the same reason.

Commands share the corrections queue's ordering discipline: the executor polls, applies in `sequence` order, and
acknowledges. A `pause` followed by a `stop` before either is collected marks the `pause` **superseded** rather
than applying both — the executor must not pause, acknowledge, then discover it was also asked to stop. A command
against a terminal workflow is `rejected` (FR-081). Poll interval is bounded so worst-case pause latency stays
inside SC-003; the panel acknowledges to the user only once the executor has, so "paused" in the UI means paused
on the instance, not requested.

### `skill_references`

`id`, `workflow_id`, `skill_name` (`sisyphus-dev` | `sisyphus-review` | `sisyphus-integration`), `entry_id →
workflow_entries`, `resolved_path`, `content_digest` (sha256), `phase`, `recorded_at`.

**Rules.** FR-059 requires the skills **actually resolved** for a run, and their content version, to be recorded
so a past run stays explicable after the skills change — which is exactly what SC-016 tests. The digest is the
version: skills are repository files with no version number of their own, so hashing the content is the only
thing that distinguishes "this run followed today's convention" from "this run followed the one before it".
Resolved from the primary entry only (FR-110). A missing or unreadable skill is recorded here **and** halts the
workflow naming the skill (FR-058) — the absence is as much a fact about the run as the presence.

### `artifacts`

`id`, `workflow_id`, `entry_id → workflow_entries, null`, `kind` (`pull_request` | `diff` | `report` |
`attachment`), `s3_key` null, `external_url` null, `byte_size` null, `created_at`, `expires_at`.

**Rules.** FR-014 requires artifacts in the detail view and SC-012 requires them retrievable for the full
retention period; buckets alone cannot satisfy either, because nothing could enumerate a workflow's artifacts
without listing a prefix and guessing. `log_segments` and `session_snapshots` both got a table for this reason —
artifacts need the same. `expires_at` drives the same retention sweep, and an artifact whose object has expired
is still **listed** with its expiry rather than vanishing, so a gap in the record reads as retention rather than
loss.

### `profile_overrides`

`id`, `workflow_id`, `field`, `profile_value`, `used_value`, `set_by_user_id`. One row per per-run deviation
(FR-123). An attempt to override a field in `locked_fields` is refused, not silently ignored.

### `iterations` / `review_findings`

`iterations`: `id`, `workflow_id`, `ordinal` int, `review_verdict` (`pass` | `fail`) null, `started_at`,
`ended_at` null. Unique on `(workflow_id, ordinal)`; **`ordinal ≤ 3`** enforced by check constraint (FR-061).

`review_findings`: `id`, `iteration_id`, `workflow_entry_id` null, `file_path` null, `line` null, `severity`,
`summary`, `resolved_in_iteration_id` null. Anchored to entry + file + line for multi-repo reviews (FR-119).

### `external_actions` _(append-only)_

`id`, `workflow_id`, `kind` (`pull_request_opened` | `comment_posted` | `ticket_transitioned` |
`branch_pushed`), `target_reference`, `idempotency_key`, `result` (`succeeded` | `failed` | `pending`),
`attempt_count`, `error` null, `created_at`.

**Rules.** Unique on `(workflow_id, kind, idempotency_key)` — the index is what makes a retry unable to produce
a duplicate PR or comment (FR-077). Retried under bounded backoff; on exhaustion the workflow halts with the
pending action recorded rather than leaving it half-applied (FR-076).

### `scoped_credentials`

`id`, `workflow_id`, `jti` unique, `issued_at`, `expires_at`, `renewal_count`, `revoked_at` null.

**Rules.** One credential per workflow, machine-surface audience only. Every machine-surface write matches
`workflow_id` against the credential's target; a cross-workflow attempt is denied and recorded as a security
event (FR-037, FR-018).

### `notifications` _(append-only)_

`id`, `workflow_id`, `recipient_user_id`, `event`, `channel` (`slack_dm`), `outcome` (`delivered` | `failed` |
`unnotifiable`), `error` null, `created_at`.

**Rules.** Written **outside** the workflow's state transition. A delivery failure never alters workflow state
(FR-141, SC-042). Coalescing collapses rapid transitions per workflow, and one integration tick that starts many
workflows emits a single summary (FR-139).

### `notification_preferences`

`user_id` → users, `event`, `enabled` boolean, `updated_at`. Unique on `(user_id, event)`.

**Rules.** Per-event opt-out for a workflow's owner (FR-138). Absence of a row means **enabled** — a user who has
never touched their preferences still gets notified, so the default is not silence. The events are the same
closed set the `notifications.event` column records, so a preference cannot reference an event that will never
fire.

### `workflow_watchers`

`workflow_id` → workflows, `user_id` → users, `created_at`. Unique on `(workflow_id, user_id)`.

**Rules.** Lets a user follow a workflow they do **not** own (FR-138). Watching is subject to the same scoping as
reading: a user may only watch a workflow they are permitted to see, so this table cannot be used to learn that
an out-of-scope workflow exists (FR-190). A watcher receives the same events the owner would, filtered by their
own preferences. Removing a grant removes the watch; it does not silently keep delivering (FR-188).

### `configuration_audit` _(append-only)_

`id`, `actor_user_id`, `entity_type`, `entity_id`, `entity_version` null, `action`, `detail` jsonb,
`created_at`. Covers bundle registration, replacement, enable and disable (FR-178) and grant changes.

---

## Workflow state machine

The outcome names are **FR-064's closed set, verbatim** — `succeeded`, `failed`, `capped`, `cancelled`,
`needs_attention`, `parked_resumable`. `sisyphus-api` exposes them as the enum all three apps derive from
(FR-009), so there is one vocabulary and no translation layer.

```
                 ┌────────────────────────────────────────────────┐
                 ▼                                                │
  queued ──> provisioning ──> running ──┬──> paused ──────────────┘  (resume)
                   │             │       │      │
                   │             │       │      └──> parked_resumable ──> provisioning  (resume, new instance)
                   │             │       │
                   │             │       ├──> succeeded
                   │             │       ├──> capped
                   │             │       ├──> cancelled            (Stop — FR-049)
                   │             │       └──> needs_attention
                   │             │
                   └─────────────┴──> failed
```

| State                                                               | Meaning                                                                                                                                  | Valid exits                                                                                   |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `queued`                                                            | Created, awaiting admission under the ceiling                                                                                            | `provisioning`, `failed`, `cancelled`                                                         |
| `provisioning`                                                      | Instance requested, bootstrap phases running                                                                                             | `running`, `failed`                                                                           |
| `running`                                                           | Agent working                                                                                                                            | `paused`, `parked_resumable`, `succeeded`, `failed`, `capped`, `cancelled`, `needs_attention` |
| `paused`                                                            | Turn consumption stopped, snapshot taken, instance stopped with its disk retained (`003/FR-039`; was "process alive" under `002/FR-049`) | `running`, `parked_resumable`, `cancelled`, `failed`                                          |
| `parked_resumable`                                                  | Snapshot persisted, compute released, awaiting a human                                                                                   | `provisioning` (resume), or stays parked                                                      |
| `succeeded` / `failed` / `capped` / `cancelled` / `needs_attention` | Absorbing                                                                                                                                | —                                                                                             |

**`cancelled` is where Stop lands.** FR-049's Stop "ends the run cleanly after capturing everything" and
previously had no outcome to record; a stopped run is not a failure and must not be counted as one.

**`parked_resumable` is a recorded outcome, not an absorbing state.** It satisfies FR-064 (the run reached a
named outcome) and stops SC-006's reconciliation clock — a run waiting on a human is not a stalled run — while
FR-151 still resumes **the same workflow** rather than forking a successor. Re-entry to `provisioning` is an
explicit, attributed transition in `workflow_events`, so the history shows the park and the resume rather than
pretending the park never happened. Read FR-064's "exactly one terminal outcome" as one outcome _in force at a
time_; without that reading, FR-064 and FR-151 cannot both hold.

**Rules.**

- Transitions are **serialised per workflow** (`SELECT … FOR UPDATE` on the row) so concurrent supervision
  actions cannot interleave into an inconsistent state (FR-049, FR-081).
- **`queued` → `provisioning` is an admission decision, not a formality.** A configurable platform-wide ceiling
  bounds how many workflows may be non-terminal-and-holding-compute at once; beyond it, work stays `queued`
  rather than provisioning unbounded instances (FR-040). The ceiling is read at admission time from deploy-time
  configuration, and the count is taken inside the admitting transaction against `compute_leases` — counting
  leases rather than workflow rows, because a lease is what actually costs money. A workflow may sit `queued`
  indefinitely without that being a failure; the panel shows queue position so a wait is legible rather than
  looking like a stall.
- **Starting the same workflow twice concurrently provisions at most one instance** (FR-078). Enforced by a
  partial unique index on `compute_leases (workflow_id) WHERE released_at IS NULL`, so the second admission
  loses on the index rather than on application timing. The loser returns the existing workflow, not an error —
  a double-clicked launch button is a duplicate request, not a failure.
- Every workflow reaches **exactly one** terminal outcome; no workflow stays non-terminal beyond the
  reconciliation threshold (FR-064, SC-006).
- `paused` → `parked_resumable` is the pause idle-limit expiry: snapshot, release compute, park — **not**
  failed (FR-050, US2 §4).
- Pause, interruption warning and stop-for-later all traverse the same `suspend()` routine (FR-054, R3).
- Two non-terminal workflows may not hold the same `(repository_url, base_branch)` across **any** of their
  workspace entries — enforced by an advisory lock per pair acquired at start (FR-120). The lock is the sole
  mechanism; there is no partial index, because a predicate over `workflows.state` cannot be expressed in an
  index on `workflow_entries`.

---

## Access scoping

FR-190 forbids disclosing a workflow outside the requester's scope **including its existence**, so counts and
aggregates must be scoped too. This cannot be a per-resolver check (R4).

**Mechanism.** The tRPC context resolves, once per request, the caller's visible profile set:

```
visibleProfileIds(user) =
  user.role = 'admin'  ? ALL
                       : { p : live grant (user, p) }         -- FR-181, FR-183
```

Every workflow read is built from one scoped base selector:

```sql
-- conceptual shape of the base selector all workflow reads compose from
WHERE (:is_admin
       OR w.execution_profile_id = ANY(:visible_profile_ids)
       OR w.owner_user_id = :user_id            -- FR-189: always see what you own
       OR w.initiated_by_user_id = :user_id)
```

**Rules.**

- The ownership/initiator clause is **not** a convenience — an integration-started workflow is owned by a ticket
  assignee who may hold no grant, and being accountable for a run you cannot see or stop is not shippable
  (FR-189, FR-191).
- Aggregates (spend totals, status counts) compose from the **same** selector. A total that includes an
  invisible workflow leaks its existence (FR-190, SC-051).
- A non-admin launching against a profile they do not hold is refused and the attempt recorded (FR-180,
  SC-052).
- Revoking access does not affect in-flight workflows the user owns or initiated, and takes effect for new
  launches at the next request (FR-188).
- Default aggregation in the panel is by client/workspace/profile rather than by individual; per-user totals are
  visible to that user and to admins, never as a ranked comparison (FR-156).

---

## Indexes

Driven by the query shapes FR-012 and FR-013 require, plus the correctness constraints above.

| Table                        | Index                                                                           | Serves                                         |
| ---------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------- |
| `workflows`                  | `(execution_profile_id, state, created_at desc)`                                | Scoped list, the panel's primary read          |
| `workflows`                  | `(owner_user_id, state)`                                                        | Needs-attention view (FR-135)                  |
| `workflows`                  | `(originating_integration_id, created_at desc)`                                 | Integration attribution                        |
| `workflows`                  | `(predecessor_workflow_id)`                                                     | Successor chain traversal (FR-152)             |
| `workflow_entries`           | `(repository_url, base_branch)`                                                 | Advisory-lock probe, not a constraint (FR-120) |
| `log_segments`               | unique `(workflow_id, sequence)`                                                | Ordered reconstruction (FR-046)                |
| `session_snapshots`          | unique `(workflow_id) WHERE is_current`                                         | One current snapshot (FR-050)                  |
| `ticket_claims`              | unique `(integration_id, external_id)`                                          | Exactly-once claiming (FR-102)                 |
| `compute_leases`             | unique `(workflow_id)` partial `WHERE released_at IS NULL`                      | One live instance per workflow (FR-078)        |
| `compute_leases`             | `(released_at)` partial `WHERE released_at IS NULL`                             | Admission count under the ceiling (FR-040)     |
| `workflow_watchers`          | unique `(workflow_id, user_id)`                                                 | One watch per user per workflow (FR-138)       |
| `supervision_commands`       | unique `(workflow_id, sequence)`                                                | Ordered, exactly-once delivery (FR-049)        |
| `supervision_commands`       | `(workflow_id)` partial `WHERE delivery_outcome = 'pending'`                    | The executor's poll (SC-003)                   |
| `skill_references`           | `(workflow_id, skill_name)`                                                     | Explain a past run (FR-059, SC-016)            |
| `artifacts`                  | `(workflow_id, kind)`                                                           | Detail view enumeration (FR-014)               |
| `execution_profile_versions` | unique `(execution_profile_id, version)`                                        | Reconstructable launch config (FR-125)         |
| `workspace_versions`         | unique `(workspace_id, version)`                                                | Entry set at launch (FR-125)                   |
| `notification_preferences`   | unique `(user_id, event)`                                                       | Per-event preference lookup (FR-138)           |
| `external_actions`           | unique `(workflow_id, kind, idempotency_key)`                                   | Retry idempotency (FR-077)                     |
| `workspace_entries`          | unique `(workspace_id, subdirectory)`; unique `(workspace_id) WHERE is_primary` | FR-110, FR-111                                 |
| `profile_access_grants`      | unique `(user_id, execution_profile_id) WHERE revoked_at IS NULL`               | One live grant                                 |
| `users`                      | unique `email`, unique `google_subject`                                         | Identity resolution                            |

## Retention

| Data                                 | Retention                    | Mechanism                                       |
| ------------------------------------ | ---------------------------- | ----------------------------------------------- |
| Logs and artifacts                   | 12 months                    | S3 lifecycle per prefix (FR-071)                |
| Session snapshots                    | 30 days after terminal       | S3 lifecycle + `expires_at`                     |
| Setup bundle archives                | While any version referenced | Archive-not-delete (FR-092)                     |
| Workflow rows and append-only tables | Indefinite                   | The audit record outlives the payloads (SC-012) |
