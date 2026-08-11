---
description: 'Task list for Agent Credential Pool'
---

# Tasks: Agent Credential Pool

> **DEPRECATED (2026-08-11):** The Sisyphus workflow platform — including the executor, control plane, admin app, and agent credential pool described in this document — has been deprecated in favour of the Claude Code GitHub Action. This was because the GitHub Action is easier to maintain and configure, and more customizable than the bespoke infrastructure it replaced. This document is retained as a historical design record only; the packages and apps it describes have been removed from the repository.

**Input**: Design documents from `/specs/003-agent-credential-pool/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: **Required, not optional**, including for `index.ts` barrels — Principle III says _every_ module
file, and this plan applies it uniformly rather than inheriting the repo's split habit (`enums/index.ts` and
`db/schema/index.ts` have colocated tests; `bootstrap/index.ts` and `session/index.ts` do not). That existing
inconsistency is a governance question worth settling separately — the constitution's own wording says a
document/tool disagreement is a defect one of the two must fix — but it is not settled by leaving new barrels
untested. Per Constitution Principle III (NON-NEGOTIABLE) and FR-004/FR-058's audit
requirements. A colocated `<name>.test.ts` is written **as part of the task that creates each module** — it is
not a separate line item, the same way T004 "create the enum" is understood to include the enum's guard test.
`.husky/pre-commit` runs the colocated test of every staged source file, so a module without one blocks its own
commit. Separate **test tasks appear only where the test is a distinct deliverable** — a contract test against a
router, a concurrency/race suite, a fixture suite against recorded provider responses — and they are listed in a
**Tests for User Story N** subsection immediately before that story's implementation, so the exclusivity
guarantee (SC-003) and the scoping invariant (SC-016) exist as executable specs before the code they constrain,
not after it.

**Organization**: Grouped by user story, ordered for **shortest path to a working MVP** rather than by story
priority alone. One P1 story is split so its expensive half lands after the MVP checkpoint — see
[MVP shape](#mvp-shape) below.

## MVP shape

The MVP is **Phases 1–6**: a workflow reserves a seat at admission, boots with it, writes rotations through, and
releases it — with a queue when the pool is dry, and the race/fencing tests that prove exclusivity holds under
it. US2, US3 and US4 land whole; **US1 is split**, which is what makes the MVP reachable in six phases rather
than seven:

| Story   | Priority | In the MVP                                                 | Deferred to                            |
| ------- | -------- | ---------------------------------------------------------- | -------------------------------------- |
| **US2** | P1       | Whole — groups, ordered attachments, the unlaunchable gate | —                                      |
| **US1** | P1       | Register into a group; adopt a secret seeded out of band   | Phase 7 — the hosted login environment |
| **US3** | P1       | Whole — lease, fetch, rotate, release, reconcile           | —                                      |
| **US4** | P1       | Whole — waiting state, grant on release, wait limit        | —                                      |

**The US1 split is the big one.** FR-069–FR-072 (ephemeral EC2 login instance, SSM relay, server-side capture,
wall-clock reaper) is the single most expensive piece of work in this feature and it gates nothing except
getting material into the store. Phase 4 instead has an operator write the secret with the AWS CLI and the panel
record its identifier. This **satisfies FR-011 and FR-070** — material lives in Secrets Manager and never
transits the panel or an administrator's browser — while leaving **FR-069, FR-071, FR-072 and SC-001 unmet
until Phase 7**. That is a stated, temporary gap, not a silent one.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel — different files, no dependency on an incomplete task
- **[Story]**: The user story this task serves (US1–US9)
- Every task names its exact path

## Path Conventions

Four existing workspace members change; **none is added** (plan.md → Structure Decision).

| Member                        | Role in this feature                                    |
| ----------------------------- | ------------------------------------------------------- |
| `packages/sisyphus-api`       | Schema, enums, contracts, tRPC admin + machine surfaces |
| `apps/sisyphus-control-plane` | Allocation, leasing, liveness, health, login, jobs      |
| `apps/sisyphus-executor`      | `credential_install` phase, rotation watch, suspend     |
| `apps/sisyphus-admin`         | Pool view, group management, login flow                 |

All commands go through Nx (`pnpm nx …`) per Constitution Principle I.

> **Naming collision — read once.** `apps/sisyphus-control-plane/src/credentials/` **already exists** and holds
> `mint.ts` / `revoke.ts`, which are 002's **workflow-scoped JWT** — the short-lived token an instance uses to
> call the machine surface, unrelated to the agent's own login. Every new module in this feature lands in a
> **subdirectory** (`allocate/`, `lease/`, `liveness/`, `health/`, `login/`) so the two concepts never share a
> file. T003 puts that sentence in the barrel so the next reader does not have to rediscover it.

---

## Phase 1: Setup

**Purpose**: The configuration this feature reads exists before anything reads it. No new dependencies — the
three AWS clients (`client-ec2`, `client-secrets-manager`, `client-ssm`) are already control-plane deps.

- [x] T001 [P] Add the four credential-pool knobs to `apps/sisyphus-control-plane/src/env-schemas.ts` and
      `apps/sisyphus-control-plane/src/env.ts`: `SISYPHUS_KEEPALIVE_IDLE_HOURS` (default `24`, per research R2),
      `SISYPHUS_CREDENTIAL_WAIT_LIMIT_MINUTES` (FR-028), `SISYPHUS_LEASE_HOLD_EXPECTATION_HOURS` (FR-056), and
      `SISYPHUS_COOLING_OFF_RETRY_MINUTES` (FR-078). All four are configuration rather than constants precisely
      because R1/R2 are unmeasured — tuning them must not need a code change.
- [x] T002 [P] Add `SISYPHUS_AGENT_CREDENTIAL_SECRET_PREFIX` to the same two files — the Secrets Manager name
      prefix under which one secret per agent credential is created (research R8)
- [x] T003 Add the workflow-scoped-vs-agent-credential distinction as a doc comment in
      `apps/sisyphus-control-plane/src/credentials/index.ts`, naming `mint.ts`/`revoke.ts` as the former and the
      new subdirectories as the latter

**Checkpoint**: Configuration resolves; nothing else has changed.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The vocabulary, the schema and the secret-writing seam. Everything downstream reads these.

**⚠️ CRITICAL**: No user story work can begin until this phase completes.

### Enums

- [x] T004 [P] Create `packages/sisyphus-api/src/enums/credential-state.ts` with its guard test, covering
      `awaiting_login | available | held | cooling_off | unhealthy | disabled` and a `createEnumGuard` guard,
      matching the sibling enum modules; document that **only `available` is selectable**
      ([data-model.md → state machine](./data-model.md#credential-state-machine))
- [x] T005 [P] Create `packages/sisyphus-api/src/enums/credential-release-reason.ts` with its guard test,
      covering `terminal | forced | login_replaced`
- [x] T006 Extend `packages/sisyphus-api/src/enums/workflow-state.test.ts` to assert `awaiting_credential` is a
      member of **both** `WORKFLOW_STATES` and `ACTIVE_WORKFLOW_STATES` (research R10), then add it in
      `workflow-state.ts`. The `ACTIVE_WORKFLOW_STATES` half is what keeps the reconciliation sweep treating a
      waiting run as live so its reservation is not swept away — a test that only checked `WORKFLOW_STATES` would
      pass while shipping that bug.
- [x] T007 Extend `packages/sisyphus-api/src/enums/bootstrap-phase.test.ts` to assert `credential_install` sits
      **between `setup_script` and `entry_checkout`**, then insert it in `bootstrap-phase.ts`. The file's own doc
      comment states that reordering renames what stored rows refer to, so this ships as a migration (T014),
      never an append (research R7).
- [x] T008 Re-export both new enums from `packages/sisyphus-api/src/enums/index.ts` and extend
      `index.test.ts` to assert they are reachable from the barrel
- [x] T009 Register `credential_state` and `credential_release_reason` as Postgres enums in
      `packages/sisyphus-api/src/db/schema/enums.ts`, with a colocated assertion that both round-trip

### Schema

- [x] T010 Create `packages/sisyphus-api/src/db/schema/credential.ts` and `credential.test.ts` with all five
      tables — `credentialGroups`, `agentCredentials`, `credentialLeases`, `profileCredentialGroups`,
      `keepAliveRuns` — per [data-model.md → New tables](./data-model.md#new-tables). `agentCredentials.fence` is
      `bigint not null default 0` and lives on the **credential, not the lease**, because it must outlive the
      lease that raised it; `agentCredentials.held_by` discriminates `workflow` from `keep_alive` while held,
      which is what lets the two contend for the same row under one conditional update (FR-038 — see
      [data-model.md](./data-model.md#agent_credentials)). No column anywhere holds credential material —
      assert that against the table definitions, not just by eye.
- [x] T011 Add the indexes to `credential.ts`, extending `credential.test.ts` to prove the partial unique index
      on `(agent_credential_id) WHERE released_at IS NULL` rejects a second live lease at the database level —
      per [data-model.md → Indexes](./data-model.md#indexes), this single index is the whole of FR-017 and
      SC-003, so it is proven here rather than trusted for the first time in Phase 5.
- [x] T012 Add the nullable `agent_credential_id` FK column to `workflows` in
      `packages/sisyphus-api/src/db/schema/workflow.ts`, plus the
      `(state, created_at) WHERE state = 'awaiting_credential'` index that serves the queue view (FR-059,
      FR-026), and extend `workflow.test.ts` to cover both. This one column is also what makes per-credential
      spend a join rather than a second ledger.
- [x] T013 Re-export `./credential` from `packages/sisyphus-api/src/db/schema/index.ts`, extending
      `index.test.ts` — a table absent from this barrel does not exist as far as drizzle-kit is concerned
- [x] T014 Generate the migration into `packages/sisyphus-api/src/db/migrations/` and **read it before
      applying**: confirm the `bootstrap_phase` change is a mid-order insert and not an append, then verify with
      `psql "$SISYPHUS_DATABASE_URL" -c "SELECT unnest(enum_range(NULL::bootstrap_phase))"`
- [x] T015 [P] Create `packages/sisyphus-api/src/contracts/agent-credential.ts` and its colocated test with the
      zod shapes shared by panel, control plane and executor — `fetchAgentCredential` and
      `reportCredentialRotation` inputs/outputs per
      [executor-credential.md](./contracts/executor-credential.md#machine-surface--two-calls) — and export it
      from `packages/sisyphus-api/src/contracts/index.ts`

### Secret store seam

- [x] T016 [P] Extend `apps/sisyphus-control-plane/src/aws/secrets.ts` and `secrets.test.ts` from the read-only
      `SecretReader` to add `create(name, value)` and `write(secretId, value)` over
      `CreateSecretCommand`/`PutSecretValueCommand`, widening `SecretsCommandSender` to match. Keep the existing
      no-caching rule — a cached credential outlives its own rotation, which is the exact failure this feature
      exists to prevent.
- [x] T017 [P] Mirror the new methods in `apps/sisyphus-control-plane/src/aws/secrets-fake.ts` and
      `secrets-fake.test.ts` so every path below is testable without an AWS account
- [x] T018 Create `packages/sisyphus-api/src/server/admin/credential-store.ts` and its colocated test — reads
      and writes over the five tables, **no transport concerns** — following the `bundle-store.ts` /
      `profile-store.ts` split the package already uses

**Checkpoint**: Migration applied, enums visible in Postgres, the exclusivity index is proven at the database
level, secret writes work against the fake. Story work can begin.

---

## Phase 3: User Story 2 - Group credentials and scope them to profiles (Priority: P1)

**Goal**: Named credential groups exist, profiles attach to them in preference order, and a profile without an
attachment is refused at save time.

**Independent Test**: Create two groups with distinct credentials, attach one to a profile, launch under that
profile repeatedly, confirm no credential from the unattached group is ever used.

**Why first**: FR-061 assigns a credential to exactly one group **at registration**, so a group must exist
before a credential can. Grouping is upstream of everything.

### Tests for User Story 2

> Written before the router below exists — expect these to fail until T019–T023 land.

- [x] T019 [P] [US2] Contract test for the credential-groups router in
      `packages/sisyphus-api/src/server/admin/credential-groups.test.ts`: create/rename/disable, the FR-066
      delete refusal **naming which condition applies** (attached-to-a-profile vs holds-a-credential), ordered
      attach/detach/reorder, and non-administrator refusal recorded to audit

### Implementation for User Story 2

- [x] T020 [US2] Create `packages/sisyphus-api/src/server/admin/credential-groups.ts` — `adminProcedure` tRPC
      for create, rename, disable, list, and membership moves, over `credential-store.ts`
- [x] T021 [US2] Add the FR-066 deletion refusal to `credential-groups.ts`, satisfying T019
- [x] T022 [US2] Add the ordered attach/detach/reorder procedures over `profile_credential_groups` to
      `credential-groups.ts`. Attachment is to the **mutable** `execution_profiles` row, not to
      `execution_profile_versions` — see [data-model.md](./data-model.md#profile_credential_groups) for why that
      deviates from 002's pattern deliberately.
- [x] T023 [US2] Add the FR-065 unlaunchable gate to `packages/sisyphus-api/src/server/admin/profile-gate.ts`,
      with a colocated test: saving a profile with no attached group is refused **at configuration time**,
      naming the missing attachment. Failing at launch instead is the outcome this requirement exists to
      prevent.
- [x] T024 [US2] Widen the audit vocabulary in `packages/sisyphus-api/src/server/admin/audit-log.ts` and write
      every group mutation and attachment change through `recordConfigurationChange`, attributed to the acting
      administrator (FR-067, SC-013), extending `audit-log.test.ts`. `AUDITED_ENTITY_TYPES` gains
      `agent_credential` and `credential_group`; `AUDITED_ACTIONS` gains `leased`, `released`, `force_released`
      and `state_changed` — the vocabulary FR-058 needs in Phase 5, landed once here before its first writer
      exists. **No migration**: `configuration_audit.entity_type` and `.action` are `text`, not Postgres enums.
- [x] T025 [US2] Mount `credentialGroupsRouter` on `adminRouter` in
      `packages/sisyphus-api/src/server/admin/index.ts`
- [x] T026 [P] [US2] Add the group management page at
      `apps/sisyphus-admin/src/app/(app)/admin/credentials/groups/page.tsx` — list, create, rename, disable
- [x] T027 [P] [US2] Extend the profile editor at
      `apps/sisyphus-admin/src/app/(app)/admin/profiles/[id]/page.tsx` with ordered group attachment, surfacing
      the T023 refusal inline rather than as a save error

**Checkpoint**: Groups and attachments are administrable and a profile cannot be saved without one. T019 passes.

---

## Phase 4: User Story 1a - Register a credential (Priority: P1)

**Goal**: A credential exists in a group, in `awaiting_login`, and becomes `available` once its secret is
recorded.

**Independent Test**: Register a seat, record its secret, observe it reported as available with a login time —
with no workflow involved at any point.

**⚠️ MVP shortcut**: Material is written to Secrets Manager **out of band by an operator** (`aws secretsmanager
create-secret`) and the panel records only the identifier. FR-011 and FR-070 hold — material is in the secret
store and never touches the panel. **FR-069, FR-071, FR-072 and SC-001 are not met until [Phase 7](#phase-7-user-story-1b---hosted-login-environment-priority-p1)**, which replaces this entirely.

### Tests for User Story 1a

> Written before the router below exists — expect these to fail until T028–T031 land. Phase 7 extends this same
> file rather than replacing it, so re-login and abandonment cases join it later without a rewrite.

- [x] T028 [P] [US1] Contract test for the credentials router in
      `packages/sisyphus-api/src/server/admin/credentials.test.ts`: register lands in `awaiting_login` with
      `secret_id` null and is never selectable in that state; `adoptSecret` accepts only an identifier and
      resolves it through T016 before flipping to `available`; the FR-005 delete refusal once any lease row
      references the credential; FR-006 disable withholds from future selection without touching a live holder;
      non-administrator refusal recorded to audit

### Implementation for User Story 1a

- [x] T029 [US1] Create `packages/sisyphus-api/src/server/admin/credentials.ts` — `adminProcedure` register
      (name + `credential_group_id` → state `awaiting_login`, `secret_id` null), list and get
- [x] T030 [US1] Add `adoptSecret` to `credentials.ts`: takes a Secrets Manager identifier, verifies it resolves
      through the T016 reader, sets `secret_id`, `last_login_at` and state `available`. **It accepts an
      identifier and never a value** — a procedure that took material would put it in a panel request body,
      which is what FR-070 forbids. Phase 7 deletes this.
- [x] T031 [US1] Add disable (FR-006) and the FR-005 delete refusal to `credentials.ts`, satisfying T028
- [x] T032 [US1] Audit every credential mutation with the acting administrator (FR-004), reusing the T024 path
- [x] T033 [US1] Mount `credentialsRouter` on `adminRouter` in
      `packages/sisyphus-api/src/server/admin/index.ts`
- [x] T034 [P] [US1] Add the credential list and register form at
      `apps/sisyphus-admin/src/app/(app)/admin/credentials/page.tsx`, showing state and `last_failure_reason`
      against each seat (FR-009)
- [x] T035 [US1] Document the out-of-band seeding steps in [quickstart.md](./quickstart.md) as an explicitly
      temporary Scenario 2a, cross-referenced to Phase 7

**Checkpoint**: A seat can be registered and made `available`. The pool is no longer empty. T028 passes.

---

## Phase 5: User Story 3 - A workflow leases a seat for its lifetime (Priority: P1) 🎯 MVP core

**Goal**: A workflow reserves one seat at admission, boots with it, writes rotations through under a fence, and
releases it at terminal state.

**Independent Test**: Start one workflow, observe a seat move to `held` with that workflow named against it,
observe the agent authenticate on the instance, observe the seat released on completion.

**This is the mechanism the whole specification exists to provide.** Its tests are the load-bearing evidence for
SC-002, SC-003, SC-014 and SC-016, and they are written first in this phase for exactly that reason.

### Tests for User Story 3

> Written before `allocate/`, `lease/` and the machine surface exist — expect all of these to fail until the
> matching implementation task lands. `T038` is **the single most important test in this feature**: it is what
> makes exclusivity a proven guarantee rather than a hoped-for one.

- [x] T036 [P] [US3] The scoping suite in
      `apps/sisyphus-control-plane/src/credentials/allocate/select.test.ts`: group-order fall-through, LRU
      within a group with `last_used_at NULLS FIRST`, and — the invariant SC-016 depends on — no credential
      outside the calling workflow's profile's attached groups is ever returned, asserted against every group
      combination the fixture can construct
- [x] T037 [P] [US3] The fencing suite in `apps/sisyphus-control-plane/src/credentials/lease/fence.test.ts`:
      a write under a superseded fence is rejected `stale_fence` with the newer material surviving, and a
      rotation arriving **after its workflow has terminated** is still accepted when its fence is current
      (FR-032)
- [x] T038 [US3] The exclusivity race suite in
      `apps/sisyphus-control-plane/src/credentials/lease/acquire.test.ts`: 2N concurrent acquisitions against N
      credentials, asserting exactly N succeed and **no credential ever appears on two live leases** — a
      violation here is a schema defect (T011's index), not a timing one (SC-003). Assert too that exactly N
      `leased` audit entries exist and that a rolled-back acquisition leaves none (FR-058, SC-013).
- [x] T039 [P] [US3] Contract test for the machine surface in
      `packages/sisyphus-api/src/server/machine/agent-credential.test.ts`: `fetchAgentCredential` returns
      material only for the credential the calling workflow's **live lease** names, with no parameter by which
      it could ask for another's; `reportCredentialRotation` rejects a stale fence and accepts a post-terminal
      one on a current fence

### Selection and leasing

- [x] T040 [US3] Create `apps/sisyphus-control-plane/src/credentials/allocate/select.ts` implementing
      `selectFor(workflow)` per
      [allocation-protocol.md → Selection](./contracts/allocation-protocol.md#selection), satisfying T036: groups
      in `position` order, `state = 'available'` and both credential and group `enabled`, LRU within the chosen
      group. Candidates are drawn **only** from the workflow's own profile's attachments — that restriction
      living in this one function is what makes SC-016 an invariant rather than an audit.
- [x] T041 [US3] Add `apps/sisyphus-control-plane/src/credentials/allocate/index.ts` barrel and
      `index.test.ts` asserting its public surface is reachable and that nothing internal leaks through it
- [x] T042 [US3] Create `apps/sisyphus-control-plane/src/credentials/lease/acquire.ts` as the **single
      transaction** in [allocation-protocol.md → Acquire](./contracts/allocation-protocol.md#acquire),
      satisfying T038: conditional `UPDATE … WHERE id = :selected AND state = 'available'` with
      `fence = fence + 1`, zero rows ⇒ rollback and re-select, then insert the lease and set
      `workflows.agent_credential_id`. Two racing acquisitions cannot both commit — one loses on the
      conditional, the other on the T011 index. Record a `leased` audit entry **inside the same transaction**
      (FR-058, SC-013): an audit write outside it would survive a rolled-back acquisition and record a lease
      that never existed.
- [x] T043 [US3] Create `apps/sisyphus-control-plane/src/credentials/lease/release.ts`, recording a `released`
      audit entry with its `release_reason` in the same transaction (FR-058). A credential that was
      `cooling_off` or `unhealthy` while held returns to **that** state, not to `available` — release does not
      repair.
- [x] T044 [US3] Create `apps/sisyphus-control-plane/src/credentials/lease/fence.ts` satisfying T037 — the
      comparison that rejects any write whose fence is below the credential's current value (FR-020, research
      R9)
- [x] T045 [US3] Add `apps/sisyphus-control-plane/src/credentials/lease/index.ts` barrel and `index.test.ts`
      asserting its public surface
- [x] T046 [US3] Wire reservation into `apps/sisyphus-control-plane/src/jobs/admit-workflow.ts` **before any
      compute is provisioned** — inside the existing admission lock, ahead of the
      `state: 'provisioning'` update at line 317. FR-016 exists so an instance is never billed while queued.
- [x] T047 [US3] Release on terminal state in `apps/sisyphus-control-plane/src/jobs/teardown-workflow.ts` with
      `release_reason = 'terminal'` (FR-019). Pause, park and environment destruction MUST NOT reach this path.
- [x] T048 [US3] Release with the reason recorded when a reserved workflow fails before running, in
      `apps/sisyphus-control-plane/src/jobs/start-workflow.ts` (FR-021) — a seat stranded by a post-reservation
      provisioning failure is otherwise invisible until reconciliation
- [x] T049 [US3] Add the stranded-lease sweep to `apps/sisyphus-control-plane/src/jobs/reconcile.ts`, with a
      colocated test asserting it does **not** touch leases held by `paused` or `parked_resumable` workflows:
      a live lease whose workflow is terminal or absent is released as `forced`, with the reason recorded and a
      `force_released` audit entry attributed to the sweep rather than to a user (FR-022, FR-058, SC-015)

### Envelope and machine surface

- [x] T050 [US3] Add `agentCredential: { credentialId, leaseFence }` to `WorkflowJobEnvelope` in
      `apps/sisyphus-control-plane/src/jobs/job-envelope.ts` — **identifiers only** — and extend
      `job-envelope.test.ts` to assert no field on the envelope can carry material. The envelope becomes EC2
      user-data, readable from the instance metadata service by anything on the box, which is why FR-012 keeps
      material out of it.
- [x] T051 [US3] Create `packages/sisyphus-api/src/server/machine/agent-credential.ts` with
      `fetchAgentCredential`, satisfying half of T039
- [x] T052 [US3] Add `reportCredentialRotation` to `agent-credential.ts`, satisfying the rest of T039
- [x] T053 [US3] Mount both procedures on `machineSurfaceRouter` in
      `packages/sisyphus-api/src/server/machine/router.ts`, guarded by the existing `machineProcedure`
      scoped-credential check
- [x] T054 [US3] Register agent credential material as a known redaction value in the executor's output
      pipeline at `apps/sisyphus-executor/src/output/`, with a colocated test asserting a rotation cannot reach
      a log even if something echoes it (FR-014, SC-014)

### Executor

- [x] T055 [US3] Create `apps/sisyphus-executor/src/bootstrap/credential-install.ts` and its colocated test —
      call `fetchAgentCredential`, install the material where the agent reads it, report the phase. It can fail
      only on transport, never on availability, because T046 guaranteed the claim before this instance existed.
- [x] T056 [US3] Add `credential_install` to `DEFAULT_PHASE_TIMEOUTS` and the bootstrap sequence in
      `apps/sisyphus-executor/src/bootstrap/phases.ts`, between `setup_script` and `entry_checkout`, extending
      `phases.test.ts` to assert the position and that a failure names the phase (FR-049, FR-051). It runs on
      **every** boot including restore and resumed-instance boots (FR-050).
- [x] T057 [US3] Export `credential-install` from `apps/sisyphus-executor/src/bootstrap/index.ts`
- [x] T058 [US3] Create `apps/sisyphus-executor/src/credential/rotation-watch.ts` and its colocated test — watch
      the agent's credential file, debounce, read, `reportCredentialRotation` under the lease fence. Written
      against **Linux** file behaviour; a developer machine may hold this material in an OS keychain, so local
      execution is not a valid test of this path (research R3) — the test fixture supplies a synthetic file, it
      does not rely on a real agent login.
- [x] T059 [US3] Add `apps/sisyphus-executor/src/credential/index.ts` barrel and `index.test.ts` asserting its
      public surface
- [x] T060 [US3] Flush any pending rotation from `apps/sisyphus-executor/src/session/suspend.ts`, extending
      `suspend.test.ts` to cover it. `suspend()` is already the single routine for pause, stop and spot
      interruption, so one flush covers all three — and this flush is the difference between a recoverable seat
      and one needing re-login.
- [x] T061 [US3] Confirm `/workspace/.agent-config/credentials/` remains excluded from the tar in
      `apps/sisyphus-executor/src/session/snapshot-archive.ts` (FR-013), and that its existing test still
      asserts the exclusion. Unchanged from 002 — what changes is only where material comes from on the way
      back in.
- [x] T062 [US3] Remove agent credential installation from the setup bundle path in
      `apps/sisyphus-executor/src/bootstrap/bundle.ts`, extending `bundle.test.ts` to assert bundle validation
      still completes **without** a credential (FR-052, FR-048, superseding `002/FR-043` and `002/FR-075`) —
      validation never reaches `credential_install`.

**Checkpoint**: A workflow runs end to end on a leased seat, under a proven exclusivity guarantee. This is the
mechanism the whole spec exists to provide. T036–T039 all pass.

---

## Phase 6: User Story 4 - A workflow waits instead of burning compute (Priority: P1)

**Goal**: A workflow admitted against a dry pool waits visibly, holds no instance, and starts when a seat frees.

**Independent Test**: Hold every seat, admit one more workflow, confirm it reports waiting-for-seat, has no
instance provisioned against it, and starts automatically when a seat is released.

### Tests for User Story 4

- [x] T063 [P] [US4] The FR-029 wait-reason suite in
      `apps/sisyphus-control-plane/src/credentials/allocate/wait-reason.test.ts` covering all four cases — all
      held, all cooling off, all unhealthy/disabled, and the attached groups containing **no credentials at
      all** reported as a configuration fault rather than a wait

### Implementation for User Story 4

- [x] T064 [US4] Enter `awaiting_credential` rather than `provisioning` when T040 returns nothing, in
      `apps/sisyphus-control-plane/src/jobs/admit-workflow.ts`, and provision no compute (FR-024, FR-025)
- [x] T065 [US4] Grant a released credential to the longest-waiting **reachable** waiter in
      `apps/sisyphus-control-plane/src/jobs/drain-queue.ts` per
      [allocation-protocol.md → Granting](./contracts/allocation-protocol.md#granting-to-waiters), with a
      colocated test for the reachability skip that proves SC-017: saturating one group does not stall profiles
      attached elsewhere
- [x] T066 [US4] Handle the cancelled-in-the-same-moment race in `drain-queue.ts`, with a colocated test: a seat
      must be neither lost to a workflow that no longer exists nor granted twice
- [x] T067 [US4] Fail a workflow that waits beyond `SISYPHUS_CREDENTIAL_WAIT_LIMIT_MINUTES`, naming credential
      exhaustion and recording the wait duration, in
      `apps/sisyphus-control-plane/src/jobs/drain-queue.ts` (FR-028)
- [x] T068 [US4] Allow cancellation from `awaiting_credential`, terminating without ever provisioning an
      instance and releasing no lease because none was held (FR-027)
- [x] T069 [US4] Create `apps/sisyphus-control-plane/src/credentials/allocate/wait-reason.ts` satisfying T063,
      naming the groups searched
- [x] T070 [US4] Surface waiting state, wait duration and the T069 reason on the workflow view at
      `apps/sisyphus-admin/src/app/(app)/workflows/[id]/page.tsx` (SC-006). Engineer-facing and **not** pushed
      as a notification (FR-079).

**Checkpoint**: 🎯 **MVP COMPLETE.** Seats are registered, grouped, scoped, leased for a lifetime under a proven
exclusivity guarantee, rotated through, released, reconciled and queued. Everything below adds resilience, cost
control and operability to a system that already works and is already tested.

---

## Phase 7: User Story 1b - Hosted login environment (Priority: P1)

**Goal**: An administrator completes a credential's login inside platform infrastructure; material is captured
server-side and never transits their device.

**Independent Test**: Register a credential, complete the login in the relayed session, confirm state goes
`available`, the environment is gone, and no material appeared in any panel network response.

**Closes the Phase 4 gap**: FR-069, FR-071, FR-072 and SC-001.

### Tests for User Story 1b

- [x] T071 [US1] Integration test for the login flow, extending
      `packages/sisyphus-api/src/server/admin/credentials.test.ts`: an abandoned session (tab closed, no
      completion event) is still reaped by wall-clock (FR-071) — the case least likely to be caught any other
      way, because it produces no event to assert against except the reap itself

### Implementation for User Story 1b

- [x] T072 [US1] Extend `apps/sisyphus-control-plane/src/aws/compute.ts` and `compute.test.ts` to launch a
      **bundle-less, workspace-less** login instance carrying only the agent CLI, tagged so it is
      distinguishable from workflow instances and unreachable by any workflow (FR-069, FR-071)
- [x] T073 [US1] Mirror the login-instance launch in `apps/sisyphus-control-plane/src/aws/compute-fake.ts` and
      `compute-fake.test.ts`
- [x] T074 [US1] Create `apps/sisyphus-control-plane/src/credentials/login/environment.ts` and its colocated
      test — provision and destroy the ephemeral environment over the T072 seam
- [x] T075 [US1] Create `apps/sisyphus-control-plane/src/credentials/login/relay.ts` and its colocated test —
      the SSM session relayed to the administrator, over the already-present `@aws-sdk/client-ssm`
- [x] T076 [US1] Create `apps/sisyphus-control-plane/src/credentials/login/capture.ts` and its colocated test —
      read the resulting material on the instance and write it to the secret store **via the machine surface,
      exactly as a rotation is** (T052), so login and rotation are one mechanism with one failure mode rather
      than two
- [x] T077 [US1] Create `apps/sisyphus-control-plane/src/credentials/login/reaper.ts` satisfying T071 — a
      **wall-clock** reaper, not one waiting on a completion event
- [x] T078 [US1] Add `apps/sisyphus-control-plane/src/credentials/login/index.ts` barrel and `index.test.ts`
      asserting its public surface, and register the reaper in `apps/sisyphus-control-plane/src/jobs/index.ts`
- [x] T079 [US1] Add `startLogin` and `loginStatus` to
      `packages/sisyphus-api/src/server/admin/credentials.ts`, recording failure reasons against the credential
      (FR-009)
- [x] T080 [US1] Add the relayed login UI at
      `apps/sisyphus-admin/src/app/(app)/admin/credentials/[id]/login/page.tsx`
- [x] T081 [US1] Delete the T030 `adoptSecret` procedure and its panel affordance, and replace quickstart
      Scenario 2a with the real flow

**Checkpoint**: A seat goes from nothing to usable in one session, under 5 minutes, with no operator shell.

---

## Phase 8: User Story 7 - Seats stay alive without being used (Priority: P2)

**Goal**: No seat expires from disuse, and a provider limit is never mistaken for a breakage.

**Independent Test**: With no workflows running, advance past the idle threshold and confirm every seat has been
exercised and its liveness time updated — including in a group no workflow ever touched.

### Tests for User Story 7

- [x] T082 [P] [US7] Health classification against **recorded provider responses** in
      `apps/sisyphus-control-plane/src/credentials/health/classify.test.ts` — rate limit, auth failure, and the
      ambiguous case resolving to `cooling_off` (research R5). Do not provoke a real rate limit as an
      acceptance step; the fixture is recorded responses, not a live call.
- [x] T083 [P] [US7] The keep-alive suite in
      `apps/sisyphus-control-plane/src/credentials/liveness/schedule.test.ts`, with three assertions:
      **every member of an untouched lower-preference group was exercised** — the case that proves LRU alone
      would not have sufficed; a leased or disabled credential is skipped (FR-036); and — the FR-038 edge case —
      **a keep-alive claim racing a workflow reservation for the same idle seat, where exactly one wins and the
      loser observes zero rows affected**. Drive both orderings. A read-then-act implementation passes the skip
      assertion and fails this one, which is the whole reason it is written separately.

### Implementation for User Story 7

- [x] T084 [US7] Create `apps/sisyphus-control-plane/src/credentials/health/classify.ts` satisfying T082 —
      **one exported function**: rate/usage limit ⇒ `cooling_off` with `cooling_off_until` where stated,
      auth/authorisation failure ⇒ `unhealthy`, **ambiguous ⇒ `cooling_off`**. The asymmetry is deliberate: a
      wrongly-cooled credential returns by itself, a wrongly-unhealthy one waits for a human.
- [x] T085 [US7] Create `apps/sisyphus-control-plane/src/credentials/health/transition.ts` and its colocated
      test applying the T084 verdict to the credential row, alerting on `unhealthy` and **raising nothing** on
      `cooling_off` (FR-037, FR-076, SC-019), plus
      `apps/sisyphus-control-plane/src/credentials/health/index.ts` and its colocated test. Every transition
      writes a `state_changed` audit entry naming both states — FR-058 covers credential state changes, not only
      lease events, and this is the module every one of them passes through.
- [x] T086 [US7] Add the cooling-off return sweep to `apps/sisyphus-control-plane/src/jobs/reconcile.ts`:
      credentials past `cooling_off_until`, **and those with none set** retried on
      `SISYPHUS_COOLING_OFF_RETRY_MINUTES`, return to `available` and immediately re-enter T065's grant path
      (FR-076, FR-078)
- [x] T087 [US7] Create `apps/sisyphus-control-plane/src/credentials/liveness/schedule.ts` satisfying T083 —
      selecting credentials `available`, enabled, `last_exercised_at` older than
      `SISYPHUS_KEEPALIVE_IDLE_HOURS`, **regardless of group** (FR-035), skipping disabled credentials (FR-036).
      **Claiming is the same conditional update T042 uses**, not a read-then-act check:
      `UPDATE agent_credentials SET state = 'held', held_by = 'keep_alive' WHERE id = :id AND state =
