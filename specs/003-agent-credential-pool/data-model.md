# Phase 1 Data Model: Agent Credential Pool

**Feature**: `specs/003-agent-credential-pool` | **Date**: 2026-08-07

PostgreSQL, owned exclusively by `packages/sisyphus-api`. Conventions are inherited from
[002's data model](../002-sisyphus-workflow-platform/data-model.md) and not restated: UUID v7 keys, `timestamptz`
in UTC, Postgres enums generated from `src/enums/`, append-only tables carrying no `updated_at`, soft delete via
`archived_at`/`enabled`, and **payloads never in Postgres**.

One convention is extended here: **credential material is not merely "not in Postgres", it is in a secret store
and referenced by identifier only** (FR-011). The tables below hold identity, state and lease bookkeeping. They
never hold a token.

---

## Entity overview

```
credential_groups ──< agent_credentials ──< credential_leases >── workflows
        │                     │
        │                     └──< keep_alive_runs
        │
        └──< profile_credential_groups >── execution_profiles
```

New tables: `credential_groups`, `agent_credentials`, `credential_leases`, `profile_credential_groups`,
`keep_alive_runs`. Modified: `workflows` (one column), plus two enum migrations.

**There is no queue table.** The FR-054 queue is derived — `workflows` in state `awaiting_credential`, ordered
by `created_at`, joined to their profile's attached groups. A table would be a second source of truth for
something the workflow row already knows, and would need reconciling against it.

---

## New tables

### `credential_groups`

The unit by which capacity is reserved for a set of execution profiles (FR-060).

| Column               | Type             | Notes                                           |
| -------------------- | ---------------- | ----------------------------------------------- |
| `id`                 | uuid pk          |                                                 |
| `name`               | citext unique    | Named by an administrator; unique platform-wide |
| `description`        | text null        |                                                 |
| `enabled`            | boolean          | Disabled withholds every member from selection  |
| `created_by_user_id` | uuid → users     |                                                 |
| `archived_at`        | timestamptz null | Soft delete only (FR-066)                       |

**Rules.** A group holding any credential, or attached to any profile, cannot be hard-deleted — disable it
(FR-066). Disabling withholds every member from future selection without interrupting runs that hold one
(FR-006 applied group-wide).

### `agent_credentials`

One agent identity the platform can work as, usable by one workflow at a time (FR-001, FR-002).

The table and its columns name no agent vendor (FR-003). Which backend a credential authenticates against is
configuration behind 002's existing agent adapter boundary, not a column here — that boundary exists so the
backend stays swappable, and encoding a vendor in the schema would spend it.

| Column                | Type                      | Notes                                                               |
| --------------------- | ------------------------- | ------------------------------------------------------------------- |
| `id`                  | uuid pk                   |                                                                     |
| `credential_group_id` | uuid → credential_groups  | **Not null** — exactly one group, assigned at registration (FR-061) |
| `name`                | citext unique             |                                                                     |
| `state`               | `credential_state`        | See [state machine](#credential-state-machine)                      |
| `secret_id`           | text null                 | Secrets Manager identifier. Null until first successful login       |
| `fence`               | bigint not null default 0 | Monotonic; incremented on every lease acquisition (FR-020, R9)      |
| `last_used_at`        | timestamptz null          | Drives least-recently-used selection (FR-034)                       |
| `last_exercised_at`   | timestamptz null          | Set by a workflow **or** by keep-alive (FR-035)                     |
| `cooling_off_until`   | timestamptz null          | Provider's stated retry time where given (FR-078)                   |
| `last_login_at`       | timestamptz null          |                                                                     |
| `last_failure_reason` | text null                 | Why it is unhealthy — shown to admins, never contains material      |
| `enabled`             | boolean                   | FR-006                                                              |
| `created_by_user_id`  | uuid → users              |                                                                     |
| `archived_at`         | timestamptz null          | FR-005 — never hard-deleted once used                               |

**Rules.**

- `secret_id` null ⇒ state is `awaiting_login`; the credential is never selectable (FR-008).
- `last_failure_reason` is what makes a failed login visible against the credential rather than only in a log
  (FR-009). It holds a reason, never material — it is rendered to administrators verbatim.
- `last_exercised_at` is deliberately **one column written by two mechanisms**. Keep-alive and real workflow use
  are equivalent evidence of liveness, and splitting them would let a credential look idle to the scheduler
  immediately after a workflow proved otherwise (FR-036 skips leased credentials for exactly this reason).
- `cooling_off_until` null while cooling off means the provider gave no retry time; FR-078 requires the
  credential still be retried rather than left cooling off forever.
- `fence` is on the credential, not the lease, because it must survive the lease that raised it — that is what
  makes a superseded holder's write rejectable after its lease row is gone.

### `credential_leases`

One row per acquisition. Never mutated except to write the release (FR-015, FR-019).

| Column                | Type                             | Notes                                                 |
| --------------------- | -------------------------------- | ----------------------------------------------------- |
| `id`                  | uuid pk                          |                                                       |
| `agent_credential_id` | uuid → agent_credentials         |                                                       |
| `workflow_id`         | uuid → workflows                 | The holder. **Not** an instance (FR-018)              |
| `fence`               | bigint not null                  | Value issued at acquisition; presented on every write |
| `acquired_at`         | timestamptz                      |                                                       |
| `released_at`         | timestamptz null                 | Null ⇒ live                                           |
| `release_reason`      | `credential_release_reason` null | `terminal` \| `forced` \| `login_replaced`            |
| `released_by_user_id` | uuid → users, null               | Set only when `release_reason = 'forced'` (FR-057)    |

**Rules.**

- **Partial unique index on `(agent_credential_id) WHERE released_at IS NULL`** — this single constraint is what
  makes FR-017 and SC-003 true at the database level rather than in application logic. Two concurrent
  acquisitions cannot both commit.
- Partial unique index on `(workflow_id) WHERE released_at IS NULL` — a workflow holds at most one (FR-015).
- A lease survives pause, park, and the destruction of every execution environment the workflow ever had
  (FR-019). Environment lifecycle is recorded on `compute_leases`, which is a different table for a different
  thing — conflating them is what the earlier draft of this design got wrong.

### `profile_credential_groups`

The ordered attachment between an execution profile and the groups it may draw from (FR-062).

| Column                 | Type                      | Notes                                  |
| ---------------------- | ------------------------- | -------------------------------------- |
| `id`                   | uuid pk                   |                                        |
| `execution_profile_id` | uuid → execution_profiles |                                        |
| `credential_group_id`  | uuid → credential_groups  |                                        |
| `position`             | integer                   | Preference order; lower is tried first |

**Rules.** Unique on `(execution_profile_id, credential_group_id)` and on `(execution_profile_id, position)`.

**This attaches to the mutable `execution_profiles` row, not to `execution_profile_versions`** — deliberately,
and against the pattern 002 uses for every other launch value. A profile version pins what a run _does_; the
credential pool is capacity the platform draws on, and pinning it to a version would mean a historical run
could not be re-launched after the pool changed, and that editing group attachments would mint a profile
version. Which credential a run actually used is recorded on the run itself (FR-059), which is what
reconstruction needs.

### `keep_alive_runs` _(append-only)_

| Column                | Type                     | Notes                                    |
| --------------------- | ------------------------ | ---------------------------------------- |
| `id`                  | uuid pk                  |                                          |
| `agent_credential_id` | uuid → agent_credentials |                                          |
| `ran_at`              | timestamptz              |                                          |
| `outcome`             | text                     | `succeeded` \| `cooling_off` \| `failed` |
| `detail`              | text null                | Never contains material                  |

**Rules.** Retained so the true idle-expiry window (research R2) becomes measurable from production data rather
than assumed. A `failed` outcome moves the credential to `unhealthy` and alerts; `cooling_off` does neither
(FR-037).

---

## Modified tables

### `workflows`

| Column                | Type                           | Notes                                        |
| --------------------- | ------------------------------ | -------------------------------------------- |
| `agent_credential_id` | uuid → agent_credentials, null | The single credential this run used (FR-059) |

Null only while the workflow is in `awaiting_credential` and has never held one. Once set it is never changed —
FR-023 as a data rule, not just a behavioural one.

**This one column is also what makes per-credential spend possible** (FR-055). 002 already accrues spend and
consumption per workflow; joining through `agent_credential_id` aggregates it per credential without a second
ledger, and without the drift a second ledger would eventually develop. It is why the column lives on
`workflows` rather than being left implicit in lease history.

### Enum migrations

| Enum              | Change                                                                           | Requirement |
| ----------------- | -------------------------------------------------------------------------------- | ----------- |
| `workflow_state`  | `+ awaiting_credential`, also added to `ACTIVE_WORKFLOW_STATES`                  | FR-024, R10 |
| `bootstrap_phase` | `+ credential_install`, **inserted between** `setup_script` and `entry_checkout` | FR-049, R7  |

The `bootstrap_phase` change is a reorder, and the enum's own documentation states that reordering renames what
stored rows refer to. It ships as a migration, not an append — appending would place credential installation
after `agent_start` in the vocabulary, which is wrong and would not be detectable later.

---

## Credential state machine

```
                      ┌──────────────── login succeeds ─────────────────┐
                      │                                                 ▼
  (registered) ──> awaiting_login ──login fails──> awaiting_login    available
                                                                   │    ▲   │
                                          lease acquired ──────────┘    │   └────── disabled by admin ──> disabled
                                                 │                      │                                     │
                                                 ▼                      │                            re-enabled
                                               held ───lease released───┘                                     │
                                                 │                                                            ▼
                     provider limit ─────────────┼──────────────> cooling_off ──limit clears──> available <───┘
                                                 │                                   ▲
                     auth failure ───────────────┴──────────────> unhealthy ─────────┘
                                                                       │      re-login succeeds
                                                                       └──> awaiting_login (re-login started)
```

**Rules.**

- `cooling_off` and `unhealthy` are reachable from `held` as well as from keep-alive, because a limit or a
  breakage can surface mid-run. From `held`, neither releases the lease: FR-077 has the workflow wait out a
  cooling-off, and FR-023 forbids substitution when unhealthy — the run fails naming the credential, and the
  lease releases through the normal terminal path.
- Only `available` is selectable. `held`, `cooling_off`, `unhealthy`, `disabled` and `awaiting_login` are all
  skipped, and FR-029 requires the queue to report _which_ of these applies rather than a bare "no capacity".
- `disabled` is reachable from any state and does not interrupt a live holder (FR-006).

---

## Access scoping

Credential configuration is **admin-only** (FR-004, FR-067) — registration, groups, membership, attachments,
force-release and the pool view. This is stricter than 002's profile-scoped model, which lets engineers see
their own runs: a credential is platform infrastructure, and its state reveals nothing an engineer can act on.

The one engineer-visible fact is on their own workflow: that it is waiting for a credential, and for how long
(SC-006). Reached through the existing workflow-scoping mechanism, not through any credential query.

---

## Indexes

| Table                       | Index                                                     | Serves                                |
| --------------------------- | --------------------------------------------------------- | ------------------------------------- |
| `credential_leases`         | unique `(agent_credential_id) WHERE released_at IS NULL`  | FR-017, SC-003 — the exclusivity gate |
| `credential_leases`         | unique `(workflow_id) WHERE released_at IS NULL`          | FR-015                                |
| `credential_leases`         | `(released_at) WHERE released_at IS NULL`                 | Reconciliation sweep (FR-022)         |
| `agent_credentials`         | `(credential_group_id, state, last_used_at)`              | LRU selection within a group (FR-034) |
| `agent_credentials`         | `(state, last_exercised_at) WHERE state = 'available'`    | Keep-alive scheduling (FR-035)        |
| `agent_credentials`         | `(state, cooling_off_until) WHERE state = 'cooling_off'`  | Return-to-pool sweep (FR-076)         |
| `profile_credential_groups` | unique `(execution_profile_id, position)`                 | Deterministic preference order        |
| `profile_credential_groups` | unique `(execution_profile_id, credential_group_id)`      | No duplicate attachment               |
| `workflows`                 | `(state, created_at) WHERE state = 'awaiting_credential'` | Queue view and grant order (FR-026)   |