'available'`, and zero rows affected means a workflow reservation won the row — keep-alive yields and moves
      on. Reading `state` and then exercising would let both parties observe `available` and both proceed, which
      is exactly the concurrent use FR-038 forbids and the double-use this whole feature exists to prevent.
      Release back to `available` when the exercise finishes, whatever its outcome.
- [x] T088 [US7] Create `apps/sisyphus-control-plane/src/credentials/liveness/exercise.ts` and its colocated
      test — exercise the credential, write a `keep_alive_runs` row, update `last_exercised_at`, route failures
      through T084
- [x] T089 [US7] Add `apps/sisyphus-control-plane/src/credentials/liveness/index.ts` and `index.test.ts`
      asserting its public surface, and register the keep-alive job in
      `apps/sisyphus-control-plane/src/jobs/index.ts` and
      `apps/sisyphus-control-plane/src/jobs/sync-schedules.ts`
- [x] T090 [US7] Make a run whose own credential enters `cooling_off` **wait rather than fail**, retaining its
      lease, in `apps/sisyphus-control-plane/src/jobs/run-job.ts`, with a colocated test (FR-077, SC-020) —
      FR-023 forbids substituting another credential, so waiting is the only correct behaviour

**Checkpoint**: A pool left alone for a month still works. T082–T083 pass.

---

## Phase 9: User Story 5 - Pause keeps the session on its instance (Priority: P2)

**Goal**: Pause stops the instance with its disk retained; resume starts the same instance.

**Independent Test**: Pause a run, confirm the instance is stopped and no longer billing compute, resume, and
confirm the agent continues the same conversation against the same working tree.

**⚠️ Two purchase modes, one code path** (research R6): `spot` **cannot be stopped** and is the platform
default, so spot pauses degrade to 002's snapshot-and-terminate — routed through the FR-043 fallback rather than
written as a second path.

### Tests for User Story 5

- [x] T091 [US5] The pause/resume suite in `apps/sisyphus-control-plane/src/jobs/pause-instance.test.ts` across
      **both** purchase modes: `on_demand` stops with disk retained and resumes with no re-provision;
      `spot` snapshots and terminates per 002; in both, the credential **lease is retained** throughout (FR-040)

### Implementation for User Story 5

- [x] T092 [US5] Add `stop`, `start` and `describeVolumes` to the `ComputeProvisioner` seam in
      `apps/sisyphus-control-plane/src/aws/compute.ts`, currently terminate-only, extending `compute.test.ts`.
      **Leave `InstanceInitiatedShutdownBehavior: 'terminate'` alone** — it is what stops a crashed executor
      leaking a billable stopped instance, and the pause path calls `StopInstances` from the control plane
      instead.
- [x] T093 [US5] Mirror the three methods in `apps/sisyphus-control-plane/src/aws/compute-fake.ts`, extending
      the existing `compute-fake.test.ts` to assert a stopped instance keeps its volume — the behaviour every
      pause test below depends on the fake getting right
- [x] T094 [US5] Create `apps/sisyphus-control-plane/src/jobs/pause-instance.ts` satisfying T091 — turn
      boundary, durable snapshot, then `StopInstances` for `on_demand`, replacing the hold-alive behaviour of
      `002/FR-049` (FR-039)
- [x] T095 [US5] Branch `spot` to snapshot-and-terminate in `pause-instance.ts` via the FR-043 fallback,
      satisfying the rest of T091, and record which path a pause took so SC-007 can be reported per mode rather
      than as one misleading number
- [x] T096 [US5] Resume as `StartInstances` on the same instance in
      `apps/sisyphus-control-plane/src/jobs/start-workflow.ts` — no re-provision, no re-clone, no restore
      (FR-041). `credential_install` still runs on this boot (FR-050): material may have rotated while the
      instance was stopped.
- [x] T097 [US5] Recover onto a fresh instance from the durable snapshot **holding the same credential** when a
      stopped instance will not start, recording the substitution, with a colocated test (FR-043)
- [x] T098 [US5] Replace the hold-alive path with the stop path in
      `apps/sisyphus-executor/src/session/suspend.ts`, keeping the T060 rotation flush ahead of it
- [x] T099 [US5] Report a paused workflow as incurring storage but **not** compute cost in
      `apps/sisyphus-control-plane/src/jobs/cost-basis.ts`, extending `cost-basis.test.ts` (FR-042, SC-008)

**Checkpoint**: Pause is cheap enough to use freely, on `on_demand`; `spot` keeps 002 behaviour honestly. T091
passes for both modes.

---

## Phase 10: User Story 6 - A long-paused workflow parks (Priority: P2)

**Goal**: Past the idle limit, instance and disk are released, work survives durably, and the seat stays held.

**Independent Test**: Pause a run, advance past the idle limit, confirm it is parked-resumable, its instance and
disk are gone, its seat is still held by it, and it resumes under the same credential.

### Tests for User Story 6

- [x] T100 [US6] Extend `apps/sisyphus-control-plane/src/jobs/pause-instance.test.ts` (from T091) to cover
      parking: past the idle limit, instance and disk are released, the lease is retained (FR-073), and
      **exactly one lease row exists per workflow** across the full pause→park→resume cycle (SC-018) — proving
      no environment rebuild ever moves the workflow to a different credential

### Implementation for User Story 6

- [x] T101 [US6] Release instance **and disk** past the idle limit in
      `apps/sisyphus-control-plane/src/jobs/pause-instance.ts`, marking the workflow `parked_resumable` and
      reporting it as parked rather than failed, satisfying half of T100 (FR-044). The lease is retained
      (FR-073) — a parked run consumes a seat while consuming no compute, which is the trade the pool view must
      make visible.
- [x] T102 [US6] **Refuse** to release the instance or disk when the durable snapshot is not resumable, raising
      the condition instead, with a colocated test (FR-045). This inverts the normal cost priority deliberately:
      an unresumable park is indistinguishable from data loss.
- [x] T103 [US6] Resume a parked workflow onto a fresh instance **without reserving or waiting for a
      credential** in `apps/sisyphus-control-plane/src/jobs/start-workflow.ts`, satisfying the rest of T100
      (FR-046) — it never released the one it holds
- [x] T104 [US6] Release the lease when a parked workflow becomes terminal by its snapshot passing the retention
      period, in `apps/sisyphus-control-plane/src/jobs/reconcile.ts`, with a colocated test (FR-073)
- [x] T105 [US6] Show time remaining before parking on the workflow view at
      `apps/sisyphus-admin/src/app/(app)/workflows/[id]/page.tsx` (FR-047)

**Checkpoint**: A forgotten pause costs storage, not an instance. T100 passes.

---

## Phase 11: User Story 8 - An administrator can see and steer the pool (Priority: P2)

**Goal**: One view answers "should we buy another seat", per group.

**Independent Test**: With seats in mixed states and at least one workflow waiting, open the pool view and
confirm every state is distinguishable and queue depth and wait times are shown.

### Tests for User Story 8

- [x] T106 [P] [US8] Contract test for the pool view in
      `packages/sisyphus-api/src/server/admin/credential-pool.test.ts`: every state distinguishable and grouped
      by credential group, holders broken down `running`/`paused`/`parked` (FR-074), queue depth and longest
      wait **per group** (FR-054), spend attributable per credential (FR-055), a non-administrator refused
      entirely, and **no** notification fired for waiting/cooling-off/parking while admin alerts still do
      (FR-079)

### Implementation for User Story 8

- [x] T107 [US8] Create `packages/sisyphus-api/src/server/admin/credential-pool.ts` — the FR-053 pool query:
      per credential, state, health, holder, hold duration, `last_used_at`, `last_exercised_at`,
      `cooling_off_until`, grouped by credential group
- [x] T108 [US8] Break holders down by `running` / `paused` / `parked` — plus `keep_alive` where `held_by` says
      so — in `credential-pool.ts`, satisfying part of T106 (FR-074). A parked holder shows no activity while
      consuming capacity indefinitely, which makes a full pool look idle; a keep-alive holder is transient and
      must not be mistaken for one, or an administrator reads a routine exercise as a stuck seat.
- [x] T109 [US8] Add the queue view to `credential-pool.ts`, satisfying part of T106: depth and longest current
      wait **per group**, derived from `workflows` in `awaiting_credential` joined to profile attachments —
      there is no queue table, by design (FR-054, SC-011)
- [x] T110 [US8] Attribute consumption and spend per credential by joining through `workflows.agent_credential_id`
      in `credential-pool.ts`, satisfying part of T106 (FR-055) — no second ledger, so no drift
- [x] T111 [US8] Add the FR-056 administrator alerts via `packages/sisyphus-notify`, with a colocated test —
      approaching expiry, became unhealthy, requires re-login, lease held beyond
      `SISYPHUS_LEASE_HOLD_EXPECTATION_HOURS`, naming the holding workflow
- [x] T112 [US8] Mount `credentialPoolRouter` as `adminProcedure` on `adminRouter`, satisfying the rest of T106
      (FR-053, data-model → Access scoping)
- [x] T113 [US8] Add the pool view page at
      `apps/sisyphus-admin/src/app/(app)/admin/credentials/pool/page.tsx`

**Checkpoint**: An under-sized group is distinguishable from an under-sized pool in under 30 seconds. T106
passes.

---

## Phase 12: User Story 9 - An administrator recovers a broken seat (Priority: P3)

**Goal**: A broken seat can be taken out of service, forced free, re-logged-in and returned — disturbing no
other run.

**Independent Test**: Break a seat's login, confirm it is marked unhealthy and excluded from selection,
re-login, and confirm it returns to the pool.

### Tests for User Story 9

- [x] T114 [P] [US9] Extend `packages/sisyphus-api/src/server/admin/credentials.test.ts` (from T028):
      force-release resolves the affected workflow to a recorded state and the next acquisition's fence
      increment rejects the old holder's writes (FR-057); an unhealthy credential is excluded from T040's
      selection **before** it can be issued to a second workflow, asserted on the selection query rather than on
      the second workflow's failure (SC-010)
- [x] T115 [P] [US9] Extend `apps/sisyphus-control-plane/src/credentials/allocate/wait-reason.test.ts` (from
      T063): a seat disabled while workflows wait must not leave the queue waiting on capacity that will never
      arrive

### Implementation for User Story 9

- [x] T116 [US9] Add force-release to `packages/sisyphus-api/src/server/admin/credentials.ts`, satisfying part
      of T114: releases the lease as `forced` with `released_by_user_id`, resolves the affected workflow to a
      recorded state, and writes a `force_released` audit entry attributed to the acting administrator (FR-057,
      FR-058)
- [x] T117 [US9] Route re-login through the **identical** Phase 7 flow (FR-072) — returning a broken credential
      to service must not be a lesser-tested path than creating one
- [x] T118 [US9] Fail a run whose credential goes `unhealthy` **naming the credential**, with no substitution
      and no silent retry on another seat, in `apps/sisyphus-control-plane/src/jobs/run-job.ts` (FR-023, FR-033)
- [x] T119 [US9] Exclude an unhealthy credential from T040's selection, satisfying the rest of T114 (SC-010)
- [x] T120 [US9] Handle the FR-029 edge from T115 in
      `apps/sisyphus-control-plane/src/credentials/allocate/wait-reason.ts`
- [x] T121 [US9] Add recovery controls — disable, force-release, re-login, delete-refusal — to
      `apps/sisyphus-admin/src/app/(app)/admin/credentials/[id]/page.tsx`

**Checkpoint**: Logins break; recovery takes under 5 minutes and touches nothing else. T114–T115 pass.

---

## Phase 13: Polish & Cross-Cutting Concerns

**Purpose**: What no single story owns — provider measurements, the material-leak audit that spans every
component, the full quickstart walkthrough, and the merge gate.

- [x] T122 The material-leak audit (SC-014), spanning every story above: assert no credential material in the
      job envelope, snapshots, log segments or any panel response. Extend
      `apps/sisyphus-control-plane/src/jobs/job-envelope.test.ts` and the executor redaction tests from T054.
      **Decode the instance user-data by hand** as well — user-data is readable from the metadata service, so
      this one is worth not trusting a test with.
      → The cross-cutting suite is `packages/sisyphus-api/src/server/admin/material-leak-audit.test.ts`: it
      moves real material through both machine procedures and then sweeps every text, varchar and JSON column
      in the schema, asked of `information_schema` rather than listed, with a planted-leak negative control so
      a sweep that stopped searching correctly fails rather than passes silently. The by-hand decode was run
      against a real envelope from the real provisioning path and is recorded in
      [outstanding.md](./outstanding.md); the remaining metadata-service read belongs to T123.
- [ ] T123 Walk [quickstart.md](./quickstart.md) scenarios 1–8 end to end against a real stage and record the
      results, including the abandoned-login reap (T071) and the by-hand envelope check (T122)
- [ ] T124 [P] Run the **R1 measurement** (research.md): register a credential, force a refresh, attempt a call
      with the predecessor, record whether and for how long it is accepted. Tunes retry/alerting posture in
      `credentials/health/` — it changes a threshold, not an architecture.
- [ ] T125 [P] Run the **R2 measurement**: leave a registered credential untouched and probe periodically to
      find the real idle-expiry window, then set `SISYPHUS_KEEPALIVE_IDLE_HOURS` from evidence rather than from
      the conservative 24h default
- [x] T126 [P] Update `specs/002-sisyphus-workflow-platform/` where this feature supersedes it —
      `002/FR-043`, `002/FR-049`, `002/FR-072`, `002/FR-075` — per
      [Relationship to 002](./spec.md#relationship-to-002), so the two specs do not contradict each other in the
      repository
      → All four are struck through in place with a note naming what replaced them, never deleted: 002 is the
      record of what the platform was designed to do, and a requirement that quietly vanished would leave every
      code comment citing it pointing at nothing. A banner at the top of `002/spec.md` names the four. Three
      further contradictions were found and amended the same way — the setup-bundle prose in 002's overview and
      US7, the `paused` row in `002/data-model.md`, and the snapshot exclusion and suspend sketch in
      `002/contracts/executor-protocol.md`.
- [ ] T127 [P] Record SC-007 as **two** figures, `on_demand` and `spot`, rather than one — the paths genuinely
      differ and a single number would misrepresent both
- [x] T128 Audit barrels and imports across every new directory: public API through `index.ts` only, no
      consumer reaching into a module path, no `.js` extensions (Constitution Principle II,
      `.claude/rules/typescript-conventions.md`)
      → No `.js` import extension anywhere in the workspace. Every new directory has a barrel and every barrel
      but one had a test asserting its surface; `apps/sisyphus-executor/src/output/index.test.ts` was added for
      the one that did not, and it asserts the absence of any export that would hand back a registered secret.
      `credentials/allocate/pool-fixtures.ts` is reached directly by 17 suites and by no production module, and
      both the `allocate` and `lease` barrel tests still assert it stays unexported — verified rather than
      "fixed". The type-only imports from `server/context.ts` into `admin/credential-leases`,
      `admin/credential-login` and `machine/credential-material` are the pre-existing pattern beside
      `admin/reachability` and cannot go through a barrel: the barrels import the procedures that import this
      module. (`admin/reachability` has since been removed by `specs/004-remove-reachability-gate`, which
      landed on `feature/sisyphus` after this audit; the three type-only imports are unaffected.)
- [x] T129 Run the full gate — `pnpm nx affected -t lint test typecheck` and `pnpm qlty:diff` — green with **no
      threshold overrides** (Constitution Principle IV). Run as `run-many` over all six projects rather than
      `affected`: this branch is off `feature/sisyphus`, and an `affected` base that excluded the feature's own
      commits would have graded a subset. No `QLTY_*` override was set. Observed: lint clean across all six
      (one pre-existing warning in `apps/sisyphus-admin/open-next.config.ts`, zero errors); typecheck clean;
      **7080 tests passing, 7 skipped, across 656 test files**; `pnpm qlty:diff` vs `origin/main` — 0 issues at
      medium+ (0 security, max 0), duplication 1.0% (384/37479 lines, max 10%), complexity reported and
      unthresholded — "within thresholds".

---

## Phase 14: Integration gaps found after Phase 13

**Purpose**: Two things the story-by-story tasks each left correct in isolation and unreachable together, and
one defect the first of them exposed. All three were found while auditing Phase 13 rather than while building
a story, which is the failure mode a per-story task list has.

- [x] T130 **Wire pause and resume into dispatch.** `jobs/pause-instance.ts` and `resumeWorkflow` were
      implemented, tested and exported from the jobs barrel with **no route to them**:
      `CONTROL_PLANE_JOB_NAMES` listed neither, so Phases 9 and 10 were dead code in production and a pause was
      an instance left running until the reconciler parked it. Both are now per-workflow events on exactly the
      footing `start-workflow` and `teardown-workflow` are on, routed with the same dependencies their own
      suites take, with routing tests. Neither is in the tick sequence: both name one run, and the
      population-level backstop for an unattended pause is `reconcile`, which is in the sequence already.
- [x] T131 **A paused run's silence stopped being evidence** (`reconcile.ts`). Exposed by T130 and load-bearing:
      under `002/FR-049` a pause held the agent alive on a running instance, so a paused run went on beating.
      003/FR-039 stops the instance, so it cannot — and the heartbeat-lapse check would have declared every
      correctly paused run dead five minutes after it was paused and terminated the instance the pause exists
      to keep, silently converting FR-041's start-the-same-box resume into FR-043's rebuild on every pause.
      `silenceIsEvidenceFor` exempts `paused` from the two silence checks and from nothing else; the checks
      that ask whether the instance still exists are untouched.
- [x] T132 **Panel IAM for the secret store** (003/FR-012). `apps/sisyphus-admin/sst.config.ts` passed no
      `permissions` at all, so the machine surface mounted at `/api/machine` could not reach Secrets Manager
      and every instance would have failed `credential_install` on a stage that deployed cleanly — and
      `buildPanelBundlesPolicy`, which had existed since 002, was applied to nothing. `buildPanelPolicy` in
      `packages/sisyphus-infra/src/policies.ts` composes the bundles grants with `GetSecretValue` and
      `PutSecretValue` scoped by ARN to `getAgentCredentialSecretPrefix(scope)`, refuses an empty prefix rather
      than widening to `secret:/*`, and grants no `CreateSecret`, `DeleteSecret`, `ListSecrets` or
      `UpdateSecret`. Asserted to be scoped to the same prefix the control plane writes under.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies
- **Phase 2 (Foundational)**: Depends on Phase 1 — **blocks every story**
- **Phase 3 (US2)**: Depends on Phase 2. Blocks Phase 4 — FR-061 assigns a group at registration, so groups must
  exist before credentials
- **Phase 4 (US1a)**: Depends on Phase 3. Blocks Phase 5 — nothing can be leased from an empty pool
- **Phase 5 (US3)**: Depends on Phase 4. Blocks Phase 6
- **Phase 6 (US4)**: Depends on Phase 5 — the queue grants what release frees
- **Phase 7 (US1b)**: Depends on Phase 2 only; deliberately scheduled after the MVP checkpoint
- **Phase 8 (US7)**: Depends on Phase 5 (needs leases to skip) and Phase 6 (returns feed the grant path)
- **Phase 9 (US5)**: Depends on Phase 5
- **Phase 10 (US6)**: Depends on Phase 9 — parking is what happens to a pause that is left
- **Phase 11 (US8)**: Depends on Phases 6, 8 and 10 for the states it reports; partial value earlier
- **Phase 12 (US9)**: Depends on Phases 7 and 8 — re-login is Phase 7's flow, exclusion is Phase 8's health
- **Phase 13 (Polish)**: Last

### Critical path to MVP

```
T001–T003  →  T004–T018  →  T019–T027  →  T028–T035  →  T036–T062  →  T063–T070
  Setup       Foundational     US2 groups    US1a register   US3 lease core   US4 queue
              (schema + index                (tests → impl)  (tests → impl)   (tests → impl)
               proven here)
                                                                                   ↓
                                                                            🎯 MVP COMPLETE
```

### Within Each Story

- **Tests for the story are written first**, against the interface each contract already fixes
  (data-model.md, contracts/) — they fail until the matching implementation task lands, then pass
- Enums before schema; schema before migration; migration before any query
- Seams (`aws/*.ts`) and their fakes before the modules that call them
- Control-plane modules before the jobs that wire them
- Machine-surface procedures before the executor code that calls them
- Panel pages last within a story — they are the thinnest layer and the easiest to redo

### Parallel Opportunities

- **Phase 1**: T001 and T002 together
- **Phase 2**: T004 and T005 together; T015, T016 and T017 together once enums land
- **Phase 3**: T026 and T027 together once T019–T025 land
- **Phase 5**: T036, T037 and T039 together before any implementation exists; T050–T054 (API package) run
  alongside T055–T062 (executor) once T042–T045 exist — different members, contract fixed by T015
- **Phase 8**: T082 and T083 together before implementation
- **Phase 12**: T114 and T115 together

### Story Independence

US5, US6, US7, US8 and US9 are independently testable once the MVP exists and can be staffed in parallel. US1,
US2, US3 and US4 are a chain, not because the stories are coupled but because each supplies the precondition of
the next: a group holds a credential, a credential is leased, a lease that is unavailable is queued.

---

## Parallel Example: Phase 5

```bash
# Tests first, all three independent of each other and of any implementation:
Task: "Scoping suite in credentials/allocate/select.test.ts"
Task: "Fencing suite in credentials/lease/fence.test.ts"
Task: "Machine surface contract test in server/machine/agent-credential.test.ts"

# Then API package and executor, once the lease modules exist (T042–T045):
Task: "Add fetchAgentCredential in packages/sisyphus-api/src/server/machine/agent-credential.ts"
Task: "Create credential-install phase in apps/sisyphus-executor/src/bootstrap/credential-install.ts"
Task: "Create rotation watch in apps/sisyphus-executor/src/credential/rotation-watch.ts"
```

---

## Implementation Strategy

### MVP first (Phases 1–6)

1. Phase 1 + 2 — vocabulary, schema, secret seam; the exclusivity index is proven at the database level here
2. Phase 3 — groups, so a credential has somewhere to belong; contract test written first
3. Phase 4 — one registered seat, material seeded out of band; contract test written first
4. Phase 5 — **the mechanism**: lease, fetch, rotate, release, reconcile; the race and fencing suites are
   written before any of it exists
5. Phase 6 — the queue, so exhaustion is visible rather than mysterious; wait-reason suite first
6. **STOP and VALIDATE** against quickstart Scenarios 3 and 4

At this point a workflow provably runs end to end under exactly one agent identity, with the exclusivity
guarantee proven by a passing race suite — which is the entire reason this specification exists.

### Then, in value order

1. Phase 7 — removes the operator shell from registration (closes SC-001)
2. Phase 8 — stops seats rotting (closes SC-009, SC-019, SC-020)
3. Phases 9 + 10 — makes pause cheap (closes SC-007, SC-008)
4. Phase 11 — makes the pool steerable (closes SC-011)
5. Phase 12 — makes breakage recoverable (closes SC-012)
6. Phase 13 — provider measurements, the cross-cutting leak audit, and the merge gate

### Notes

- `[P]` means different files with no incomplete dependency
- Each story's distinct-deliverable tests are written **before** that story's implementation; each module's
  own colocated test is written **with** the module, not after it
- Commit per task or logical group; the pre-commit hook runs the colocated test of everything staged
- Stop at any checkpoint to validate the story independently
