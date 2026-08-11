---
description: 'Task list for Sisyphus — Supervised & Autonomous Agentic Delivery Platform'
---

# Tasks: Sisyphus — Supervised & Autonomous Agentic Delivery Platform

> **DEPRECATED (2026-08-11):** The Sisyphus workflow platform — including the executor, control plane, admin app, and agent credential pool described in this document — has been deprecated in favour of the Claude Code GitHub Action. This was because the GitHub Action is easier to maintain and configure, and more customizable than the bespoke infrastructure it replaced. This document is retained as a historical design record only; the packages and apps it describes have been removed from the repository.

**Input**: Design documents from `/specs/002-sisyphus-workflow-platform/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: **Required, not optional.** Constitution Principle III (NON-NEGOTIABLE) and FR-004 both require a
colocated `<name>.test.ts` beside every module. Writing that test is **part of the task that creates the module**,
not a follow-up — the pre-commit hook runs the colocated test of every staged source file and a failure blocks the
commit. Separate test tasks below exist only where the test is a distinct deliverable (contract tests against the
router, integration tests against a stub agent).

**Organization**: Grouped by user story, in the delivery order fixed by
[plan.md → Phase Sequencing](./plan.md#phase-sequencing).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: The user story this task serves (US1–US13)
- Every task names its exact path

## Path Conventions

Nx monorepo, six workspace members under the `@bluetel-ai/*` scope:

| Member                               | Role                             |
| ------------------------------------ | -------------------------------- |
| `packages/sisyphus-api`              | Schema + entire tRPC surface     |
| `packages/sisyphus-infra`            | SST/Pulumi primitives            |
| `packages/sisyphus-integration-jira` | The one connector implementation |
| `apps/sisyphus-admin`                | Network-facing panel             |
| `apps/sisyphus-control-plane`        | Non-network-facing job runner    |
| `apps/sisyphus-executor`             | Runs on the instance             |

All commands go through Nx (`pnpm nx …`) per Constitution Principle I.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Workspace members exist, are individually runnable, and the cross-cutting version problem is fixed
before any code depends on it.

- [x] T001 Pin `zod` to a single major in `pnpm-workspace.yaml` `overrides` and reconcile
      `packages/env-validation-errors/package.json`, whose `zod/v3` and `zod-validation-error/v3` imports
      contradict its declared `^3.24.0` peer — see [plan.md → Technical Context](./plan.md#technical-context).
      **Blocks everything**: a mixed graph produces "two Zods" failures inside tRPC `.input()` types that read as
      tRPC bugs.
- [x] T002 [P] Scaffold `packages/sisyphus-api` with `project.json`, `eslint.config.mjs`, `tsconfig.json`,
      `vitest.config.ts`, extending the shared `tooling/` configs rather than forking them
- [x] T003 [P] Scaffold `packages/sisyphus-infra` with the same four config files
- [x] T004 [P] Scaffold `packages/sisyphus-integration-jira` with the same four config files
- [x] T005 [P] Scaffold `apps/sisyphus-admin` (Next.js 16 + OpenNext) with the same four config files
- [x] T006 [P] Scaffold `apps/sisyphus-control-plane` with the same four config files
- [x] T007 [P] Scaffold `apps/sisyphus-executor` with the same four config files plus an esbuild bundle target
- [x] T008 Declare the four subpath exports in `packages/sisyphus-api/package.json` — `./server`, `./client`,
      `./contracts`, `./db` — and **no root `.` export**, per
      [api-surface.md → Package entry points](./contracts/api-surface.md#package-entry-points--the-boundary-is-the-exports-map).
      This is what makes the FR-005 boundary a build-time fact rather than a review convention.
- [x] T009 [P] Add the cached `design-lint` target to `apps/sisyphus-admin/project.json` with the linter as a
      **pinned devDependency** (never `npx`, which resolves outside the lockfile and is invisible to the affected
      graph) per [design-tokens.md → design-lint](./contracts/design-tokens.md#design-lint)
- [x] T010 [P] **Extend** the existing pipeline in `.github/workflows/ci.yml` — add `design-lint` to the `main`
      job's `nx affected -t lint test typecheck` run. Do **not** add a second CI provider: the `qlty` job, the
      affected-project job, the `--withTarget=trigger-deploy` discovery and the branch gating to `main`/`staging`
      already exist there, and splitting the two blocking gates across two systems leaves one of them not
      running `design-lint` (FR-069, research.md R12)

**Checkpoint**: Every member builds, lints and typechecks in isolation from its own directory.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The three spikes that gate real code, plus the contract, schema and auth every story reads.

**⚠️ CRITICAL**: No user story work can begin until this phase completes.

### Gate 0 — spikes (research.md S1, S2, S3)

- [x] T011 [P] Spike S1 (2 days): NDJSON stdin turn injection — `apps/sisyphus-executor/src/agent/spike-stdin.ts`.
      Confirm a user-turn frame written to stdin mid-request reaches the **in-flight** request. **Build the
      `AgentAdapter` boundary first (T035)**; if S1 fails, the Agent SDK fallback is a module swap, and if the
      boundary does not already exist it is a rewrite instead.
- [x] T012 [P] Spike S2 (1 day): cross-instance restore — `apps/sisyphus-executor/src/session/spike-restore.ts`.
      Snapshot on instance A, restore on B, `--resume` finds the session, uncommitted work present, deliberately
      truncated final line discarded.
- [x] T013 [P] Spike S3 (1 day): live-log transport under connection pooling —
      `apps/sisyphus-admin/src/app/api/stream/spike-log-stream.ts`. `LISTEN/NOTIFY` needs a **pinned session**,
      which transaction-mode pooling does not provide; verify ≥95% of segments visible within 5s (SC-002) and
      defined behaviour on runtime recycle. Fallbacks are pre-chosen in research.md R6.

### Database foundation

- [x] T014 Create the Drizzle client factory and pooled connection in `packages/sisyphus-api/src/db/client.ts`
- [x] T015 Set up the forward-only migration runner and `migrate` target in
      `packages/sisyphus-api/src/db/migrations/`, runnable independently of any deploy (FR-010)
- [x] T016 [P] Define every enum in `packages/sisyphus-api/src/enums/` — `workflow_state`, `workflow_type`,
      `terminal_outcome`, `user_role`, `purchase_mode`, `claude_model`, `integration_type`. `terminal_outcome`
      MUST be FR-064's set verbatim: `succeeded`, `failed`, `capped`, `cancelled`, `needs_attention`,
      `parked_resumable`. `claude_model` is an allowlist of exact ids with no date suffixes (research.md R15).
- [x] T017 [P] Schema: `users`, `role_changes`, `profile_access_grants` in
      `packages/sisyphus-api/src/db/schema/identity.ts` with the partial unique index on
      `(user_id, execution_profile_id) WHERE revoked_at IS NULL`
- [x] T018 [P] Schema: `workflows`, `workflow_entries`, `workflow_events`, `compute_leases`, `bootstrap_phases`
      in `packages/sisyphus-api/src/db/schema/workflow.ts`, including the two `compute_leases` indexes that make
      FR-078 and FR-040 hold at the database rather than in application timing
- [x] T019 [P] Schema: `setup_bundles`/`setup_bundle_versions`/`validation_runs` in
      `packages/sisyphus-api/src/db/schema/bundle.ts`
- [x] T020 [P] Schema: `workspaces`/`workspace_versions`/`workspace_entries` and
      `execution_profiles`/`execution_profile_versions` in `packages/sisyphus-api/src/db/schema/profile.ts`.
      **Entries and launch values hang off the version, not the parent row** — a mutable row with a version
      integer cannot satisfy FR-125, because the number would point at content that no longer exists.
- [x] T021 [P] Schema: `integrations`, `integration_mappings`, `integration_runs`, `ticket_claims` in
      `packages/sisyphus-api/src/db/schema/integration.ts`. `prompt_intro` is **not null** (FR-158), and
      `ticket_claims` carries the unique `(integration_id, external_id)` index that makes exactly-once claiming
      hold across restarts and overlapping ticks rather than by application logic (FR-102).
- [x] T022 [P] Schema: `log_segments`, `session_snapshots`, `artifacts`, `skill_references` in
      `packages/sisyphus-api/src/db/schema/run-record.ts`
- [x] T023 [P] Schema: `corrections`, `supervision_commands`, `profile_overrides`, `external_actions`,
      `scoped_credentials`, `iterations`, `review_findings` in
      `packages/sisyphus-api/src/db/schema/supervision.ts`
- [x] T024 [P] Schema: `notifications`, `notification_preferences`, `workflow_watchers`, `configuration_audit`
      in `packages/sisyphus-api/src/db/schema/notify.ts`. Absence of a preference row means **enabled** — the
      default is not silence.

### Contract foundation

- [x] T025 Build `createTRPCSetup` in `packages/sisyphus-api/src/server/trpc.ts` with an **async**
      `createAdditionalContext`, `superjson`, and an `errorFormatter` flattening `ZodError` into `data.zodError`.
      Async is required, not stylistic: a synchronous hook cannot await the session or grant query, forcing scope
      re-derivation into every resolver — the silent-leak shape FR-190 cannot survive.
- [x] T026 Implement scope resolution in `packages/sisyphus-api/src/server/scope.ts` as a **memoised resolver**
      exposing one base selector every workflow query composes from, so health checks and machine calls never pay
      for a grants query (FR-190)
- [x] T027 Implement the five procedure types in `packages/sisyphus-api/src/server/procedures.ts` —
      `publicProcedure`, `authedProcedure`, `adminProcedure`, `scopedProcedure`, `machineProcedure`
- [x] T028 [P] Input schemas in `packages/sisyphus-api/src/schemas/`, exported from `./client` and consumed by
      both `.input()` and the panel's forms so the two cannot drift
- [x] T029 [P] Export `AppRouter` type, `RouterInputs`/`RouterOutputs` and enums from
      `packages/sisyphus-api/src/client.ts` — these inference helpers are the **only** sanctioned way to type
      API-derived values; a hand-written DTO mirroring a procedure is duplication the qlty gate will flag
- [x] T030 Assemble `appRouter`, `machineRouter` and `createCaller` in `packages/sisyphus-api/src/server/root.ts`
- [x] T031 **Contract test**: out-of-scope reads return `NOT_FOUND`, never `FORBIDDEN`, in
      `packages/sisyphus-api/src/server/scope.test.ts`. `FORBIDDEN` confirms existence, which FR-190 forbids —
      this is the single most easily-broken rule in the contract, so it belongs in a test rather than in review
      vigilance.

### Auth, config and infra primitives

- [x] T032 Auth.js Google OAuth with **server-verified** `hd` claim and database-backed sessions in
      `apps/sisyphus-admin/src/app/api/auth/[...nextauth]/route.ts` — database-backed so deactivation takes
      effect at the next request rather than at next sign-in (FR-175)
- [x] T033 [P] `env.ts` + `env-schemas.ts` using `createSafeEnv` for all three deployables. Lint already enforces
      this (`@bluetel-ai/enforce-safe-env` is `error`), and it makes a missing bucket name fail at boot with a
      readable message rather than surfacing as `undefined` mid-bootstrap.
- [x] T034 [P] Infra primitives in `packages/sisyphus-infra/src/` — `lib.ts` (`getResourceIdentifier`,
      `getEnvSecret`), `get-plain-stage.ts`, `database.ts`, `buckets.ts`, `oidc-provider.ts`, `runner-role.ts`,
      `scheduler.ts`. `oidc-provider.ts` federates **GitHub Actions**
      (`https://token.actions.githubusercontent.com`), created by the production bootstrap and looked up by every
      other stage with a message naming the bootstrap step when absent (FR-068). The trust policy conditions on
      `sub` = `repo:<org>/<repo>:ref:refs/heads/main` for production and `refs/heads/staging` for staging, so
      FR-067's protected-branch rule is enforced by IAM and not by pipeline configuration alone.
- [x] T035 Define the `AgentAdapter` interface in `apps/sisyphus-executor/src/agent/adapter.ts` — `start`,
      `sendTurn`, `quiesce`, `stop`, `output`, `usage`. **Must exist before T011 concludes** (research.md R1).

**Checkpoint**: Spikes closed or fallbacks adopted; schema migrates; the router type-checks in all three
consumption modes; sign-in works.

---

## Phase 3: US7 + US12 + US13 — Bundles, users, scoped access (Priority: P1) 🎯 MVP FOUNDATION

**Goal**: An admin can register a setup bundle and prove it; roles and per-profile access exist; nothing leaks
across clients.

**These three ship together — deliberately.** Bundle registration without its admin gate means any user can
install client credentials, and an unscoped workflow list leaks across clients. Splitting them ships a hole.

**Independent Test**: quickstart.md 1a, 1a-bis, 1b (the grant and registration steps), 1c and 1e.

**What this phase deliberately cannot prove yet.** Four sub-scenarios need machinery that lands in Phase 4, and
their tasks moved there with it: 1b's **validation run** and 1d's **setup-output redaction** need provisioning
(T052), the AWS clients (T054), the machine surface (T063) and the redaction pipeline (T059/T060); 1f's **leak
test** and 1g need workflows to exist at all. No requirement is weakened by this — with zero workflows in the
database there is nothing for FR-190 to leak, so the gate is not deferred, only its evidence. **T041, T042, T046
and T047 are therefore listed in Phase 4**, and Phase 4's checkpoint carries the leak test as a release gate.

### US12 — users and roles

- [x] T036 [US12] Implement the `admin.users` sub-router (`list`, `setRole`, `setActive`, `roleChanges`) in
      `packages/sisyphus-api/src/server/admin/users.ts`, re-counting active admins **inside the transaction** so
      the never-zero-admins invariant cannot race (FR-173)
- [x] T037 [US12] Auto-create users as `engineer` on first successful sign-in in
      `apps/sisyphus-admin/src/lib/auth/on-sign-in.ts` (FR-170)
- [x] T038 [US12] Implement the idempotent bootstrap-admin reconcile in
      `apps/sisyphus-control-plane/src/jobs/bootstrap-admins.ts`, reading `SISYPHUS_BOOTSTRAP_ADMIN_EMAILS` and
      writing `role_changes` with a `system` actor. **Without this there is no first admin** — every route to
      `admin` requires an existing admin, so this phase cannot otherwise start (FR-174). A reconcile rather than
      a one-shot migration so recovering from zero-active-admins is a redeploy, not a manual database edit.
- [x] T039 [P] [US12] Admin user-management UI in `apps/sisyphus-admin/src/app/admin/users/page.tsx`

### US13 — profile-scoped access

- [x] T040 [US13] Implement the `admin.grants` sub-router in
      `packages/sisyphus-api/src/server/admin/grants.ts` (FR-179, FR-184, FR-188)
- [x] T043 [P] [US13] Grant-management UI on the profile detail page in
      `apps/sisyphus-admin/src/app/admin/profiles/[id]/access/page.tsx`

### US7 — setup bundles

- [x] T044 [US7] Implement the `admin.bundles` sub-router in
      `packages/sisyphus-api/src/server/admin/bundles.ts`. `bundles.list` is the one admin-only exception: any
      authenticated user may read the **enabled** list, because selecting a bundle is part of building a profile
      (FR-086).
- [x] T045 [US7] Archive upload to encrypted private storage with sha256 digest capture in
      `apps/sisyphus-admin/src/lib/bundles/upload.ts`; archives immutable once registered, replacement creates a
      version (FR-090)
- [x] T048 [P] [US7] Bundle management UI with latest validation result in
      `apps/sisyphus-admin/src/app/admin/bundles/page.tsx` (FR-148)
- [x] T049 [P] [US7] Write every bundle registration, replacement, enable and disable to
      `configuration_audit` with the acting admin, in
      `packages/sisyphus-api/src/server/admin/audit-log.ts` (FR-178)

**Checkpoint**: An admin registers a bundle and a non-admin cannot; the never-zero-admins invariant holds under
concurrent attempts; the bootstrap admin exists on a fresh stage; grants can be issued and revoked with an
audit trail. Bundle **validation** and the scoping leak test are Phase 4's checkpoint, per the note above.

---

## Phase 4: US1 — Delegate a ticket without losing ownership (Priority: P1) 🎯 MVP

**Goal**: An engineer launches a run, watches sanitised output live, and gets a draft PR with no ticket moved.

**Independent Test**: quickstart.md scenario 2 and 2a–2f, **plus the four sub-scenarios carried over from Phase
3**: 1b's validation run, 1d's setup-output redaction, 1f's leak test and 1g.

- [x] T050 [US1] Admission job in `apps/sisyphus-control-plane/src/jobs/admit-workflow.ts` — ceiling read at
      admission, count taken **inside** the transaction against `compute_leases` (leases, not workflow rows,
      because a lease is what costs money), queue position returned (FR-040)
- [x] T051 [US1] Queue drain in `apps/sisyphus-control-plane/src/jobs/drain-queue.ts`, re-admitting queued work
      when a lease releases. Without this the ceiling builds a queue nothing empties.
- [x] T052 [US1] Provisioning in `apps/sisyphus-control-plane/src/jobs/start-workflow.ts` — instance sized and
      priced per job spec, user-data envelope, no long-lived secret in it (FR-036)
- [x] T053 [US1] Scoped-credential mint and renew in `apps/sisyphus-control-plane/src/credentials/mint.ts` —
      short-lived, one workflow, machine surface only (FR-037)
- [x] T054 [P] [US1] AWS clients behind interfaces in `apps/sisyphus-control-plane/src/aws/` (EC2, S3, SSM,
      Scheduler), so the control plane is testable without provisioning real compute
- [x] T046 [US7] Bootstrap phases 2–5 in `apps/sisyphus-executor/src/bootstrap/bundle.ts` — download, verify
      digest, unpack, assert executable `setup.sh` at root, run it. Each failure names its phase rather than
      emitting a generic bootstrap error (FR-088, FR-146). _Moved from Phase 3: it cannot be exercised until
      provisioning (T052) and the machine surface (T063) exist, and it must precede T055's phase 6._
- [x] T047 [US7] Validation-run job in `apps/sisyphus-control-plane/src/jobs/validate-bundle.ts` using
      `mode: "validation"` on the envelope. Reports to `validation_runs`, **not** a workflow row — so
      `workflows.owner_user_id`, `assembled_prompt` and `workspace_version_id` stay non-null for real runs
      instead of being loosened to accommodate a validation (FR-147). _Moved from Phase 3: a validation run
      provisions, bootstraps and tears down an instance, so it depends on T046, T052, T054 and T066._
- [x] T055 [US1] Bootstrap phase 6 — per-entry checkout into the pinned root in
      `apps/sisyphus-executor/src/bootstrap/workspace.ts`, fully sequenced before phase 7: the agent never starts
      against an incomplete workspace (FR-112)
- [x] T056 [US1] NDJSON-stdin `AgentAdapter` implementation in `apps/sisyphus-executor/src/agent/cli-stream.ts`
      satisfying T035, with defensive frame parsing in `frames.ts` — an unrecognised frame is logged and skipped,
      never fatal, because the wire format is only lightly documented
- [x] T057 [US1] **Integration test** of the adapter against a stub agent process in
      `apps/sisyphus-executor/src/agent/cli-stream.test.ts`, so the loop is testable without paid inference
- [x] T058 [P] [US1] Control-sequence stripping in `apps/sisyphus-executor/src/output/strip-control.ts` — ANSI/VT
      escapes, spinner frames, cursor movement, carriage-return redraws (FR-045)
- [x] T059 [P] [US1] Two-stage redaction in `apps/sisyphus-executor/src/output/redact.ts` — pattern **plus
      known-value** matching against every credential the bundle installed; known-value is what catches a client
      credential in an unanticipated format (FR-045, FR-072)
- [x] T060 [US1] Sequenced segment writer in `apps/sisyphus-executor/src/output/segments.ts`, applying strip →
      redact → segment **before** anything is persisted or transmitted, so an unsanitised copy never exists at
      rest. Rate-limited and chunked rather than dropped (FR-047).
- [x] T061 [US1] Enforce `turnCap` and `spendCap` locally in `apps/sisyphus-executor/src/caps/enforce.ts` —
      stop at whichever is reached first, at the next **safe boundary**, reporting `capped` with consumption
      figures and preserving work in progress (FR-055). This is the only local brake on an unattended run; without
      it a badly-specified autonomous ticket has nothing between it and a surprise bill. Where the bundle declares
      spend unmeasurable the cap is **advisory** and shown as such, but the turn cap is still enforced (FR-093).
- [x] T062 [US1] Machine-surface client in `apps/sisyphus-executor/src/report/client.ts` using a **type-only**
      `AppRouter` import, with buffering and backoff when the surface is unreachable (FR-047)
- [x] T063 [US1] Machine-surface procedures in `packages/sisyphus-api/src/server/machine/` — `heartbeat`,
      `reportBootstrapPhase`, `appendLogSegment`, `reportTerminal`, `renewCredential`, `registerArtifact`.
      `appendLogSegment` idempotent on `(workflowId, sequence)`; every write scoped to `ctx.workflowId` with a
      cross-workflow attempt denied and recorded as a security event.
- [x] T064 [US1] `workflow.start` / `byId` / `list` / `timeline` / `logSegments` / `artifacts` in
      `packages/sisyphus-api/src/server/workflow/`, with `start` writing a `queued` row and returning — the panel
      **never invokes** the control plane, which is what makes FR-035's no-ingress rule structural
- [x] T041 [US13] Apply the scoped base selector to every workflow read path in
      `packages/sisyphus-api/src/server/workflow/queries.ts`, **including counts and aggregates** — FR-190
      forbids disclosing a workflow's existence, so a total that includes an invisible run is a leak. _Moved from
      Phase 3 to sit immediately after T064, which creates this file; scoping is an obligation **of** T064, not a
      later pass over it._
- [x] T042 [US13] **Contract test** for the leak surface in
      `packages/sisyphus-api/src/server/workflow/queries.test.ts`: list, every filter, search, and spend
      aggregate over a two-profile fixture reveal nothing about the ungranted profile. No workflow query may ship
      without this — it is quickstart 1f expressed as a test.
- [x] T064a [US1] Ad hoc launch — `workflow.startAdHoc` on **`adminProcedure`** in
      `packages/sisyphus-api/src/server/workflow/start-ad-hoc.ts`, plus the direct-entry launch form in
      `apps/sisyphus-admin/src/app/workflows/new/page.tsx` (workspace or repository, base branch, model,
      instance size, purchase mode, caps, setup bundle, prompt), offering to save the entered configuration as a
      new execution profile (FR-016, FR-129, FR-187). **This is Phase 4's only way to start a run** — the
      profile-first path is T080 in Phase 5, so without this scenario 2 has no launch surface. Admin-only is the
      requirement, not a precaution: an ungated ad hoc launch is an unnamed profile and bypasses FR-180
      entirely. Contract test: a non-admin is refused and the attempt recorded.
- [x] T065 [US1] SSE log-stream route in `apps/sisyphus-admin/src/app/api/stream/[workflowId]/route.ts` using the
      transport S3 (T013) validated
- [x] T066 [US1] Teardown in `apps/sisyphus-control-plane/src/jobs/teardown-workflow.ts` — confirm durability
      **then** release compute and revoke the credential (FR-038)
- [x] T067 [US1] Reconciler in `apps/sisyphus-control-plane/src/jobs/reconcile.ts` sweeping **both** directions:
      a lease with no live workflow is released; a workflow whose lease vanished or heartbeat lapsed moves to
      `parked_resumable` or `failed` with the reason recorded (FR-039)
- [x] T068 [US1] Skill resolution from the **primary** entry only in `apps/sisyphus-executor/src/skills/resolve.ts`,
      reporting each resolution with its content digest. A missing, unreadable or self-contradictory skill halts
      the workflow naming the skill and the step, with no guessed action on branches or tickets (FR-058).
- [x] T069 [US1] Draft-PR creation per `sisyphus-dev` in `apps/sisyphus-executor/src/delivery/pull-request.ts`,
      with pushed-commit verification against the pre-execution remote SHA, and **no ticket transition** (FR-060)
- [x] T070 [US1] Detect and record base-branch staleness in
      `apps/sisyphus-executor/src/delivery/staleness.ts` — record it on the workflow, and leave **whether to
      rebase** to the repository's skills rather than deciding it in Sisyphus (FR-079)
- [x] T071 [US1] Reviewer summary reporting in `apps/sisyphus-executor/src/report/summary.ts` (FR-153)
- [x] T072 [P] [US1] `DESIGN.md` in `apps/sisyphus-admin/DESIGN.md` — front matter plus the eight ordered
      sections, per [design-tokens.md](./contracts/design-tokens.md). Must pass `design-lint` with **zero
      errors**; every residual warning explained in the document's own prose.
- [x] T073 [P] [US1] Token layer as CSS variables through the Tailwind theme in
      `apps/sisyphus-admin/src/styles/globals.css` (Tailwind is pinned to v3 workspace-wide, so no v4 `@theme`)
- [x] T074 [P] [US1] The single `cn` utility in `apps/sisyphus-admin/src/lib/cn.ts` (`clsx` + `tailwind-merge`)
- [x] T075 [US1] shadcn-style primitives with `cva` variants in `apps/sisyphus-admin/src/components/ui/`,
      including the **state chip** whose colour derives from `workflow_state` rather than ad-hoc choice
- [x] T076 [US1] Workflow list with filters and detail view in `apps/sisyphus-admin/src/app/workflows/`
- [x] T077 [US1] Log viewer consuming the SSE stream in
      `apps/sisyphus-admin/src/components/log-viewer/log-viewer.tsx`, reconciling by `sequence` rather than
      arrival time, with a shorter `staleTime` than the 30-second shared default

**Checkpoint**: A delegated run completes end to end — live sanitised output, draft PR, no ticket moved, instance
gone within 10 minutes, log readable afterwards. **Plus the four gates carried from Phase 3**: a bundle passes a
validation run with no agent started; setup output echoing a credential stores redacted; an engineer granted one
of two profiles cannot discover the other's runs by list, filter, search, count or spend total (T042 green); a
deactivated user is denied at their next request and their running workflow is flagged for reassignment.

---

## Phase 5: US9 — Launch from a saved execution profile (Priority: P1)

**Goal**: Selecting a profile prefills everything; the prompt is the only required input.

**Independent Test**: quickstart.md scenarios 3 and 13.

- [x] T078 [US9] `admin.workspaces` sub-router in `packages/sisyphus-api/src/server/admin/workspaces.ts`, editing
      creating a **new version** with entries hanging off it (FR-125)
- [x] T079 [US9] `admin.profiles` sub-router in `packages/sisyphus-api/src/server/admin/profiles.ts`.
      `setEnabled(true)` runs the FR-124 gate — published version present, pinned rows readable, bundle enabled
      and unarchived, workspace unarchived and non-empty — and refuses naming every failing element.
      **Amended by `specs/004-remove-reachability-gate`:** the per-entry repository reachability half shipped as
      a refuse-by-default stub that no deployment ever wired, so it refused every enable. It is removed rather
      than completed — the credential it needed exists only on the executor instance.
- [x] T080 [US9] Add the profile-first path to the launch form in
      `apps/sisyphus-admin/src/app/workflows/new/page.tsx` — profile selection prefills every value and becomes
      the **default and only** path for a non-admin, with T064a's direct-entry fields remaining admin-only
      (FR-122, FR-187). Accepts an optional `resumeFromSessionId` (FR-016) — restoring a stored session into a
      **new** workflow is a distinct operation from continuing one by id.
- [x] T081 [US9] Per-run overrides with `locked_fields` refusal in
      `packages/sisyphus-api/src/server/workflow/overrides.ts` — a locked field is refused, not silently ignored
- [x] T082 [P] [US9] Workspace and profile admin UI in `apps/sisyphus-admin/src/app/admin/profiles/`

**Checkpoint**: A profile launch needs only a prompt; editing a profile mid-run leaves the running workflow on its
original version.

---

## Phase 6: US11 — Be told when you are needed (Priority: P1)

**Goal**: The owner is notified by Slack DM; ticket write-back happens; a delivery failure never alters run state.

**Independent Test**: quickstart.md scenario 5's notification steps.

- [x] T083 [US11] Owner resolution and reassignment in
      `packages/sisyphus-api/src/server/workflow/ownership.ts` — exactly one human owner, integration default as
      fallback (FR-132, FR-133)
- [x] T084 [US11] Slack DM delivery via `conversations.open` + `chat.postMessage` in
      `apps/sisyphus-control-plane/src/notify/slack.ts`, written **outside** the state transition so a delivery
      failure never alters workflow state (FR-141)
- [x] T085 [US11] Coalescing and rate limiting in `apps/sisyphus-control-plane/src/notify/coalesce.ts` — one
      workflow cannot produce a burst, and one integration tick starting many workflows emits a single summary
- [x] T086 [US11] Preferences and watchers in `packages/sisyphus-api/src/server/workflow/watch.ts`. `watch` uses
      `scopedProcedure`, so it cannot be used to confirm an out-of-scope workflow exists; revoking a grant removes
      the watch rather than quietly continuing to deliver (FR-138, FR-188, FR-190).
- [x] T087 [US11] Idempotent external actions in `apps/sisyphus-executor/src/delivery/external-action.ts`, keyed
      so a retry cannot double-comment or double-open (FR-077)
- [x] T088 [P] [US11] Needs-attention view in `apps/sisyphus-admin/src/app/workflows/needs-attention/page.tsx`

**Checkpoint**: A terminal run DMs its owner within 2 minutes; an unnotifiable user is surfaced without breaking
the run.

---

## Phase 7: US2 — Pause and correct a run in flight (Priority: P1) — depends on S1

**Goal**: Pause without terminating, inject a correction into the same conversation, resume.

**Independent Test**: quickstart.md scenario 5.

- [x] T089 [US2] `supervision_commands` queue procedures in
      `packages/sisyphus-api/src/server/workflow/supervision.ts` — `pause`/`resume`/`stop` mutations plus
      `pullPendingCommands` and `acknowledgeCommand`. **This is the path that makes the pause button work**:
      without it the panel writes a row nothing on the instance ever reads, `suspend()` is specified but never
      invoked, and SC-003 is unreachable.
- [x] T090 [US2] Command polling and application in `apps/sisyphus-executor/src/supervision/poll.ts`, applying in
      `sequence` order with a bounded interval so worst-case pause latency stays inside SC-003's 10 seconds. A
      `pause` overtaken by a `stop` before collection returns `superseded` and is never applied.
- [x] T091 [US2] `suspend()` — the **one** routine for pause, interruption and stop — in
      `apps/sisyphus-executor/src/session/suspend.ts`. Acknowledgement comes **after** snapshot registration, so
      the working tree is captured before the user is told the run is paused (FR-049).
- [x] T092 [US2] Park-and-retry on unreachable storage at a snapshot boundary in
      `apps/sisyphus-executor/src/session/park.ts` — holds at the turn boundary already reached, so the cost is
      storage retries rather than inference; on budget exhaustion it fails **naming the boundary it could not
      persist** (FR-082)
- [x] T093 [US2] Corrections queue in `packages/sisyphus-api/src/server/workflow/corrections.ts` plus delivery
      via `sendTurn` in `apps/sisyphus-executor/src/supervision/corrections.ts` — exactly once, in submission
      order, and a correction that cannot be delivered fails **visibly** rather than being dropped
- [x] T094 [US2] Row-level serialisation of supervision transitions in
      `packages/sisyphus-api/src/server/workflow/transition.ts` (`SELECT … FOR UPDATE`), so concurrent actions
      cannot interleave into an inconsistent state
- [x] T095 [P] [US2] Pause / Resume / Stop / Send-correction controls in
      `apps/sisyphus-admin/src/components/supervision/controls.tsx`, showing "paused" only once the executor has
      acknowledged — otherwise the UI claims a pause the instance has not performed
- [x] T096 [US2] Terminal-state refusal returning an already-finished response in
      `packages/sisyphus-api/src/server/workflow/supervision.ts` (FR-081)

**Checkpoint**: Pause takes effect within 10s without terminating; a correction lands in the same conversation;
two corrections arrive in order.

---

## Phase 8: US3 — Resume a conversation on a fresh instance (Priority: P2) — depends on S2

**Goal**: A snapshot restores onto a different instance and the agent continues the same conversation.

**Independent Test**: quickstart.md scenario 6.

- [x] T097 [US3] Snapshot writer in `apps/sisyphus-executor/src/session/snapshot.ts` — one `tar.zst` of the pinned
      root including every entry's working tree **and** `.git`, plus conversation state, **excluding**
      `.agent-config/credentials/` (FR-072 forbids credentials in snapshots; phases 2–5 reinstall them on the
      restore boot, which is why `setup.sh` idempotency is a hard requirement)
- [x] T098 [US3] Restore in `apps/sisyphus-executor/src/session/restore.ts`, tolerating a truncated trailing line
      as a **normal** path — the log is append-only and not written atomically — and verifying the working tree is
      present before reporting ready, since conversation state without worktree state desynchronises the model's
      filesystem beliefs from reality
- [x] T099 [US3] `registerSnapshot` with both state flags in
      `packages/sisyphus-api/src/server/machine/snapshot.ts`; a snapshot missing either is not resumable
- [x] T100 [US3] Spot-interruption watch in `apps/sisyphus-executor/src/interruption.ts` — polls instance
      metadata so detection lives in the process that owns the snapshot, then calls the **same** `suspend()`
      (FR-054)
- [x] T101 [US3] Successor workflows via `continueWithChanges` in
      `packages/sisyphus-api/src/server/workflow/successor.ts`. The successor inherits the predecessor's snapshot
      but keeps its own `session_id`, resuming under the **predecessor's** recorded id — conflating the two makes
      `--resume` fail by finding nothing rather than by erroring. Never edits the predecessor's job spec (FR-149).
- [x] T102 [P] [US3] Successor-chain traversal in both directions in
      `apps/sisyphus-admin/src/app/workflows/[id]/chain/page.tsx` (FR-152)

**Checkpoint**: Force-terminate an instance mid-run; a fresh one restores and continues the same conversation with
uncommitted work intact.

---

## Phase 9: US10 — Coordinated change across several repositories (Priority: P2)

**Goal**: One session spans several repositories; one PR per entry, sharing a branch name.

**Independent Test**: quickstart.md scenario 7.

- [x] T103 [US10] Multi-entry checkout with per-entry resolved commits in
      `apps/sisyphus-executor/src/bootstrap/workspace.ts` — any entry failing fails the workflow naming the
      entry, with **no partial workspace** (FR-112)
- [x] T104 [US10] Per-entry result reporting via `reportEntryResult` in
      `packages/sisyphus-api/src/server/machine/entries.ts` (FR-114, FR-118)
- [x] T105 [US10] PR set sharing one derived branch name in
      `apps/sisyphus-executor/src/delivery/pull-request-set.ts` (FR-115, FR-116)
- [x] T106 [US10] Read cross-repository merge and promotion order from the primary entry's skills in
      `apps/sisyphus-executor/src/delivery/promotion-order.ts` — the order is skill-defined per client and MUST NOT
      be hardcoded (FR-117)
- [x] T107 [US10] Cross-repository concurrency guard in
      `packages/sisyphus-api/src/server/workflow/branch-lock.ts` using an **advisory lock per
      `(repository_url, base_branch)` pair** — the sole mechanism, since a predicate over `workflows.state`
      cannot be expressed in an index on `workflow_entries` (FR-120)
- [x] T108 [P] [US10] Per-entry results in the detail view in
      `apps/sisyphus-admin/src/components/workflow/entry-results.tsx`

**Checkpoint**: A two-repo workspace produces two draft PRs sharing a branch name, with per-entry results
recorded.

---

## Phase 10: US8 — Configure a Jira integration (Priority: P2)

**Goal**: A labelled ticket becomes a workflow on a schedule, exactly once.

**Independent Test**: quickstart.md scenario 8.

- [x] T109 [P] [US8] Connector interface in `packages/sisyphus-api/src/contracts/connector.ts` — owned by the API
      package so the control plane depends on the abstraction and never on Jira
- [x] T110 [US8] `discover` via JQL, paginated, in `packages/sisyphus-integration-jira/src/discover.ts`
- [x] T111 [US8] `resolveProfile` as ordered first-match by `position` in
      `packages/sisyphus-integration-jira/src/resolve-profile.ts`; no match yields a recorded skip, never a
      guessed profile (FR-130)
- [x] T112 [US8] `assemblePromptParts` in `packages/sisyphus-integration-jira/src/prompt-parts.ts`, excluding
      **platform-authored** comments by authoring identity rather than by pattern-matching text. Without this, a
      second run reads Sisyphus's own prior comments back as task input and the loop compounds each iteration
      (FR-161).
- [x] T113 [US8] Idempotent `writeBack` in `packages/sisyphus-integration-jira/src/write-back.ts` — pickup, skip
      and outcome comments, keyed on `(workflowId, kind)` so a retry cannot double-comment
- [x] T114 [US8] `validate` with a **real** connectivity check in
      `packages/sisyphus-integration-jira/src/validate.ts` — a config that cannot reach Jira must not enable
- [x] T115 [US8] Layered prompt assembly in `apps/sisyphus-control-plane/src/jobs/assemble-prompt.ts` — profile
      preamble → integration intro → ticket title, URL, body, comments — stored **as sent**, since tickets change
      afterwards (FR-159, FR-162). Assembly lives here, not in the executor, because the prompt must exist before
      the workflow row.
- [x] T116 [US8] Redact the assembled prompt to the same standard as run output **before** it is stored, and
      truncate comments oldest-first recording the drop count, in
      `apps/sisyphus-control-plane/src/jobs/prompt-redact.ts` (FR-163)
- [x] T117 [US8] Integration tick in `apps/sisyphus-control-plane/src/jobs/integration-tick.ts` following the
      six-step algorithm in
      [integration-connector.md](./contracts/integration-connector.md#control-plane-tick), with claim and
      workflow inserted in **one transaction** so the unique index enforces exactly-once
- [x] T118 [US8] Schedule registration and re-registration in
      `apps/sisyphus-control-plane/src/jobs/sync-schedules.ts`, kept in lockstep with `enabled` and
      `cron_expression`, evaluated in each integration's **own** timezone (FR-155)
- [x] T119 [US8] `admin.integrations` sub-router in
      `packages/sisyphus-api/src/server/admin/integrations.ts` including `previewPrompt` and `runNow`
- [x] T120 [US8] Consecutive-failure tracking and auto-disable in
      `apps/sisyphus-control-plane/src/jobs/integration-health.ts` (FR-106, FR-108)
- [x] T121 [P] [US8] Integration admin UI in `apps/sisyphus-admin/src/app/admin/integrations/` — write-only
      credential field, prompt preview, named schedule presets with the resolved next run times shown in the
      integration's own timezone (FR-154, FR-155)
- [x] T122 [P] [US8] Signed, replay-rejecting webhook ingress in
      `apps/sisyphus-admin/src/app/api/webhook/route.ts` — verifies **before** parsing, and never trusts the body
      to name the integration

**Checkpoint**: A labelled ticket starts exactly one workflow on the mapped profile, gets a pickup comment, and
re-running the tick produces no duplicate.

---

## Phase 11: US4 — Autonomous develop → review → integrate loop (Priority: P2)

**Goal**: A ticket goes from in-progress to integration-ready without a human in the loop, bounded at three
iterations.

**Independent Test**: quickstart.md scenario 9.

- [x] T123 [US4] Autonomous orchestration in `apps/sisyphus-executor/src/workflows/autonomous.ts` following
      `sisyphus-dev` → draft PR → review → feedback → repeat, with **all** convention read from skills and none
      hardcoded (FR-057)
- [x] T124 [US4] Iteration recording with a hard `ordinal ≤ 3` check constraint in
      `packages/sisyphus-api/src/server/machine/iterations.ts` (FR-061)
- [x] T125 [US4] Exhaustion handling in `apps/sisyphus-executor/src/workflows/exhausted.ts` — stops at
      `needs_attention` with the iteration history intact rather than trying a fourth time (FR-062)
- [x] T126 [US4] `sisyphus-integration` step execution in
      `apps/sisyphus-executor/src/workflows/integration-step.ts` (FR-061)
- [x] T127 [P] [US4] Iteration timeline in `apps/sisyphus-admin/src/components/workflow/iterations.tsx`

**Checkpoint**: An autonomous run iterates to a passing review or stops at three with its history recorded.

---

## Phase 12: US5 — Standalone review workflow (Priority: P3)

**Goal**: A review workflow evaluates a PR per `sisyphus-review` and acts on the verdict.

**Independent Test**: quickstart.md scenario 9's review steps.

- [x] T128 [US5] Review workflow type in `apps/sisyphus-executor/src/workflows/review.ts` (FR-063)
- [x] T129 [US5] Findings posting and ticket transition per skill in
      `apps/sisyphus-executor/src/workflows/review-outcome.ts`
- [x] T130 [US5] Closed/merged target handling in `apps/sisyphus-executor/src/workflows/review-guard.ts` —
      reports the change at its next checkpoint and stops rather than pushing work at a dead ticket (FR-080)
- [x] T131 [US5] Multi-entry review evaluating the PR **set** together in
      `apps/sisyphus-executor/src/workflows/review-set.ts` (FR-119)

**Checkpoint**: A review workflow posts findings and moves the ticket exactly as the skill specifies.

---

## Phase 13: US6 — Operate and audit the fleet (Priority: P3)

**Goal**: Oversight across all runs, with spend attributable and nothing out of scope disclosed.

**Independent Test**: quickstart.md scenarios 10 and 12.

- [x] T132 [US6] Spend aggregation in `packages/sisyphus-api/src/server/workflow/spend.ts`, defaulting to
      client/workspace/profile grouping rather than per-individual (FR-156), and scoped like every other read
- [x] T133 [US6] Compute cost basis recording in
      `apps/sisyphus-control-plane/src/jobs/cost-basis.ts` (FR-041)
- [x] T134 [US6] `skillReferences` query in `packages/sisyphus-api/src/server/workflow/skills.ts`, so a past run
      stays explicable after the skills change — the content digest is the only version a repository file has
      (FR-059)
- [x] T135 [P] [US6] Fleet oversight and spend UI in `apps/sisyphus-admin/src/app/admin/fleet/page.tsx`
- [x] T136 [P] [US6] Configuration audit view in `apps/sisyphus-admin/src/app/admin/audit/page.tsx`

**Checkpoint**: An admin sees every run, filters across all dimensions, and reads attributable spend.

---

## Phase 14: Polish & Cross-Cutting Concerns

- [x] T137 [P] SST deployment configs in `apps/sisyphus-admin/sst.config.ts`,
      `apps/sisyphus-control-plane/sst.config.ts` and `apps/sisyphus-executor/sst.config.ts`, composed from
      `sisyphus-infra` — **plus a `trigger-deploy` and a `deploy` target in each deployable's `project.json`**.
      Both are required and neither exists in any project today: `ci.yml` discovers deployables with
      `nx show projects --affected --withTarget=trigger-deploy` and `deploy.yml` runs
      `nx run <app>:deploy --configuration=<stage>`, so a missing target means the app is silently never
      deployed. The constitution's Deployment rule is written in terms of that target.
- [x] T138 [P] Retention lifecycle rules per object class in `packages/sisyphus-infra/src/buckets.ts`, with
      expired artifacts still **listed** with their expiry so a gap reads as retention rather than loss
- [x] T139 [P] Confirm the existing approval flow covers FR-070 for all three deployables and extend it where it
      does not: `ci.yml`'s `dispatch-deploy` job already raises a per-app approval issue carrying app, stage and
      commit, and `deploy.yml` already requires an `/approve` comment from a user with write permission. What
      needs adding is the **recorded approver** on the deploy run itself (the commenter's identity, the stage and
      the commit, written to the run summary) so approval is auditable after the issue is closed (FR-070)
- [ ] T140 Run the full `specs/002-sisyphus-workflow-platform/quickstart.md` suite — all 13 scenarios plus the three spike gates
- [ ] T141 Design audit from [quickstart.md](./quickstart.md#design-audits--not-covered-by-the-linters): zero
      literal hex/px values, no hand-rolled primitive duplicates, both themes at WCAG AA, state colours used only
      for machine state
- [ ] T142 Full gate run: `pnpm nx affected -t lint typecheck test design-lint --base=main` plus `pnpm qlty:diff`,
      with **no** `QLTY_*` override used to pass
- [x] T144 Move the pg-only vocabularies (`bootstrap_phase`, `bootstrap_phase_outcome`, `snapshot_boundary`,
      `skill_name`, `artifact_kind`, `entry_result`, `review_verdict`, `review_finding_severity`,
      `external_action_kind`/`_result`, `supervision_delivery_outcome`, `notification_event`) out of
      `packages/sisyphus-api/src/db/schema/enums.ts` and into `packages/sisyphus-api/src/enums/`, alongside the
      seven cross-cutting ones. They are currently restated as `as const` tuples in `src/schemas/machine.ts` and
      `src/schemas/notification.ts` because `src/db/` is unreachable from a browser bundle — pinned against
      `<enum>.enumValues` by colocated tests, so drift fails, but it is still the duplication gate IV flags.
      _Added during implementation; surfaced by T028._
- [x] T145 Close the two open ends of spike S3 that no local run can reach, before the panel is deployed:
      whether SSE survives CloudFront unbuffered, and behaviour at the Lambda response-streaming duration limit.
      T013 chose the transport (250 ms poll by `(workflow_id, sequence)`) on measured local evidence and proved
      `LISTEN/NOTIFY` fails **silently** through a transaction-mode pooler — but the CDN/Lambda half was not
      testable without cloud resources. See `apps/sisyphus-admin/src/app/api/stream/SPIKE-FINDINGS.md`.
      _Added during implementation; carried from T013._
- [x] T143 [P] Knip and cspell clean — unused exports removed rather than suppressed, unless `knip.json`
      documents why the code is legitimately unreferenced (`knip.json`, `cspell.json`)

  > **Rescoped to its knip half and closed — T244.** As written this task is unsatisfiable by construction: it
  > demands _both_ knip and cspell clean, and **T212 establishes that gating cspell is a workspace-wide change
  > that must not ride in on this feature**. A task that cannot be completed without violating another task is
  > not an open item, it is a contradiction; it is split rather than left to rot.
  >
  > **The knip half is genuinely satisfied.** `pnpm knip:orphans` exits 0 with an empty report. Re-verified
  > under T244 by running it nine times during concurrent edits, which incidentally proved the gate is not
  > vacuous: it went **red** the moment an agent created an unwired module
  > (`packages/sisyphus-infra/src/executor-instance-environment.ts`, then
  > `apps/sisyphus-executor/src/session/instance-metadata.ts`) and **green** again once each was wired in. A
  > `--debug` run confirms the `--production` entry sets resolve non-empty for the Sisyphus workspaces, with the
  > un-suffixed barrels correctly negated — the trailing `!` is present where it matters.
  >
  > **The cspell half is discharged to T212**, which owns it and is explicitly out of scope here.
  >
  > **Two blind spots found while verifying, which T244 did not create and does not close** — raise with T212's
  > findings as workspace-level tickets outside this specification:
  >
  > 1. The **root workspace and all of `tooling/*` carry no `!`**, so neither is inside the orphan gate under
  >    `--production` at all. Root's `entry` is `["scripts/*.{ts,js}"]`, which matches **zero files in either
  >    mode** — `scripts/` contains only `.mjs` and `.sh`. Adding `!` there without also covering `.mjs` would
  >    change nothing.
  > 2. `knip.json` carries five workspace blocks for directories that do not exist in this repository:
  >    `apps/web`, `apps/mobile`, `apps/ui-demo`, `packages/shared-frontend`, `packages/api`. Dead
  >    configuration, and the kind that makes a gate look broader than it is.

---

## Phase 15: Application shell, entry and per-screen states (FR-193..FR-197, FR-201)

_Added 2026-08-06 from the second clarification session. plan.md Phase Sequencing row 12; research.md R17;
quickstart.md Scenario 14. No story label — the shell is cross-cutting over every story that has a screen._

**Goal**: the twelve built screens stop being reachable only by typing a URL, and the route the auth layer
already points at stops returning a 404.

**Independent test**: sign out, request any route, and arrive at a styled sign-in screen; sign in as an engineer
and reach every permitted screen from the sidebar without touching the address bar; sign out from a deep screen.

- [x] T146 Sign-in screen at `apps/sisyphus-admin/src/app/sign-in/page.tsx` — **do this first, it is a live
      defect**: `apps/sisyphus-admin/src/lib/auth/config.ts:106-110` sets both `pages.signIn` and `pages.error`
      to `/sign-in` and no such route exists, so every unauthenticated visit and every auth failure 404s today.
      One Google provider, so no provider picker; built from `components/ui` primitives, not the framework
      default (FR-195)
- [x] T147 [P] Auth-error reason mapping in `apps/sisyphus-admin/src/app/sign-in/error-reason.ts` — translate
      the `error` query parameter into a readable cause covering at minimum out-of-domain identity, deactivated
      account and generic provider failure, reusing the existing decision vocabulary in
      `apps/sisyphus-admin/src/lib/auth/sign-in-decision.ts`. A reason MUST NOT disclose whether an account
      exists (FR-195, FR-190)
- [x] T148 [P] Root route redirect in `apps/sisyphus-admin/src/app/page.tsx`, replacing the current 7-line
      `<h1>Sisyphus</h1>` stub — authenticated to `/workflows`, unauthenticated to `/sign-in` (FR-196)
- [x] T149 Application shell layout at `apps/sisyphus-admin/src/app/(app)/layout.tsx` — a route group so a new
      screen is inside the shell by existing rather than by remembering to import it. Renders the sidebar and
      top bar around `children` (FR-193, R17)
- [x] T150 Sidebar in `apps/sisyphus-admin/src/components/shell/sidebar.tsx` with
      `apps/sisyphus-admin/src/components/shell/nav-items.ts` — Workflows, Needs attention, Fleet, plus an Admin
      group (bundles, workspaces, profiles, integrations, users, audit) **filtered out entirely for engineers,
      not rendered disabled**, so the nav never advertises a surface that will answer `NOT_FOUND` (FR-193,
      FR-190). Current section marked by something other than colour alone (FR-201)
- [x] T151 [P] Top bar in `apps/sisyphus-admin/src/components/shell/top-bar.tsx` — signed-in identity plus a
      sign-out control wired to `signOut`, which is exported at
      `apps/sisyphus-admin/src/lib/auth/index.ts:16` and imported by no component today (FR-194, SC-058)
- [x] T152 Move `app/workflows/`, `app/admin/` and the new `app/settings/` under `apps/sisyphus-admin/src/app/(app)/`
      so the shell wraps them. Route-group parentheses keep every URL unchanged — verify with the existing
      colocated page tests, which must pass without edits to their asserted paths
- [x] T153 [P] Root not-found boundary at `apps/sisyphus-admin/src/app/not-found.tsx` — catches the
      `notFound()` that `requireAdminPage()` throws for non-admins, which lands on the framework's unstyled
      default today. Renders inside the shell with a route back, reusing
      `apps/sisyphus-admin/src/components/admin/not-found-card.tsx` (FR-197)
- [x] T154 [P] Root error boundary at `apps/sisyphus-admin/src/app/error.tsx` — styled, inside the shell, with
      an error code and a next action rather than a dead end (FR-197, FR-031)
- [x] T155 Per-screen loading, empty and error states across all thirteen screens — a list with zero rows
      renders a stated empty case, a query in flight renders a loading case, a failed query renders the reason
      plus a next action. Walk every `page.tsx` under `apps/sisyphus-admin/src/app/(app)/`; this is the
      criterion T141's "every screen" audit had no way to check (FR-201)
- [x] T156 Reconcile `apps/sisyphus-admin/src/components/admin/admin-shell.tsx` with the new layout — it
      currently renders eyebrow, title and summary and is the closest thing to chrome the app has. It becomes
      the per-screen **page header** inside the shell, not a second shell; remove any framing the layout now
      owns and update `admin-shell.test.tsx` accordingly

**Checkpoint**: quickstart.md Scenario 14 passes end to end for both roles.

---

## Phase 16: US11 — Notification preferences and watching (FR-138)

_Added 2026-08-06. plan.md Phase Sequencing row 13; quickstart.md Scenario 15. Backend only — the four
procedures already exist and are mounted; this phase is the missing surface._

**Goal**: FR-138's per-event preferences and watch-a-workflow-you-don't-own become reachable without an
administrator.

**Independent test**: turn one event off and confirm it stops arriving while another still does; watch a
workflow you do not own and receive its notifications; unwatch and stop.

- [x] T157 [US11] Notification settings screen at
      `apps/sisyphus-admin/src/app/(app)/settings/notifications/page.tsx` — reads
      `workflow.notificationPreferences`, already mounted at
      `packages/sisyphus-api/src/server/workflow/router.ts:237` (FR-138)
- [x] T158 [US11] Preferences panel in
      `apps/sisyphus-admin/src/components/settings/notification-preferences-panel.tsx` — one control per
      notification event, writing through `workflow.setNotificationPreference`. Defaults come from
      `applyPreferenceDefaults` in `packages/sisyphus-api/src/server/workflow/watch.ts:171`, so a user who has
      never opened this screen is still notified about their own runs (FR-138)
- [x] T159 [P] [US11] Slack identity readout in
      `apps/sisyphus-admin/src/components/settings/slack-identity-readout.tsx` — states plainly when no Slack
      identity resolved and that notifications will not be delivered, rather than the screen silently
      succeeding (FR-140)
- [x] T160 [US11] Watch / Unwatch control in
      `apps/sisyphus-admin/src/components/workflows/watch-toggle.tsx`, mounted in
      `apps/sisyphus-admin/src/components/workflows/workflow-detail-panel.tsx` — calls `workflow.watch` /
      `workflow.unwatch`, offered for any workflow the requester may see, not only ones they own. Both are
      `scopedProcedure`, so the control must not become a way to confirm an out-of-scope workflow exists
      (FR-138, FR-190)

**Checkpoint**: quickstart.md Scenario 15 passes, including the out-of-scope probe in step 6.

---

## Phase 17: Infrastructure re-shape (FR-066, FR-198..FR-200, FR-202)

_Added 2026-08-06. plan.md Phase Sequencing row 14; research.md R16; quickstart.md Scenario 16. Supersedes the
shape T034 and T137 built — those tasks stay checked as the record of what was done; these change it._

**Goal**: `sisyphus-infra` contains infrastructure constructs rather than a layer of interfaces standing
between a primitive and the resource it creates.

**Independent test**: from a clean clone with no AWS credentials, `pnpm install` then
`pnpm nx run-many -t typecheck` is clean; grepping the package finds no `*Provider` / `*Surface` interface.

- [x] T161 Extract the pure layer first, before anything is rewritten:
      `packages/sisyphus-infra/src/retention.ts` (days and transitions per object class),
      `packages/sisyphus-infra/src/policies.ts` (each policy document's actions, resources and conditions, plus
      the CI identity provider's trusted subject), each with its colocated test. Move the assertions that
      already exist in `buckets.test.ts`, `oidc-provider.test.ts` and `runner-role.test.ts` onto these, so no
      security or retention assertion is lost in the rewrite (FR-200)
- [x] T162 Rewrite `packages/sisyphus-infra/src/buckets.ts` as `createBuckets(config)` instantiating
      `sst.aws.Bucket` / `aws.s3.*` directly and returning `{ logs, snapshots, bundles, artifacts }`. Delete
      `BucketProvider`, `BucketSpecification(s)` and the `build*Specification` indirection; lifecycle rules come
      from `retention.ts`. Delete `buckets.test.ts` — the construct is deploy-verified (FR-066, FR-200)
- [x] T163 [P] Rewrite `packages/sisyphus-infra/src/database.ts` as `createDatabase(config)` returning the
      instance and its parameter, deleting `DatabaseProvider` and `DatabaseSpecification` with
      `database.test.ts`
- [x] T164 Rewrite `packages/sisyphus-infra/src/oidc-provider.ts` as `async createOidcProvider(config)` —
      create in production, `getOpenIdConnectProvider` lookup elsewhere via the Promise API so the absence can
      be caught and rethrown naming the bootstrap step. Rewrite
      `packages/sisyphus-infra/src/runner-role.ts` as `createRunnerRole(config)`. Both take their policy
      documents from `policies.ts`; delete `OidcProviderSurface`, `RunnerRoleProvider` and both construct tests
- [x] T165 [P] Rewrite `packages/sisyphus-infra/src/scheduler.ts` as `createScheduler(config)` and add
      `packages/sisyphus-infra/src/nextjs-website.ts` as `createNextjsWebsite(config)`, deriving its argument
      types from the construct's own constructor rather than restating them. Delete `SchedulerProvider` and
      `scheduler.test.ts`
- [x] T166 Retire the structural type layer: delete `SstConfigDefinition`, `SstAppInput` and `SstAppConfig`
      from `packages/sisyphus-infra/src/sst-app.ts`, keeping only the pure removal-policy/protect decision as
      a tested helper so three deployables cannot disagree about teardown. Fold
      `packages/sisyphus-infra/src/stack-scope.ts` into `lib.ts` if it is only naming. Rewrite
      `packages/sisyphus-infra/src/index.ts` — explicit named re-exports, no `export *`, and none of the
      deleted provider types (FR-066, SC-060)
- [x] T167 [P] Add the `./scripts` subpath to `packages/sisyphus-infra/package.json` and populate
      `packages/sisyphus-infra/src/scripts/` — `deploy-role-name.ts` as the single exported constant both the
      bootstrap role and the CI script build their identifier from, `ci-deploy-utils.ts` (OIDC token,
      assume-role, parameter-store → `process.env` / `.env` file), `get-deployment-environment.ts`, and an
      `index.ts` barrel. Two string literals that agree today are the failure this prevents (FR-200)
- [x] T168 Split each deployable's deployment config into three, replacing the stage-suffix `if` branch in
      `apps/sisyphus-admin/sst.config.ts` and its siblings: `sst.config.ts` (application stack),
      `sst-bootstrap.config.ts` (parameters, CI identity provider, deploy role), `sst-install.config.ts`
      (no-op, providers only) — for `apps/sisyphus-admin`, `apps/sisyphus-control-plane` and
      `apps/sisyphus-executor`. Configuration is read inside `app()` / `run()`, never at module scope, and every
      import is a dynamic `await import()`; the install config's providers must be pinned to exactly the
      versions the application config declares (FR-199, FR-202, R16)
- [x] T169 [P] Wire the filtered typecheck: `ignored-error-codes.json` and `loosely-type-checked-files.json` in
      each of `apps/sisyphus-admin`, `apps/sisyphus-control-plane`, `apps/sisyphus-executor` and
      `packages/sisyphus-infra`, with the target changed to `tsc --noEmit | loose-ts-check` in each
      `project.json`. `.sst/**/*.ts` goes in all three of `tsconfig.json` `include`, the loose-glob list, and
      `eslint.config.mjs` `ignores`. `sisyphus-infra`'s ignored set stays narrow — only what its use of the
      ambient globals raises. `sisyphus-api` and `sisyphus-integration-jira` get neither file (FR-198, SC-061)
- [x] T170 Update each deployable's `project.json` so **every** command naming a stack also names its config
      file — `deploy`, `bootstrap`, `destroy` and `unlock`. A `destroy` that omits it loads the wrong stack's
      configuration and mis-plans the teardown. Add the install config to `postinstall` in each deployable's
      `package.json`, so a fresh clone can typecheck (FR-199)
- [x] T171 Run quickstart.md Scenario 16 — the clean-clone, no-credentials typecheck, the install/application
      provider-parity diff, the grep for injected providers, and the deliberate break of a policy-document
      helper to prove its test actually fails. T140 covers Scenarios 1–13; this covers 14–16

**Checkpoint**: `pnpm nx affected -t lint typecheck test --base=main` clean, with no `QLTY_*` override.

---

## Phase 18: Assembly — entry points, dead schema, and the gaps the gate could not see (FR-203..FR-205)

_Added 2026-08-06. Every item below was verified against the tree before being written here, not inferred from
the task list. **This phase is more important than Phases 15–17.** Phases 1–14 built and tested the parts;
what is missing is the trunk they hang from — and because every unit suite passes, `nx affected -t lint
typecheck test` is green today with the executor and control plane unable to do anything at all._

**Goal**: the deployables stop being libraries of well-tested parts. A green pipeline starts meaning the
system works.

**Independent test**: start each deployable through the entry point its deployment config declares, and watch
a delegated run go from launch to draft PR.

### The trunk — nothing below this line has a task in Phases 1–14

- [x] T172 Control-plane Lambda entry point at `apps/sisyphus-control-plane/src/main.ts`, exporting the
      `handler` symbol that `apps/sisyphus-control-plane/sst.config.ts:114` already declares as
      `src/main.handler` and passes to the function at `:225`. **The file does not exist**, so the deployed
      function has no handler to load. It dispatches by event to `jobs/admit-workflow`, `drain-queue`,
      `start-workflow`, `teardown-workflow`, `reconcile`, `integration-tick`, `sync-schedules` and
      `bootstrap-admins` — all built and tested (536 tests), all currently unreachable (FR-203)
- [x] T173 Executor entry point — replace the 22-line scaffold at `apps/sisyphus-executor/src/main.ts`, whose
      own doc comment says "Bootstrap phases, the agent adapter and report-back land in later tasks". It must
      parse the job envelope, run the bootstrap phases, resolve skills, start the agent, run the output
      pipeline and report back, then suspend or tear down — composing `bootstrap/`, `agent/`, `session/`,
      `output/`, `report/`, `caps/`, `skills/`, `supervision/` and `workflows/`, **none of which it imports
      today** (FR-203). **Correction, 2026-08-07:** this shipped checked with no colocated
      `main.test.ts`, a breach of Constitution III, which the control plane's identical entry point did not
      have. Found by cross-artifact analysis, not by any gate. Closed the same day — 29 tests, `main.ts`
      unchanged. The task stays checked because its subject was delivered; the note stays because a checked
      task that was in breach is the only evidence that the gate did not catch it (see T228)
- [x] T174 [US1] Delegated-run orchestrator at `apps/sisyphus-executor/src/workflows/delegated.ts` —
      `apps/sisyphus-executor/src/workflows/` has `autonomous.ts` and thirteen siblings but no delegated path,
      so US1, the MVP story, has no module composing it. tasks.md:339 asserts "A delegated run completes end
      to end" as a Phase 4 checkpoint with no task behind it (FR-203)
- [x] T175 Call the supervision loop from the executor entry point: `watchForInterruption`
      (`apps/sisyphus-executor/src/session/interruption.ts:128`) has no production caller, so the one
      `suspend()` path it guards is unreachable. **Nothing anywhere imports `session/`.** Two source comments
      already record this — `apps/sisyphus-executor/src/supervision/poll.ts:7` and
      `packages/sisyphus-api/src/server/workflow/supervision.ts:29` both read "`suspend()` is fully specified
      and never invoked" (FR-203, FR-054)
- [x] T176 Start the heartbeat loop from the executor entry point — `report/client.ts` defines `heartbeat` at
      `:101` and no non-test code calls it. Without it, `reconcile.ts`'s heartbeat-lapse detection
      (`HEARTBEAT_LAPSE_MS`, `reconcile.ts:76`) will park every live run (FR-048)
- [x] T177 [US11] Call `notifyWorkflowEvent` from the state-transition path —
      `apps/sisyphus-control-plane/src/notify/delivery.ts:177` has no production caller, and **no job imports
      `notify/` at all**. T084 and T085 built `slack.ts` and `coalesce.ts`; nothing invokes the delivery entry
      point they serve, so no notification has ever been sent (FR-136, FR-141)
- [x] T178 [US4] Call `runAutonomousWorkflow` (`apps/sisyphus-executor/src/workflows/autonomous.ts:195`) and
      `runReviewWorkflow` from the executor entry point, selected by workflow type. Both are tested and both
      are reachable only from their barrel and their tests (FR-203)

### Dead schema — a tested producer and a tested consumer with nothing joining them

- [x] T179 Mount a skill-reference report procedure on the machine router
      (`packages/sisyphus-api/src/server/machine/router.ts`, which mounts twenty procedures and none for
      skills), and bind the executor's `SkillReferenceReporter` callback to it in
      `apps/sisyphus-executor/src/report/client.ts`. `reportSkillReferenceInput`
      (`packages/sisyphus-api/src/schemas/machine.ts:100`) is imported by nothing; the executor computes
      digests and calls `report(...)` at `skills/resolve.ts:253,313,360` into a callback bound to nothing.
      `workflow.skillReferences` reads the table against live Postgres and can only ever return empty, so
      T134 is complete over a table no run will populate (FR-055, Scenario 12)
- [x] T180 [US4] Make external-action idempotency durable — mount a report procedure for
      `reportExternalActionInput` (`packages/sisyphus-api/src/schemas/machine.ts:145`, imported by nothing) and
      write through the `external_actions` unique index at
      `packages/sisyphus-api/src/db/schema/supervision.ts:151`. Today retry safety is
      `new Map()` at `apps/sisyphus-executor/src/delivery/external-action.ts:152` — per-process, empty after a
      re-provision. The source concedes it at `:138-141` ("the durable half of FR-076 is `external_actions` on
      the machine surface"), and **nothing, including the tests, ever inserts a row**. The spec says the index
      is what guarantees exactly-once; that is currently not true of the implementation (FR-076)

### Requirements with no implementation, or none that meets them

- [x] T181 Implement the pause idle ceiling — `'on-idle-ceiling'`
      (`apps/sisyphus-executor/src/session/suspend.ts:57`) is a union member whose only consumer is
      `plan.computeRelease === 'immediate'` at `:252`, i.e. it means "don't release" and nothing else. No
      threshold constant, no timer, no `paused_at`, no sweep. Add the threshold, record when a pause began,
      and extend `apps/sisyphus-control-plane/src/jobs/reconcile.ts` to park a run paused past it — its
      `ACTIVE_STATES` already includes `paused` (`:88`) but it only acts on lease loss and heartbeat lapse
      (FR-049, Scenario 5.6)
- [x] T182 [P] Seed a `paused` workflow in `apps/sisyphus-control-plane/src/jobs/reconcile.test.ts` — `paused`
      is in the fixture's own state union at `:43` and appears in no seed in the file, so that arm of
      `ACTIVE_STATES` is entirely untested
- [x] T183 Fix FR-104's determinism — `apps/sisyphus-control-plane/src/jobs/integration-store.ts:283-286`
      concedes the requirement is unmet: "the deterministic lowest-`integrations.id` winner holds **when the
      ticks are ordered**; where a higher-id integration claimed first, the claim stands." FR-104 forbids
      exactly that tick-timing dependence. Resolve the winner by the stated rule regardless of tick order, and
      test both branches — `integration-tick.test.ts:575-588` ticks sequentially and would pass if reversed
- [x] T184 [P] Consume `onParked` / `parkedAttempts` outside `session/` (FR-082) — both are implemented and
      unit-tested in `apps/sisyphus-executor/src/session/park.ts` and `restore.ts`, with **zero hits outside
      that directory**. The continuing heartbeat and the panel's "waiting on storage" state both depend on
      them; the phrase appears in three executor comments and nowhere in `apps/sisyphus-admin/src`
- [x] T185 [P] Enforce the supervision budget terms as real timeouts —
      `apps/sisyphus-executor/src/supervision/budget.ts:47-70` declares five terms and only `POLL_INTERVAL_MS`
      is wired to anything (`supervision/poll.ts:150`). `PULL_ROUND_TRIP_MS`, `QUIESCE_BUDGET_MS`,
      `SNAPSHOT_BUDGET_MS` and `ACKNOWLEDGE_BUDGET_MS` are passed as a timeout to no operation, so the budget
      is an intention rather than a bound (FR-205, SC-003)

### Tests that pass without asserting the requirement

- [x] T186 [P] Assert the seven launch values `claimAndStart` copies onto the workflow row
      (`apps/sisyphus-control-plane/src/jobs/integration-store.ts:399-419`) — `workspaceVersionId`,
      `setupBundleVersionId`, `model`, `instanceType`, `purchaseMode`, `turnCap`, `spendCap`. Its colocated
      test asserts only `state`, `initiatedByUserId`, `executionProfileVersionId` and `ticketReference`;
      deleting `turnCap` and `spendCap` from the insert leaves the whole suite green (FR-101)
- [x] T187 [P] Test FR-125's actual claim — that a pin survives an edit landing **mid-run**. Both existing
      tests (`packages/sisyphus-api/src/server/admin/workspaces.test.ts:331` and `profiles.test.ts:448`) are
      sequential seed-edit-assert and prove append-only versioning, not concurrency. The machinery is already
      in the repo: reuse the `createGate` / `pg_stat_activity` choreography from
      `packages/sisyphus-api/src/server/workflow/start.test.ts:142-155`
- [x] T188 [P] Test SC-021 — read a completed run back and reconstruct its exact launch configuration. No test
      does this today, and the production read path cannot: `queries.ts:146,194,374` join
      `executionProfiles` (the mutable current row, for its name) and never `executionProfileVersions`, so
      `findProfileVersion` is only ever called with `profile.currentVersionId`. This needs a resolver change,
      not only a test
- [x] T189 Replace the constant-arithmetic latency tests with measured ones (FR-205) —
      `apps/sisyphus-control-plane/src/notify/coalesce.test.ts:34-49` asserts a function equals the sum of its
      own addends and that `80_000 < 120_000`; `apps/sisyphus-executor/src/supervision/budget.test.ts` does
      the same for the 10-second pause ceiling. Keep the budgets as declared intent, but add at least one test
      per criterion that performs the operation and observes elapsed time (SC-003, SC-034)

### The gate itself

- [x] T190 **Make CI run the database-backed suites** (FR-204) — `.github/workflows/ci.yml` declares no
      `services:`, no Postgres, and never sets `SISYPHUS_TEST_DATABASE_URL`. Roughly a third of the suite's
      assertions therefore never execute in CI while it reports green, including the exactly-once unique-index
      proof, the branch-lock advisory-lock proof, the iteration `CHECK` constraint, spend scoping and the
      skill-digest readback. Add a Postgres service, set the variable, run migrations, and make the guarded
      suites **fail rather than skip** when the variable is absent **in CI** — skipping locally stays correct
- [x] T191 [P] Fix the five broken commands in `specs/002-sisyphus-workflow-platform/quickstart.md` (SC-065):
      `sisyphus-control-plane:e2e` (`:185`) and `dev` on `sisyphus-control-plane` (`:38`) name targets that
      project does not have; `sisyphus-executor:spike-stdin` (`:57`), `sisyphus-admin:spike-log-stream`
      (`:70`) and `sisyphus-executor:spike-restore` (`:83`) name targets that exist nowhere — so the entire
      "reproduce the spikes" section is unrunnable. Either add the targets or correct the guide
- [x] T192 [P] Add a check that fails when a shipped module has no production caller (SC-063) — the condition
      that hid T172–T180. Knip's unused-export detection covers most of it; the residue is symbols a barrel
      re-exports and nothing imports. Anything legitimately unreferenced gets a documented `knip.json` entry,
      never a silent pass
- [x] T193 Re-run the full gate after this phase — **result, 2026-08-06**:
      `nx run-many -t lint typecheck test design-lint` green for all **14 projects** with
      `SISYPHUS_TEST_DATABASE_URL` set and `--skip-nx-cache`. **5,695 passing, 7 skipped.**

      | Project                  | Passing |
      | ------------------------ | ------- |
      | `sisyphus-admin`         | 2,306   |
      | `sisyphus-api`           | 1,519   |
      | `sisyphus-executor`      | 908     |
      | `sisyphus-control-plane` | 528     |
      | `sisyphus-integration-jira` | 165  |
      | `sisyphus-infra`         | 142     |
      | `sisyphus-notify`        | 127     |

      The skipped count is **7, not zero, and that is correct** — they are the S3 spike suite, which needs a
      PgBouncer in `pool_mode = transaction` rather than a plain Postgres (`SPIKE_S3_DIRECT_URL` /
      `SPIKE_S3_POOLED_URL`). The spike is closed; the harness is retained so its findings stay reproducible.
      Every suite gated on `SISYPHUS_TEST_DATABASE_URL` now runs. The measurement that matters: `sisyphus-api`
      alone reports **951 passing / 568 skipped** without the variable and **1,519 / 0** with it, so 568
      assertions that CI previously never executed now do. `pnpm knip:orphans` exits 0 with an empty report.
      `design-lint` 0 errors / 31 pre-existing warnings

**Checkpoint**: a delegated run launched from the panel reaches a draft PR on a real instance — quickstart.md
Scenario 2, which has never been executable.

---

## Phase 19: The ports behind the trunk (FR-203)

_Added 2026-08-06, **during** the implementation of Phase 18 and because of it._ Wiring the entry points made a
second layer of absence visible that no audit of the built tree had found, because from the outside a port with
a type, a barrel entry and a passing fake looks exactly like a port with an implementation. Phase 18's premise
was that Phases 1–14 built the parts and left out the trunk. That was true and incomplete: **some of the parts
are types.**

`T173` composes bootstrap → agent → output → report faithfully, and then a delegated run reports terminal
`failed` naming the port it could not find. That is the correct behaviour and it was deliberately chosen over
stubbing a proposal that would report success having done nothing — but it means the MVP boundary moves again.

**Goal**: the composition Phase 18 built has something real at the end of every wire.

**Independent test**: a delegated run launched from the panel opens a draft PR.

**This phase is cut by plan.md's four rules** (see _How this feature's work must be cut_), because it exists as
a direct consequence of their absence. Applied here they mean:

1. **The checkpoint below is T213, a task** — not the sentence above it. The Phase 4 checkpoint claimed "a
   delegated run completes end to end" with no task behind it, and stayed false through eleven phases.
2. **Every port or slot names the task that fills it.** T194 fills `DeveloperPort`, T195 fills `Forge`, T196
   fills `FindingsPublisher` / `TicketPort` / `IntegrationPlanner`, T197 fills `InstanceMetadataReader`. No
   task in this phase may leave a new unfilled port without adding its filling task in the same breath.
3. **Nothing is done while its subject has no production caller.** `pnpm knip:orphans` decides this, not
   review.
4. **Each gate is verified against a planted failure** — T215–T217, because three gates in this feature passed
   convincingly while measuring nothing.

**Ordering**: T194 and T195 first and in parallel — they are the entire distance between the system and
Scenario 2. The port tasks T194–T198 then gate the eleven assembly tasks (T213, T214, T218–T226), which are the
only items in this phase with hard predecessors: every one of them names at least one task it cannot start
without, because a story's path cannot be run through a port that has no implementation. Everything else — the
loose ends, the coverage gaps and the three gate verifications — can follow in any order.

### The MVP blockers — nothing here has ever had an implementation

- [x] T194 [US1] Agent-frame → `DevelopmentProposal` bridge. `src/agent` starts the agent, streams frames and
      injects turns; nothing parses that frame stream into a proposal. `DeveloperPort` is a type with no
      implementation, so `dispatchWorkflow` halts. This is the single largest remaining gap and US1 cannot
      complete without it (FR-060, FR-203). **Implemented 2026-08-07, not yet closed**: five modules in
      `src/agent/` (`proposal-block`, `development-proposal`, `develop-turn`, `frame-tap`, `developer-port`),
      179 tests. The agent answers in a per-request nonce-delimited block, so pass 2 of the autonomous loop
      cannot read pass 1's answer and the example inside the instruction cannot answer for the agent. No field
      is ever defaulted — a missing one is reported as missing. **Closed 2026-08-07**: `assembleRun` now
      defaults `ports` to `agentWorkflowPorts`, which builds this port from the running agent, and
      `knip:orphans` is clean — rule 3's production caller is mechanically proven rather than asserted
- [x] T195 [US1] `Forge` implementation — `apps/sisyphus-executor/src/delivery/forge.ts` defines the port and
      nothing implements it, so **no pull request can be opened by any workflow type**. With T194 this is the
      pair that makes quickstart Scenario 2 executable (FR-060). **Implemented 2026-08-07, not yet closed**:
      `forge-http`, `forge-error`, `forge-retry`, `forge-repository`, 227 tests in `src/delivery`. Idempotency
      proved against a stateful fake host across four paths including the lost-response 502 and two independent
      clients. `branchHead` maps **only** 404 to `undefined`, because `pull-request.ts` renders `undefined` to
      the engineer as "your work never left the instance". **Closed 2026-08-07** together with T229, which
      gave it a credential, and T230, which gave it the entry list it delivers over
- [x] T229 [US1] Give the forge a credential and an API base — **discovered by T195, and the reason T194 + T195
      alone do not reach Scenario 2**. `createHttpForge` takes `apiBaseUrl` and a `credential` accessor and
      neither exists in the executor. The credential is **not** `envelope.scopedCredential`: that one is
      workflow-scoped and machine-surface-only (FR-037) and is listed in `ENVELOPE_ONLY_KEYS`. FR-075 delivers
      it by setup bundle, and `contracts/setup-bundle.md` says `credentials/` holds "whatever setup.sh needs" —
      **deliberately unnamed**, so nothing can read it by path and naming a file would be a bundle-contract
      change every existing client bundle would have to satisfy. Read it from git instead: the bundle has
      already had to make git able to clone and push, so `git credential fill` knows it whatever form the
      bundle chose. Lives in `src/run/`, never in `src/delivery/`, so `git.ts`'s read-only allowlist is not
      weakened by a credential-bearing subcommand. Resolve lazily — it does not exist until bootstrap phase 5.
      Adds `SISYPHUS_FORGE_API_URL`, which must also be set at **every** site that builds the instance
      environment; `jobs/start-workflow.ts` documents `SISYPHUS_MACHINE_SURFACE_URL` as "the only URL the
      instance is told about" and that comment stops being true (FR-072, FR-075). **Done 2026-08-07**, with
      **two caveats that outlive the task**. (1) `SISYPHUS_FORGE_API_URL` has no home in this repository — the
      executor's deploy-time config is loaded from an SSM blob an operator populates and that is deliberately
      not committed (FR-202) — so **an operator must add it to the stage parameter and to the launch unit, or
      the first real run fails at boot naming the variable**. This is the single manual step between here and
      T213. (2) The credential is registered as a `KnownSecret` on the forge's own redactor, but **not** on the
      run-wide one: `runExecutor` snapshots `options.secrets` at step 1, before bootstrap, and a phase-5
      credential structurally cannot be in an array taken at phase 0. Closing that needs `secrets` to become a
      provider function. Pre-existing and wider than the forge — `assembleRun` passes no `secrets` at all
      today, so no bundle-installed credential reaches the run-wide redactor (see T231)
- [x] T230 [US1] Build the delivery entry list — the other half of the wiring T194 and T195 cannot supply.
      `DelegatedPorts.entries` is `readonly PullRequestSetEntry[]` and nothing constructs it, so the delegated
      workflow has both ports and still cannot deliver. Two fields make it more than a mapping:
      `preExecutionRemoteSha` must be probed from the forge **before** the agent runs (a value reconstructed
      afterwards is what `staleness.ts` exists to catch), and `wasChanged` must be a real observation of the
      working tree — `false` opens no pull request at all under FR-115, so a false negative silently discards
      the agent's work. Per-entry `baseBranch` is that repository's, never the primary's (FR-109). **Done
      2026-08-07.** `wasChanged` is true if the tree is dirty **or** `HEAD` has moved off the checked-out
      commit — a tree-only test reads a properly-committed pass as "did nothing", which is the false negative
      that throws the work away — and unreadable git counts as changed, deliberately asymmetric because a
      wrong `true` fails loudly in the delivery step while a wrong `false` is never mentioned again. It is a
      getter that throws until the after-step has run, so a caller who forgets the wrap gets a named failure
      rather than a silent discard. **`preExecutionRemoteSha` is `undefined` on every run today and that is
      correct**: the shared work-branch name comes from the agent applying `sisyphus-dev`'s prose rule during
      the pass, so it does not exist beforehand, and probing afterwards would return the sha the agent just
      pushed — `noPushedWorkError` would then discard every successful run's pull request claiming it pushed
      nothing. The forge's other two checks do the verification
- [ ] T231 Make the known-secret list a provider rather than a snapshot (FR-072, FR-089). **Found while
      closing T229, pre-existing and wider than the forge.** `runExecutor` reads `options.secrets` once at
      step 1 — before bootstrap — and hands it to the segment writer, the summary sanitiser and the park
      report. Credentials the setup bundle installs arrive at **phase 5**, so they structurally cannot be in
      an array taken at phase 0. Worse in practice: `assembleRun` passes **no** `secrets` at all, so
      `secrets = []` on every real run and **only pattern matching in `output/secret-patterns.ts` stands
      between a bundle-installed credential and the log the panel streams**. Known-value redaction is what
      catches a credential no pattern anticipates, which is exactly the case a client-supplied bundle
      presents. Make `secrets` a `() => readonly KnownSecret[]` resolved at each redaction site, register the
      forge credential and every other bundle-installed value through it, and verify with a planted secret
      that reaches a log segment (rule 4)

  > **Partially satisfied by PR #19 (`003/T054`) — T232.** The architectural half landed: `createSecretRegistry`
  > exists in `apps/sisyphus-executor/src/output/secret-registry.ts` with `add` and a
  > `current: () => readonly KnownSecret[]` provider, and it is threaded through every redaction site via
  > `run/execute.ts:283`. The rotating agent credential registers through it. **The seeding did not land**:
  > `assembleRun` still returns an `options` object with no `secrets` key
  > (`apps/sisyphus-executor/src/run/assemble.ts:247-268`), so `runExecutor` reads `options.secrets ?? []` and
  > the registry is empty on every real run — the dangerous half of this task is unchanged. Leave this box
  > **unticked**; the residue is carried under **T239** in Phase 22, which is where the remaining work is
  > specified.

- [ ] T196 [P] [US5] `FindingsPublisher` implementation, and [US4] `TicketPort` / `IntegrationPlanner` — the
      same absence for the review and autonomous paths. `runReviewWorkflow` and `runAutonomousWorkflow` are
      tested and dispatched and both halt at their port
- [x] T197 [P] `InstanceMetadataReader` against IMDS — the interruption watch is wired and tested end to end
      through a fake reader, but the real notice source is assumed, not read. Spike S2 recorded the notice
      format as unobserved. Until this lands, `watchForInterruption` runs against
      `createQuietMetadataReader()` and no reclamation is ever detected (FR-054)

  > **Done under T240**, which carried this task forward at corrected severity rather than restating it.
  > `apps/sisyphus-executor/src/session/instance-metadata.ts` implements `createImdsMetadataReader` against
  > IMDSv2 — token cached with a 60s renewal margin so a 5s poll costs one `PUT` per ~6h; `404` is the **only**
  > path to `null`, so a healthy "not interrupted" answer is never counted as a read failure; a `401`/`403`
  > refreshes the token and retries exactly once; and the 1s deadline is enforced both by `AbortSignal` and by a
  > `Promise.race`, so a transport that ignores the signal still cannot stall the poll loop. It is now the
  > default at `run/execute.ts:493`, with `createQuietMetadataReader` kept for tests. Verified per rule 4 by
  > two neuterings: deleting the `404 → null` branch turned two healthy polls into counted failures
  > (`expected 2 to be +0`) and failed 5 of 18 tests; dropping the token header failed 3 of 18. Both green on
  > restore. Spot is confirmed the default purchase mode (`packages/sisyphus-api/src/enums/purchase-mode.ts:17`),
  > so this was silent data loss in the **default** configuration, not an edge case.

### Surfaces a caller needs and no package publishes

- [ ] T198 Package the FR-163 prompt redactor. It lives at `apps/sisyphus-executor/src/output/redact.ts` and
      no package exports it, so `apps/sisyphus-control-plane/src/context.ts` defaults to
      `createRefusingPromptRedactor()` and **every integration tick fails loudly in production**. Move the
      standard into a shared package and wire the one-line override (FR-163, FR-019)
- [x] T199 Connect `/admin/integrations` to the router. **Corrected on investigation:** the router was already
      mounted at `appRouter.admin.integrations` and all nine resolvers existed — the "not mounted in this
      deployment" message the screen displayed was false, and the three source comments asserting it were
      stale. The real gap was app-side: a placeholder client and empty picker data. Two resolvers were also
      reachable from nothing — `runs`, which FR-105 requires so a silently-failing connector is detectable, and
      `delete`, which FR-097 names among the six admin actions (FR-094..FR-108)
- [x] T206 Promote `apps/sisyphus-control-plane/src/notify/` into `packages/sisyphus-notify`, and inject the
      notifier into `apps/sisyphus-admin/src/server/machine-dependencies.ts`. Both halves of the notification
      path now exist and cannot reach each other: delivery lives inside the control-plane **app**, while the
      machine surface that emits five of the nine events is mounted by **sisyphus-admin**. An app must not
      depend on another app, so the shared half becomes a package. Until this lands, `SisyphusDependencies`
      leaves `notifier` absent and those five events are a silent no-op — the correct default, not a working
      system (FR-136, FR-141)
- [ ] T200 [P] Give validation runs a way to authenticate (FR-147). The `validation_runs` table, the outcome
      enum, the admin surface and the control-plane job all exist; what is missing is **authentication, not a
      procedure**. `scoped_credentials.workflow_id` is `not null`, `workflowIdFromSubject` deliberately returns
      `undefined` for `validation:<id>`, and `credential-verification.ts` documents refusing that subject on
      purpose — so a validation-mode executor cannot reach the machine surface at all and halts with a named
      error. Needs: a credential path for validation subjects (nullable `workflow_id` plus a rework of the
      `scoped_credentials_live_key` partial index, or a separate store); a `validationProcedure` builder; a
      `VALIDATION_OUTCOMES` tuple in `src/enums/` — `validation_outcome` is the only pgEnum with no mirroring
      tuple, which breaks that module's own stated invariant; and a report input schema
- [ ] T201 [P] Brand `skillReferences.unavailableReason` as `SanitisedText` — every other free-text field on
      the machine surface is branded, and this one can embed a raw `readFile` error message. Touches the
      `SkillReferenceReporter` signature across the executor's workflow files (FR-045, FR-089)
- [ ] T202 [P] Carry `bundleId` and `name` on the job envelope's setup-bundle reference — the control plane
      sends `{s3Key, contentDigest, version}` and the executor bridges the gap with the s3Key, so an FR-088
      bundle failure names a key rather than the bundle an administrator would recognise (FR-088)
- [ ] T203 [P] Wire `.github/workflows/deploy.yml` to `getDeployRoleName` — the deploy workflow runs
      `nx run <app>:deploy` with no role assumption, so the bootstrap role and `assumeDeployRole` exist with no
      CI caller. The single-constant discipline T167 established only pays off once CI uses it (FR-200)

### Built, tested, and mounted nowhere — found by the assembly gate the moment it first ran

- [x] T207 [US1] Mount the log viewer. `apps/sisyphus-admin/src/components/log-viewer/` is nine files —
      SSE consumption, sequence reconciliation, segment store, the lot — with **zero importers**.
      `components/workflows/log-viewer-slot.tsx` is the named slot it belongs in, and its own doc comment says
      "when T077 lands, the detail panel passes `<LogViewer workflowId={id} />` as children". T077 is checked:
      it built the viewer. Nothing mounted it, and no task said to. Live output is US1's core promise, so
      SC-002 is currently unmet on the screen even though the transport, the viewer and the slot all exist
      (FR-046, SC-002)
- [x] T208 [US2] Mount the supervision controls. `apps/sisyphus-admin/src/components/supervision/` —
      `controls.tsx`, `correction-list.tsx`, `supervision-status.ts` — has zero importers.
      `components/workflows/supervision-slot.tsx` renders "not mounted" and states that the detail panel will
      pass the controls as children when Phase 7 lands. Phase 7 landed and built them. Pause, resume, stop and
      mid-run correction are therefore unreachable from the panel (FR-015, FR-049, SC-003)

_Both slots are honest — each says "not mounted" rather than rendering a blank region — so this was never
concealed. It was simply never anybody's task. That is the same defect as T172–T180, at the other end of the
system, and it is why T192 belongs in the gate rather than in a review._

### Coverage the panel convention cannot currently reach

- [ ] T204 [P] Panel-level query-state coverage for `UsersPanel`, `ProfilesPanel`, `WorkspacesPanel`,
      `IntegrationsPanel` and `ProfileAccessPanel`. These five hold their own queries, and per the existing
      convention their tests assert only "is a component" — so their loading, empty and error states are
      covered at the primitive and presentational-card level but never as the panel renders them.
      `NotificationPreferencesPanel` stubs the hooks and renders; extend that pattern (FR-201)
- [ ] T205 [P] Surface read failures on `/workflows/new`'s admin-only ad-hoc path — a failed `adHocWorkspaces`
      or `bundles` read currently returns empty selects, which is the same "empty claim on a failed query"
      defect T155 fixed everywhere else (FR-201)

### Loose ends the implementation reports named and no task yet owns

- [ ] T209 [P] Add a pending-supervision-command field to the workflow read path. `workflow.byId` reports the
      recorded state, so the window between issuing Pause and the executor acknowledging it is visible **only
      to the tab that issued it** — a second operator watching the same run sees `RUNNING` where the first sees
      `PAUSE REQUESTED`. Honest, but less informative than FR-015 intends. This rides on `workflow.byId`
      alongside `watching`, `storagePark` and `launchConfiguration`, which is the same argument all three used
      (FR-015)
- [x] T210 [P] Give the pause idle ceiling one home. `PAUSE_IDLE_CEILING_MS` is 30 minutes in **both**
      `apps/sisyphus-executor/src/session/idle-ceiling.ts` and
      `apps/sisyphus-control-plane/src/jobs/reconcile.ts` — the executor arms the timer, the control plane
      backstops it, and the two agree only by inspection. Both files document the duplication. Its shared home
      is `packages/sisyphus-api`, which neither task was permitted to edit at the time (FR-049)

  > **Satisfied by PR #19 (`003/T098`) — T232.** The constant now has exactly one definition,
  > `packages/sisyphus-api/src/contracts/pause-idle.ts:57`, exported through
  > `packages/sisyphus-api/src/contracts/index.ts:84` and imported from `@bluetel-ai/sisyphus-api/contracts` by
  > all three consumers: `apps/sisyphus-executor/src/session/idle-ceiling.ts:51`,
  > `apps/sisyphus-control-plane/src/jobs/reconcile.ts:1` and
  > `apps/sisyphus-admin/src/components/workflows/parking-countdown.ts:2` — the panel countdown being a third
  > site this task did not know about. Each re-exports it locally for its own callers rather than redeclaring
  > it, and `contracts/pause-idle.test.ts` pins the value. Verified by grep on merged `main`: no second literal
  > survives. **This is the only one of the 34 open tasks that PR #19 completed outright**, and this box is the
  > single checkbox T232 was permitted to flip.

- [ ] T211 [P] Fix the stale reference in `apps/sisyphus-control-plane/src/dispatch.ts` (~line 28) naming
      `buildControlPlaneTickSpecification`, which no longer exists — the tick payload is built inline in
      `createScheduler` from the exported `CONTROL_PLANE_TICK_JOB`. Also correct
      `packages/sisyphus-infra/src/scheduler.ts` (~line 126), which still lists admin bootstrap among the tick's
      responsibilities; T172 deliberately excluded it, because running it every minute would reinstate a
      deactivated bootstrap admin within the minute
- [ ] T212 **Out of scope for this feature — do not do it here.** cspell is configured (`cspell.json`, ~140
      words) and wired to nothing: no devDependency, no script, no CI step, so the config and every
      `cspell:ignore` directive in source are editor-only. That contradicts the constitution's "Knip and cspell
      configurations are workspace-level", and the contradiction is real — but **gating cspell is a
      workspace-wide change, not a Sisyphus one**, and it must not ride in on this feature. A trial wiring on
      2026-08-07 proved why and was reverted: 91 distinct unknown words across ~40 hand-written files, and the
      large majority sit outside these seven members entirely — third-party package names in
      `pnpm-workspace.yaml`, shell locals under `tooling/`, generic ignore-list fragments in a skill document.
      Turning the gate green would have meant editing unrelated tooling in a Sisyphus change. Findings kept so
      the real piece of work does not rediscover them: the categories above want **file-scoped
      `cspell:ignore`**, not global dictionary words (particularly the deliberate fake-secret fixtures in
      `apps/sisyphus-executor/src/output/secret-patterns.ts`, where a global entry would legitimise a token
      shape repo-wide); cspell's **bundled dictionaries should be enabled before a single word is added by
      hand**; and `"useGitignore": true` beats a hand-listed `ignorePaths`, because one untracked
      `tsconfig.tsbuildinfo` contributed 3,240 of the first run's 3,402 hits. Two defects found and **left
      unfixed** with the revert: `scripts/audit-cspell.mjs` `JSON.parse`s a file that is JSONC, so it has
      thrown `SyntaxError` on every invocation since `cspell.json` gained its first comment and has therefore
      never run — a fourth check in this repository that looks present and measures nothing — and its file walk
      scans `*.tsbuildinfo`, counting words kept alive only by build output as live. Its real dead-word count is
      **28, not the 32 recorded earlier**, plus a `PgBouncer`/`pgbouncer` case-duplicate

### Assembly tasks — one per story whose path does not yet run (rule 1)

_Each of these IS its story's checkpoint. None may be satisfied by its components passing._

_**Completed 2026-08-07.** This subsection first shipped with two tasks against thirteen stories — the phase
written to enforce rule 1 reproduced the defect it was written to prevent. The set below is now complete: every
user story US1–US13 has exactly one assembly task naming the quickstart scenario that runs its path, and the
prose checkpoints at lines 230, 339, 367, 393, 431, 462, 490, 540, 563, 581 and 601 are superseded by them —
none of those eleven sentences ever had a task behind it. The mapping, in scenario order: Scenario 1 → T226
(US7 + US12 + US13, which plan.md ships as one slice and quickstart covers as one scenario), Scenario 2 → T213
(US1), Scenario 3 → T223 (US9), Scenario 4 → T225 (US11), Scenario 5 → T218 (US2), Scenario 6 → T219 (US3),
Scenario 7 → T224 (US10), Scenario 8 → T214 (US8), Scenario 9 → T220 (US4) and T221 (US5) — one scenario, two
halves, two verdicts — Scenario 10 → T222 (US6). No story was left without a task: not one of the thirteen has
a checked task that proves its path today, so there was no ceremonial duplicate to avoid. **T140 stays** — it is
the full-suite sweep over all thirteen scenarios in one sitting, and these eleven are the per-story verdicts it
cannot give. All eleven need a deployed stage and none is a CI target — each says so in its own words, because a
recorded manual run is the honest verdict here and a green tick would be a fabricated one._

- [ ] T213 [US1] **Run quickstart Scenario 2 end to end** on a personal stage and record the result against all
      ten of its checks. This is the Phase 4 checkpoint that has never been executable, now written as the task
      it always needed to be. Requires T194 and T195. It provisions a real instance and opens a real draft pull
      request, so it cannot run in CI and deliberately has no `e2e` target — the verdict is a recorded run, not
      a green tick (SC-001, SC-002, SC-007, SC-009, SC-037, SC-040)
- [ ] T214 [US8] **Run quickstart Scenario 8 end to end** — a labelled ticket discovered by a scheduled poll,
      claimed exactly once, driven to a draft PR and written back. Requires T196 (`TicketPort`,
      `IntegrationPlanner`) and T198 (the prompt redactor, without which every integration tick refuses). The
      integration's components are all built and tested; no tick has ever run end to end. Label corrected from
      `[US4]` on 2026-08-07: Scenario 8 is the Jira integration, Phase 10 is US8, and SC-023..SC-026 are US8's
      criteria — two of the three signals agreed and the label was the outlier. It needs a stage and a real
      Jira project, so like T213 it cannot run in CI (SC-023..SC-026)
- [ ] T218 [P] [US2] **Run quickstart Scenario 5 end to end** — pause a long-running prompt mid-execution,
      correct it, resume, and record all seven steps. What running it proves is the thing no unit suite can:
      that the pause is observed by a live agent process rather than by a fixture — paused inside 10s, no
      further output, the process still alive, the snapshot registered **before** the acknowledgement, and the
      `supervision_commands` row moving `pending` → `acknowledged`. Requires T194 (without `DeveloperPort`
      there is no agent to pause) and the spike S1 turn-injection path closed by T011. Step 6's idle-ceiling
      park exercises T181 and step 7's concurrent pause/resume exercises T208's mounted controls, both of which
      are checked and neither of which has been run against a real instance. Supersedes the prose checkpoint at
      line 431. Not a CI target: it holds a real instance open for minutes and measures wall-clock latency, so
      the verdict is a recorded run with its timings, not a green tick (SC-003, SC-004)

  > **Superseded in wording by `003/FR-039`, `003/FR-041` — T232.** The subject still needs doing; the script it
  > runs no longer describes the platform. This task's success criteria include "the process still alive" after
  > a pause, and a pause now **ends the agent at the turn boundary and stops the instance with its disk
  > retained**, so the check as written would fail a correctly working platform. The 10-second ceiling (SC-003)
  > and the snapshot-before-acknowledgement ordering (FR-049's surviving half) both still hold. **T236** rewrites
  > quickstart Scenario 5; this task then runs the rewritten script. **Blocked on T236.**

- [ ] T219 [P] [US3] **Run quickstart Scenario 6 end to end** — force-terminate an instance mid-run, resume on
      a fresh one, and prove the conversation and the uncommitted working tree both survive. Requires T194 and
      T195 (Scenario 6's own note says it requires Scenario 2 to run first), and step 2 additionally requires
      **T197**: until the real `InstanceMetadataReader` lands, `watchForInterruption` runs against
      `createQuietMetadataReader()` and no spot reclamation is ever detected, so that step tests nothing. Must
      be run on interruptible capacity with a genuine reclamation, not a simulated signal. Step 3's successor
      chain reads back through T188's resolver change. Supersedes the prose checkpoint at line 462. Not a CI
      target — it destroys and re-provisions real compute (SC-005, SC-008, SC-019, SC-039)

  > **Superseded in wording by `003/FR-041`, `003/FR-043` — T232.** Resume is no longer a snapshot restore onto
  > a fresh instance: it is `StartInstances` against the **same** stopped box, without re-provisioning,
  > re-cloning or restoring. Snapshots remain the durability and recovery path and stop being the pause-resume
  > path, and "that instance cannot be started again" is a **new** case this task never covered — recovery onto
  > a fresh instance holding the same credential, with the substitution recorded. This task's dependency on
  > **T197** is unchanged and is now more severe than its own wording implies, since spot is the default
  > purchase mode; see **T240**. **T237** rewrites quickstart Scenario 6; this task then runs it. **Blocked on
  > T237.**

- [ ] T220 [P] [US4] **Run quickstart Scenario 9's autonomous half end to end** — the develop → review →
      integrate loop against `sisyphus-scratch-a` with a deliberately review-failing ticket, plus step 1's
      missing-skill halt. Running it proves the two things the loop's 908 executor tests cannot: that it stops
      at **exactly three** iterations against a real reviewer rather than a stubbed verdict, and that branch
      naming, PR creation and ticket transitions come from `sisyphus-dev` in the repository rather than from a
      Sisyphus default — which is the whole of SC-016. Requires T196 (`TicketPort` and `IntegrationPlanner`,
      both of which `runAutonomousWorkflow` halts at today), T194 and T195. T178 already calls the workflow
      from the entry point; nothing has ever let it finish. Supersedes the prose checkpoint at line 563. Not a
      CI target: it opens a real PR and moves a real ticket three times (SC-010, SC-016)
- [ ] T221 [P] [US5] **Run quickstart Scenario 9's review half end to end** — steps 2, 3 and 4: a review
      against a PR with a known defect, a review against an already-merged PR, and a forced retry on an
      external action. Running it proves findings land anchored to entry + file + line on the real PR, that the
      merged-PR case exits as a recorded no-op with zero comments and zero transitions, and that the retry
      produces no duplicate — the last of which is the **durable** idempotency T180 built and which no test has
      ever exercised through a real host API. Requires T196 (`FindingsPublisher`) and T195. Independent of T220
      once T196 lands: a standalone review needs no autonomous run to have happened. Supersedes the prose
      checkpoint at line 581. Not a CI target — it comments on a real pull request (SC-018, SC-016)
- [ ] T222 [US6] **Run quickstart Scenario 10 end to end** against a stage that already carries the history the
      other assembly tasks left behind — filter across every dimension and compose them, open a workflow whose
      instance was released, and read the spend view. This one is deliberately **not** `[P]`: oversight over an
      empty fleet proves nothing, so it runs last, after T213, T218–T221, T223 and T226 have produced runs
      across several profiles, users and states. It is also the only end-to-end read of T188's changed resolver
      against real archived data. Supersedes the prose checkpoint at line 601. Not a CI target: its subject is
      a stage's accumulated history, which no fixture reproduces (SC-011, SC-012, SC-013, SC-014, SC-026)
- [ ] T223 [P] [US9] **Run quickstart Scenario 3 end to end** — create a profile, launch supplying only a
      prompt, and time it. Steps 4, 5 and 6 (locked-field override, the disabled-bundle and empty-workspace
      refusals, the non-admin ad hoc refusal) are already covered by `sisyphus-api`'s database-backed suites;
      what only a stage can prove is steps 2 and 3 — that the run **actually used** every profile value on the
      instance, that the workflow records profile and version, that the override and its originating profile
      are both recorded, and that the whole interaction fits inside 30 seconds. Requires T194 and T195, since a
      run that halts at the missing port carries no evidence it used the profile's model, caps or bundle.
      Supersedes the prose checkpoint at line 367. Not a CI target — the 30-second bound is a human
      interaction measured on a deployed panel (SC-027, SC-028, SC-029, SC-030)
- [ ] T224 [P] [US10] **Run quickstart Scenario 7 end to end** — a two-entry workspace over
      `sisyphus-scratch-a` and `sisyphus-scratch-b` with a prompt requiring a change in both, then its four
      failure probes. Requires T195 above all: one PR per **changed** entry, sharing a branch name and
      cross-referencing each other, is three `Forge` calls that nothing can make today, and SC-031 is
      unmeasurable without them. Also requires T194. Step 4's branch-lock refusal is the only end-to-end
      exercise of the advisory lock that CI now runs headlessly, and step 5 proves the snapshot covers the
      whole `/workspace` root rather than one entry. Supersedes the prose checkpoint at line 490. Not a CI
      target — two real repositories, two real pull requests (SC-031, SC-032, SC-033)
- [ ] T225 [P] [US11] **Run quickstart Scenario 4 end to end** — launch, close the panel, and confirm the Slack
      DM arrives within 2 minutes of terminal carrying workflow, ticket, workspace, state, reason and
      consumption. T177 wired the delivery call and T206 promoted `sisyphus-notify` and injected the notifier,
      so both halves of the path now exist; **no notification has ever been delivered to a real Slack
      workspace**. Requires T194 and T195 for runs that reach a terminal state at all. Step 3 is the one that
      must not be skipped — an address with no Slack identity has to leave the run's outcome untouched, which
      is the whole of SC-042 — and step 5 exercises Phase 16's preferences and watching against live delivery.
      Supersedes the prose checkpoint at line 393. Not a CI target: it needs a real Slack workspace and
      measures a 2-minute wall-clock window (SC-034, SC-035, SC-036, SC-042)
- [ ] T226 [US7] [US12] [US13] **Run quickstart Scenario 1 end to end** — all seven parts, on a stage deployed
      fresh with `SISYPHUS_BOOTSTRAP_ADMIN_EMAILS` set to an address that has never signed in. One task for
      three stories because plan.md ships them as one slice and quickstart covers them as one scenario; the
      "Story independence" note below already records why. Requires **T200**: 1b's validation run and 1d's
      redaction check are both unreachable until validation subjects can authenticate, and a validation-mode
      executor halts with a named error today. 1f and 1g additionally need workflows on two profiles to exist,
      so they follow T213 and T223 — with an empty `workflows` table there is nothing for FR-190 to leak, and
      the leak test passes vacuously. Not `[P]` for that reason. Not a CI target: 1a-bis is a fresh stage
      deploy, a redeploy and a third deploy with the address removed, and 1b provisions a real instance
      (SC-022, SC-029, SC-038, SC-046, SC-047, SC-048, SC-049, SC-050, SC-051, SC-052, SC-053, SC-054)

### Gate verification — plant the failure, watch the gate fail (rule 4)

_Three gates in this feature passed while measuring nothing. Each of these takes minutes and is the only thing
that distinguishes a working gate from a decorative one._

- [ ] T215 [P] Verify the assembly gate detects what it claims. Plant a module with a colocated test and no
      production caller, confirm `pnpm knip:orphans` reports it; separately remove the only production caller
      of a real module, leaving its barrel export and tests intact, and confirm it is reported. Revert both.
      Record the two outputs in the quickstart's quality-gates section. **The specific failure this guards
      against is the one already found: `knip --production` honours only entry patterns carrying a trailing
      `!`, and without one it analyses zero files and exits clean** (SC-063)
- [ ] T216 [P] Verify the database gate. With `CI` set and `SISYPHUS_TEST_DATABASE_URL` unset, confirm the
      guarded suites **fail** rather than skip; with neither set, confirm they skip. Record the passing and
      skipped counts both ways — the figures that matter are `sisyphus-api`'s 1,519/0 with a database against
      951/568 without (FR-204, SC-064)
- [ ] T217 [P] Verify each measured latency test fails when its budget is breached. Inflate the operation past
      its bound, confirm red, revert. This is what separates the new tests from the constant-arithmetic ones
      they replaced — and measuring found three real defects those could not see: the 50s-not-80s notification
      window, the snapshot budget admitting 10.5s against SC-003's 10s ceiling, and `QUIESCE_BUDGET_MS` being
      passed to an adapter rather than enforced (FR-205, SC-003, SC-034)
- [ ] T227 [P] Fix the flaky executor suite — a gate that intermittently lies is the fourth instance of this
      phase's theme. `apps/sisyphus-executor/src/delivery/git.test.ts`, `delivery/staleness.test.ts`,
      `delivery/pull-request.test.ts` and `run/bootstrap.test.ts` spawn a real `git` and intermittently exceed
      vitest's default 5,000 ms, failing with `Test timed out in 5000ms` under load. Reproduced on 2026-08-07:
      four files failed on one run and 937/937 passed on the next with no code change, and **Nx's own flaky-task
      detector flagged `sisyphus-executor:test`**. Give the process-spawning tests an explicit timeout sized to
      what they actually do, or a fake `git`, rather than raising the suite-wide default — a global raise hides
      the next genuinely slow test. It is pre-existing and unrelated to any single task, but it makes the test
      gate non-deterministic, so a red CI run cannot presently be trusted to mean a real failure (Constitution
      III, SC-064)
- [ ] T228 Mechanise Constitution III. Add a CI check that fails when a shipped source file has no colocated
      `<name>.test.ts` sibling, alongside the assembly gate and outside the `nx affected` set for the same
      reason. **The pre-commit hook cannot catch this and never could**: it runs the colocated test of every
      staged source file, which by construction does nothing when there is no such test, so a file with no test
      is invisible to the gate that requires one. That is how T173's `main.ts` shipped untested under the
      workspace's one NON-NEGOTIABLE principle. The check needs exactly one recorded exemption list —
      `sisyphus-infra`'s resource-creating primitives per FR-200 — written as named files with reasons, never a
      glob, so that widening it is a reviewable diff. Verify it against a planted failure per rule 4: delete a
      colocated test, confirm the check fails, restore (Constitution III, FR-004)

**Checkpoint**: **T213**. Not the sentence above it, and not this phase's other tasks passing — quickstart
Scenario 2, run on a stage, with its ten checks recorded. Until T194 and T195 land it cannot run, whatever the
gate says.

---

# The remediation layer — Phases 20–26

_Added 2026-08-10, from [GAP-ANALYSIS-2026-08-09.md](./GAP-ANALYSIS-2026-08-09.md),
[SPEC-003-004-IMPACT-2026-08-09.md](./SPEC-003-004-IMPACT-2026-08-09.md) and
[PR-19-IMPACT-2026-08-10.md](./PR-19-IMPACT-2026-08-10.md). Generated against
`.specify/templates/tasks-template.md` conventions._

**Phases 1–19 above are history and are not edited by this layer.** No task T001–T231 is renumbered,
reworded or re-ticked here, including the ones this layer supersedes — the record of what was planned and
what was done is worth more intact than tidy, and the same argument the Phase 19 preamble makes about
checked-but-in-breach tasks applies to superseded ones.

> ### Re-verified after specs 003 and 004 landed on `main` (2026-08-10)
>
> This layer was written against PR #19's head. Specs 003 and 004 have since merged to `main`
> (`3e60717`), along with a follow-up reconciliation commit (`0f0d288`) that neither analysis had seen.
> **Every task below was re-checked against the merged tree and none changed.** Recorded because the
> re-check is worth as much as the original finding, and a layer that was not re-verified after its
> subject moved should not be trusted.
>
> | Task                                     | Re-verified on merged `main`                                                                                                                                      |
> | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | T232 (T210 satisfied)                    | Holds — three consumers import `PAUSE_IDLE_CEILING_MS` from `@bluetel-ai/sisyphus-api/contracts`                                                                  |
> | T233 (`awaiting_credential`)             | Holds — still **zero** occurrences in `spec.md`, `data-model.md` or `quickstart.md`                                                                               |
> | T234 (pool prerequisite)                 | Holds — `quickstart.md`'s only "pool" references are PgBouncer connection pooling in the S3 spike                                                                 |
> | T236 (Scenario 5)                        | Holds — `quickstart.md:400` still reads "the process is alive (not terminated)"                                                                                   |
> | T237 (Scenario 6)                        | Holds — step 1 still resumes by restoring a snapshot onto a fresh instance, not by starting the stopped one                                                       |
> | T238 (forge URL)                         | Holds — still no producer; the only reference outside the executor is a comment at `jobs/start-workflow.ts:106`                                                   |
> | T239 (T231 residue)                      | Holds — `assembleRun` still returns `options` with no `secrets` key                                                                                               |
> | T240 / T197, T241 / T200, and T198, T196 | All hold — `createQuietMetadataReader`, `validationModeUnsupportedError`, `?? createRefusingPromptRedactor()` and `noWorkflowPorts` are all present and unchanged |
>
> **What the merge did add is one piece of context, and it changes a rationale rather than a decision.**
> [plan.md](./plan.md) gained a "fourth finding" recording that FR-124's reachability probe was not merely
> unimplemented but **unimplementable**, and it draws two rules from that: _a seam is a claim that both sides
> can exist_, and _when a seam's real implementation needs a credential, name which component will hold it and
> how it gets there before writing the interface_. It then names `apps/sisyphus-control-plane/src/jobs/prompt-redact.ts`
> — **T198's refusing default** — and `notify/emitter.ts` as the two modules citing that probe as precedent,
> judging both to be on paths where absence _degrades rather than blocks_.
>
> That judgement is right at the platform level and does not soften T198: a refusing redactor means **US8 is
> dead in production**, which is a blocked story even though the product as a whole still runs. What it does
> change is the reading — T198 is a **deliberate, documented deferral** rather than an oversight, so it should
> be scheduled rather than escalated. The two rules apply directly to **T238** and to **T200**, both of which
> are exactly the case the second rule describes: a seam whose implementation needs a credential nobody named
> a holder for.

**What this layer is**: the answer to _what actually needs doing now_, after spec 003 landed as
[PR #19](https://github.com/bluetel/bluetel-ai/pull/19) (125/129) and spec 004 closed.

**Two conventions, because this layer has to stay honest about its relationship to the one above it.**

1. **New work gets a new number** (T232+). Nothing below re-states an existing task's body.
2. **Still-valid work is carried forward by reference**, in a `**Carried forward**` line per phase. Those
   tasks remain open where they are, are still the source of truth for their own scope, and are listed here
   only so this layer is a complete answer rather than a partial one. Duplicating them under new numbers
   would create two ledgers and guarantee they diverge.

**Traceability vocabulary**, used verbatim below so a reader can grep it:

| Term                         | Meaning                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Satisfied by**             | The named external work completed this task's subject. Tick it; do not redo it                                                       |
| **Partially satisfied by**   | Part of the subject shipped; the residue is a **new** task here, which names what is left                                            |
| **Superseded in wording by** | The task's subject still needs doing, but its description now describes behaviour the platform no longer has. Rewrite before running |
| **Carried forward**          | Unaffected. Still correct exactly as written above                                                                                   |
| **Blocked on**               | Cannot start until the named task lands                                                                                              |

### Supersession summary — the whole of PR #19's effect on Phases 1–19

| Original     | Verdict                                                 | Detail                                                                                                                                                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T210**     | **Satisfied by** PR #19 (003/T098)                      | `PAUSE_IDLE_CEILING_MS` now defined once in `@bluetel-ai/sisyphus-api/contracts`; read by `apps/sisyphus-executor/src/session/idle-ceiling.ts:51`, `apps/sisyphus-control-plane/src/jobs/reconcile.ts:1` and `apps/sisyphus-admin/src/components/workflows/parking-countdown.ts:2`. **The only one of the 34 that can be ticked.** Recorded by T232 |
| **T231**     | **Partially satisfied by** PR #19 (003/T054)            | The provider shape landed — `createSecretRegistry` in `apps/sisyphus-executor/src/output/secret-registry.ts`, threaded as `secretRegistry.current` through `run/execute.ts:283`. The seeding did **not**: `assembleRun` still returns `options` with no `secrets` key, so the registry is empty on every real run. Residue is **T239**              |
| **T218**     | **Superseded in wording by** `003/FR-039`               | Its Scenario 5 script checks the agent process is still alive after a pause; a pause now stops the instance on on-demand. Script rewritten by **T236**, then T218 runs it                                                                                                                                                                           |
| **T219**     | **Superseded in wording by** `003/FR-041`, `003/FR-043` | Resume is now `StartInstances` against the same box, not a snapshot restore; and a stopped instance that cannot restart is a new case. Script rewritten by **T237**, then T219 runs it                                                                                                                                                              |
| **T079**     | **Satisfied by** spec 004 (already noted in place)      | Recorded here only for completeness; no action                                                                                                                                                                                                                                                                                                      |
| All other 30 | **Carried forward**                                     | Individually re-verified against PR #19 head `c32258d`; none affected                                                                                                                                                                                                                                                                               |

**Nothing in Phases 1–19 is deletable.** No task became unnecessary.

---

## Phase 20: Ledger and document reconciliation (Priority: P1)

**Goal**: the specification, the task list and the quickstart stop contradicting each other and the code. PR #19
reconciled `spec.md`, `data-model.md` and `contracts/executor-protocol.md` and left the other two, so a reader
following this feature's own instructions today is following superseded ones.

**Why first**: it is hours of editing, it blocks nothing, and everything after it is read through it. Every
phase below is planned against documents that are currently wrong in two known places.

**Independent test**: grep this directory for `awaiting_credential` and get hits; read Scenario 5 in
`quickstart.md` and find it describing a stopped instance; read this file's Phase 19 and find T210's
disposition recorded.

- [x] T232 Append a **supersession ledger** to this file recording the dispositions in the summary table
      above — T210 satisfied, T231 partially satisfied with its residue named, T218/T219 superseded in
      wording. Append-only: a `> **Superseded …**` block beneath each affected task, in the style
      `specs/004-remove-reachability-gate` already used on T079, and **no checkbox above T232 is flipped by
      this task** except T210's, which is the one genuinely completed. The ledger is what makes the layer
      traceable; without it the phases below refer to dispositions recorded nowhere
- [x] T233 [P] Add `awaiting_credential` to the workflow-state table in
      `specs/002-sisyphus-workflow-platform/data-model.md`, with its meaning (admitted, holding no compute,
      waiting for a pool seat), its position between `queued` and `provisioning`, and its valid exits.
      **Found by cross-artifact analysis, not by any gate**: it is a live member of `WORKFLOW_STATES` and
      `ACTIVE_WORK` at `packages/sisyphus-api/src/enums/workflow-state.ts:21,55` and appears **zero times**
      anywhere under this directory — including in the state table PR #19 edited two rows above it. That
      table is this specification's canonical enumeration, and T042's leak test, T075's state chip and
      T076's filters are all specified against it (`003/FR-020`)
- [x] T234 [P] Reconcile `specs/002-sisyphus-workflow-platform/quickstart.md` with spec 003 — the file PR #19
      did not touch. Add the pool prerequisite (a registered, logged-in seat and a credential group attached
      to the profile under test) to the setup step of **every** scenario, because
      `packages/sisyphus-api/src/server/admin/profiles.ts:237` now refuses an unattached profile as
      unlaunchable and every scenario launches from one (`003/FR-065`)
- [x] T235 [P] Fix the four remaining broken commands and stale target names in `quickstart.md` that T191 did
      not cover, and re-verify T191's five against the current `project.json` set — PR #19 added dispatch
      routes and targets, so the guide's command surface moved under it
- [x] T236 Rewrite quickstart **Scenario 5** for pause-as-stop (`003/FR-039`, `003/FR-041`): the agent is
      **ended** at the turn boundary, the instance is **stopped with its disk retained**, compute billing
      ends, and resume is a start of the same instance rather than a restore. Keep the 10-second pause
      ceiling (SC-003) and the snapshot-before-acknowledgement ordering (FR-049's surviving half) — both
      still hold. Add the spot branch explicitly: a one-time spot instance cannot be stopped and degrades to
      this document's snapshot-and-terminate path, which is why `003/SC-007` reports two figures. **Supersedes
      the wording of T218, which then runs this script**
- [x] T237 Rewrite quickstart **Scenario 6** for the new resume and recovery split (`003/FR-041`,
      `003/FR-043`): resuming a paused run starts its existing instance without re-provisioning, re-cloning
      or restoring; and a **new step** for the case that instance cannot be started again — recovery from the
      durable snapshot onto a fresh instance **holding the same credential**, with the substitution recorded.
      Snapshots remain the durability and recovery path and stop being the pause-resume path. **Supersedes
      the wording of T219, which then runs this script**

**Checkpoint**: no document under `specs/002-sisyphus-workflow-platform/` describes behaviour the platform
does not have, and this file records what PR #19 did to it.

---

## Phase 21: The launch blocker no task ever owned (Priority: P1) 🎯

**Goal**: an executor instance boots.

**Why its own phase**: it is one variable, it is the single manual step between this repository and its first
successful run, and it has now survived three branches without a task. Burying it in a polish list is how it
got here.

**Independent test**: provision an instance from a clean stage deploy and watch bootstrap pass env validation.

- [x] T238 Give `SISYPHUS_FORGE_API_URL` a producer and an owner.
      `apps/sisyphus-executor/src/env-schemas.ts:51` declares it `z.string().url()` — **required, not
      optional** — and nothing in this repository sets it, so the first real run fails at boot naming the
      variable. `apps/sisyphus-control-plane/src/jobs/start-workflow.ts:106` deliberately declines to carry it
      on the envelope ("instance configuration rather than job configuration"), which is the right call and
      leaves the gap. Either put it on the instance environment at the site that builds the launch unit, or
      document it as a stage parameter in `quickstart.md`'s deploy section with the SSM key named — but
      **decide, and write it down**. Recorded to date only as prose inside checked task **T229**, which is why
      nothing on the open list surfaces it. Re-verified absent on PR #19 head `c32258d` (FR-075, FR-202)

  > **Done, and the task's premise was wrong in a way worth recording.** This task assumed the fix was to put
  > one variable on the instance environment "the way its siblings get there". Tracing the chain showed **the
  > siblings do not get there either**: `encodeUserData` (`jobs/job-envelope.ts:181`) serialises the envelope as
  > JSON only, `aws/compute.ts:479` base64s that verbatim into `RunInstances.UserData`, and the executor reads
  > it from a file or stdin (`main.ts:76`). `SISYPHUS_BUNDLES_BUCKET`, `SISYPHUS_LOGS_BUCKET`,
  > `SISYPHUS_SNAPSHOTS_BUCKET` and `SISYPHUS_MACHINE_SURFACE_URL` reach the **control plane's Lambda**
  > (`control-plane/sst.config.ts:320-350`), not the instance. **None of the executor's seven required
  > variables had a producer.** The forge URL was the one somebody noticed.
  >
  > Resolved by publishing the whole instance environment as one `.env`-shaped Parameter Store entry at
  > `/sisyphus/<stage>/executor/instance-environment`, beside the existing release key
  > (`executor/sst.config.ts:181`) and for the same reader, with deploy-time validation so a stage missing the
  > value fails `sst deploy` naming the variable instead of deploying clean and dying at first boot. The job
  > envelope is untouched, so `start-workflow.ts:106`'s boundary still holds. **Blocked from taking effect by
  > T247.**

- [ ] T247 Grant the runner role `ssm:GetParameter` on its own stage's parameters. **Found while closing
      T238**, which is inert without it: `buildRunnerPolicy`
      (`packages/sisyphus-infra/src/policies.ts:391`) grants S3 and Session Manager only, so an instance cannot
      read the instance-environment parameter T238 publishes — **nor the executor release-key parameter, which
      has had the same gap since that stack was written and is how the launch unit is supposed to learn what to
      run**. Scope the grant to `arn:aws:ssm:<region>:<account>:parameter/sisyphus/<stage>/executor/*` rather
      than the account's parameters at large. This means widening `RunnerPolicyConfig` with region, account and
      stage and rippling through `runner-role.ts` and `policies.test.ts` — a different shape of change from
      T238, which is why it is its own task rather than an amendment to it (FR-075, FR-202)

**Checkpoint**: a fresh instance reaches bootstrap phase 2 rather than dying in env validation. **T213 cannot
run before this.** **Not met by T238 alone** — the value is published but unreadable until **T247** lands.

---

## Phase 22: The two live defects (Priority: P1)

**Goal**: stop the platform doing two things it must not — leaking client credentials into a streamed log, and
losing work silently on the default purchase mode.

**Why together**: both are defects rather than absences, both are in the executor, and both are invisible when
they fire. Everything else outstanding in this feature is something that does not happen yet.

**Independent test**: plant a credential in a bundle's `setup.sh` output and confirm it is redacted from the
segment the panel streams; reclaim a spot instance and confirm the snapshot path runs.

- [x] T239 [US1] Seed the secret registry from bundle-installed credentials — **the residue of T231**, which
      PR #19 partially satisfied. `createSecretRegistry` and the `SecretSource` shape now exist and are
      threaded through every redaction site (`apps/sisyphus-executor/src/output/secret-registry.ts`,
      `run/execute.ts:283`), and the rotating agent credential registers through them. What did not change:
      `assembleRun` still returns an `options` object with **no `secrets` key**
      (`apps/sisyphus-executor/src/run/assemble.ts:247-268`), so `runExecutor` reads `options.secrets ?? []`
      and the registry is **empty on every real run**. Bundle-installed client credentials therefore still
      reach the streamed log protected only by pattern matching in `output/secret-patterns.ts` — the exact
      consequence T231 was written about, unchanged. Register every value the bundle installs at phase 5
      through `registry.add`, and verify per Phase 19 rule 4 with a **planted secret that reaches a log
      segment**. The architectural half is done; this is the half that was dangerous (FR-045, FR-072,
      `003/FR-014`)
- [x] T240 [US3] **Carried forward: T197** — the real `InstanceMetadataReader` against IMDS. Recorded here
      because the companion analysis **corrected its severity** and the correction has not reached its
      original entry: T197 is qualified there as conditional on whether `purchase_mode` will ever be `spot`.
      Spot **is** the default — `packages/sisyphus-api/src/enums/purchase-mode.ts:17` sets
      `DEFAULT_PURCHASE_MODE = 'spot'`, and `003/FR-039` states it as the platform default. So this is silent
      data loss in the **default** configuration, not an edge case. `watchForInterruption` still runs against
      `createQuietMetadataReader()` on PR #19 head; no `169.254.169.254` exists outside a test file. Do the
      work under T197; this entry exists so its priority is not read off its original wording (FR-054)

- [ ] T248 [US1] Make `RunExecutorOptions.secrets` a `SecretSource` rather than a frozen array — **the last
      residue of T231, left behind by T239**. `run/execute.ts:153` still types it
      `readonly KnownSecret[]`, and `output/secret-registry.ts:60-61` copies it at construction
      (`let secrets = [...initial]`), so nothing can grow that seed afterwards through that argument. T239
      worked around this correctly by seeding the run-wide registry from inside bootstrap phase 5, where the
      values become knowable, which closes the dangerous case. Two narrower ones stay open and both need this
      type change: **(a)** the forge credential (`run/forge-credential.ts`) is registered only on the forge's
      own redactor unless the bundle also happened to write it under `credentials/`; **(b)** `setup.sh`'s own
      output during phase 5 is still pattern-only, because the values are not knowable until the script
      installing them exits — closing that additionally needs `secrets` widened at `bootstrap/bundle.ts:126`
      and `bootstrap/run-command.ts:38`. Not urgent, and explicitly **not** a reason to reopen T239 (FR-072,
      FR-089)
- [ ] T246 [US1] **The ad hoc launch path is dead under spec 003, and nothing reports it as such.** Found
      during T234's scenario sweep and confirmed independently against merged `main`; it is owned by no task on
      either specification. The chain: `packages/sisyphus-api/src/server/workflow/start-ad-hoc.ts:171` writes
      `executionProfileId: null`; `apps/sisyphus-control-plane/src/credentials/allocate/select.ts` reaches
      candidate credentials only by joining out through that column, so `wait-reason.ts:305` classifies such a
      run `NO_EXECUTION_PROFILE` and `wait-reason.ts:379` marks it **not grantable**; `admit-workflow.ts`
      therefore admits it deliberately **without a seat**, rather than queueing it in a queue nothing could
      ever serve. That decision was correct when it was made, and its own comment states the condition it rests
      on — `admit-workflow.ts:142`: _"nothing downstream is yet ready to require one of them — the executor's
      `credential_install` phase is T055/T056"_. **That phase has since landed and is unconditional**:
      `apps/sisyphus-executor/src/run/bootstrap.ts:442` is commented _"Phase 5a. Unconditional"_ and `await`s
      `installAgentCredential` on a straight line with no branch, on every boot path including restore and
      resume (`003/FR-050`). The credential it asks for comes from
      `packages/sisyphus-api/src/server/machine/agent-credential.ts`, which throws `PRECONDITION_FAILED` for a
      workflow holding no live lease (`:201`, `:281`). So an ad hoc run is now admitted, provisioned, billed
      for an instance, and **fails at bootstrap phase 5a** — after the compute is running. Either re-route ad
      hoc launches through the pool, refuse them at admission with the real reason, or withdraw the path; but
      the stale premise at `admit-workflow.ts:142` must not survive whichever is chosen. Quickstart Scenario 2
      was rewritten under **T234** to direct its launch through an enabled profile, which documents around the
      defect and does not fix it (`003/FR-051`, `003/FR-052`, FR-122)

**Carried forward**: T197 (see T240), T201 (`skillReferences.unavailableReason` still `z.string().optional()`
at `packages/sisyphus-api/src/schemas/machine.ts:158` — verified unchanged by PR #19).

**Checkpoint**: a planted bundle credential does not appear in any stored or streamed segment, and a
reclaimed spot instance suspends rather than vanishing.

---

## Phase 23: The three stories that cannot run (Priority: P1)

**Goal**: US4, US5 and US8 stop halting at a missing port or a refusing default. Three of the thirteen stories
are currently non-functional in production for reasons unrelated to the credential pool.

**Why now**: this is the largest block of real code left in the feature, and **PR #19 touched none of it** —
verified individually. It shares no files with the credential pool, so it can proceed in parallel with that
merge, by a different engineer.

**Independent test**: launch one review workflow and one autonomous workflow and have each reach a terminal
outcome other than "assembled without the ports that workflow type needs"; let one integration tick assemble a
prompt without throwing.

- [ ] T241 [P] Confirm `003/FR-052` is satisfied once **T200** lands, and record the verdict against it —
      "bundle validation runs MUST remain possible without holding a credential, so proving a bundle does not
      consume pool capacity". **PR #19 shipped that requirement against an unsolved dependency**:
      `validationModeUnsupportedError` is present and unchanged in
      `apps/sisyphus-executor/src/run/assemble.ts`, `scoped_credentials.workflow_id` is still `not null` and
      `workflowIdFromSubject` still returns `undefined` for a `validation:<id>` subject, so a validation-mode
      executor still cannot reach the machine surface at all. This task is the cross-spec check that closes
      the loop; T200 is the work. **Blocked on** T200

**Carried forward**, in the order they should be done:

1. **T200** — the validation credential path. Now on **both** specs' critical paths (`003/FR-052` above, and
   quickstart 1b/1d here). Verified untouched by PR #19
2. **T198** — package the FR-163 prompt redactor. `apps/sisyphus-control-plane/src/context.ts:271` still reads
   `?? createRefusingPromptRedactor()`, so **every integration tick still refuses**. A package move plus a
   one-line override; it gates T214
3. **T196** — `FindingsPublisher`, `TicketPort`, `IntegrationPlanner`. `noWorkflowPorts` at
   `apps/sisyphus-executor/src/run/assemble.ts:80-96` still names all five missing pieces in its own doc
   comment, unchanged by PR #19. Gates T220 and T221

**Checkpoint**: `dispatchWorkflow` no longer throws `missingWorkflowPortsError` for any of the three workflow
types, and an integration tick assembles a redacted prompt.

---

## Phase 24: Gate integrity (Priority: P1 — do first, costs hours)

**Goal**: the gates measure what they claim, and a red run means a real failure.

**Why it stays P1 despite being carried forward entirely**: PR #19 pushed 316 files and ~53,000 lines through
these same gates. Phase 19's rule 4 — every gate verified against a planted failure — is the one rule of the
four that was never mechanised, and it is still the cheapest thing in this file.

**Independent test**: each of the three gates goes red on demand, and the executor suite passes twice running.

- [ ] T242 [P] Adopt PR #19's falsification practice as this feature's standard and record it in
      `quickstart.md`'s quality-gates section. It found **four** defects that reading code did not — a race
      suite that passed with the exclusivity index dropped, a cooling-off sweep that would have returned a
      still-held credential, a streaming redactor that emitted a secret in halves across a buffer boundary,
      and a reconcile sweep that would have terminated every correctly paused instance five minutes after
      pausing. That is rule 4 working, applied to 003's gates. **This feature's three gates are still
      unverified.** Point the same technique at them (SC-063, SC-064, FR-205)

  > **Half done — deliberately left unticked.** The practice is now recorded: `quickstart.md` gained a
  > _"Falsify the gate before you trust it"_ subsection carrying the four PR #19 defects and a falsification
  > recipe for each of this feature's three gates. **Recording a recipe is not running it**, and this task's
  > second sentence asks for the gates themselves. Those are **T215–T217**, carried forward below and untouched
  > here. Ticking this on the strength of the documentation alone would reproduce exactly the failure mode the
  > task exists to name — a check that looks present and measures nothing.
  >
  > One data point arrived free. While verifying T244, `knip:orphans` was run nine times during concurrent
  > edits and went **red** the moment an unwired module appeared
  > (`packages/sisyphus-infra/src/executor-instance-environment.ts`, then
  > `apps/sisyphus-executor/src/session/instance-metadata.ts`), then **green** once each was wired in. That is
  > **T215's** falsification observed by accident rather than by design — an orphan planted, and the gate
  > reported it. It is recorded here as evidence, not as a substitute for running T215 deliberately.

**Carried forward**: **T215** (assembly gate — plant an orphan, confirm `knip:orphans` reports it),
**T216** (database gate — confirm the guarded suites fail rather than skip with `CI` set and
`SISYPHUS_TEST_DATABASE_URL` unset), **T217** (latency gates — inflate each operation past its bound, confirm
red), **T227** (the flaky executor suite — still no explicit timeouts in
`apps/sisyphus-executor/src/delivery/git.test.ts`, verified on PR #19 head), **T228** (mechanise Constitution
III — still no colocated-test check in `.github/workflows/ci.yml`).

**Checkpoint**: three gates proven against planted failures, and `sisyphus-executor:test` green twice in
succession under load.

---

## Phase 25: The stage exercise (Priority: P1)

**Goal**: something runs end to end. Not one of this feature's thirteen stories has ever been executed against
a deployed stage, and **neither has the credential pool** — PR #19's own T123 is unticked for the same reason,
recorded in `specs/003-agent-credential-pool/outstanding.md`.

**Independent test**: it is the test. A recorded run, not a green tick.

- [ ] T243 Run **002/T213** (quickstart Scenario 2) and **003/T123** (its quickstarts 1–8) as **one stage
      exercise** on one stage, and record both verdicts. They need the same deployed stage, the same pool
      setup and the same first-boot debugging, and 003/T123 already walks the scenarios T226 and T214 depend
      on. Running them separately pays the stage-bring-up cost twice and produces two partial pictures of the
      same first run. **Blocked on** T238 — without the forge URL the exercise stops at env validation — and
      on T232–T237, so the scripts being followed are the current ones. This also discharges the first deploy
      of the Phase 17 infrastructure, which per FR-200 carries no unit tests by design and **has never been
      deployed**: expect the exercise's first failures to be ambiguous between infrastructure and application,
      and budget for that rather than being surprised by it

**Carried forward**, all **blocked on** T243 establishing that a run works at all: **T213** and **T214**;
**T218** and **T219** (against the scripts T236 and T237 rewrite); **T220**, **T221**, **T223**, **T224**,
**T225**; **T226** (additionally blocked on T200); **T222** last of all, since oversight over an empty fleet
proves nothing; and **T140**, the full sweep, once the eleven have each been run once.

**Checkpoint**: quickstart Scenario 2 recorded against all ten of its checks, on a stage, with a real draft
pull request at the end of it.

---

## Phase 26: Hygiene, after the merge (Priority: P3)

**Goal**: close the items that are real but small, once the branches have converged.

**Why last**: three of them touch files PR #19 rewrites — `sst.config.ts` in all three deployables,
`packages/sisyphus-infra`, and the scheduler — so doing them before the merge buys conflicts.

- [x] T244 [P] Rescope **T143** to its knip half and close it: `pnpm knip:orphans` exits 0 with an empty
      report and has done since T193. **T143 cannot be satisfied as written** — it also demands cspell clean,
      and T212 establishes that gating cspell is a workspace-wide change that must not ride in on this
      feature. Split the contradiction rather than leaving a task that is unsatisfiable by construction, and
      raise T212's findings as a workspace-level ticket outside this specification
- [x] T245 [P] Fix or delete `scripts/audit-cspell.mjs`. It `JSON.parse`s `cspell.json`, which is JSONC —
      confirmed independently: it throws `Expected double-quoted property name in JSON at position 124`, and
      has done since the config gained its first comment, so it has **never run**. Its file walk also scans
      `*.tsbuildinfo`, counting words kept alive only by build output as live. T212 found both and
      deliberately left them, correctly, as out of its scope — but a fourth check in this repository that
      looks present and measures nothing should not survive on a technicality. Deleting it is an acceptable
      outcome; leaving it as-is is not

**Carried forward**: **T141** (design audit — the human half `design-lint` cannot check), **T142** (full gate
with `--base=main` plus `qlty:diff`, which T193 did not cover), **T202** (bundle id and name on the job
envelope), **T203** (wire `deploy.yml` to `getDeployRoleName` — still absent on PR #19 head), **T204** (panel
query-state coverage; fix it as a **convention**, since PR #19 added a further panel set under
`apps/sisyphus-admin/src/components/admin/credential-groups/` that will inherit the same gap), **T205**
(surface read failures on `/workflows/new`), **T209** (pending supervision command on the read path),
**T211** (the stale `buildControlPlaneTickSpecification` reference, still present in
`apps/sisyphus-control-plane/src/dispatch.ts`), **T212** (out of scope by its own terms; keep as the record).

**Checkpoint**: `pnpm nx affected -t lint typecheck test design-lint --base=main` and `pnpm qlty:diff` green
with no `QLTY_*` override, and no gate in this repository that has never executed.

---

## Phases 20–26: Dependencies & Execution Order

_This section governs the remediation layer only. The table under **Dependencies & Execution Order** below is
the original and is not edited._

| Phase             | Depends on                | Notes                                                                                          |
| ----------------- | ------------------------- | ---------------------------------------------------------------------------------------------- |
| 20 Ledger & docs  | —                         | Hours of editing. Everything below is planned against these documents                          |
| 21 Launch blocker | —                         | One variable. **T213 cannot run before it**                                                    |
| 22 Live defects   | —                         | Independent of everything; both are executor-local                                             |
| 23 Dead stories   | —                         | Shares no file with PR #19; parallel with the merge                                            |
| 24 Gate integrity | —                         | **Do first in wall-clock terms** — hours, and it is what makes every other verdict trustworthy |
| 25 Stage exercise | 20, 21, and T200 for T226 | The only phase with hard predecessors                                                          |
| 26 Hygiene        | PR #19 merged             | Three items collide with it otherwise                                                          |

### Recommended order

**T242 and T215–T217 and T227 first** (Phase 24) — hours, and nothing else you learn is trustworthy until the
gates are proven. **T238 next** (Phase 21) — one variable, and T243 is blocked on it. **Phase 20 in parallel**
with both, by whoever is not writing code. Then **T239 and T197** (Phase 22, the two live defects) and
**T200 → T198 → T196** (Phase 23, the three dead stories) concurrently — different engineers, no shared files.
**T243** when Phases 20 and 21 are done, and the remaining ten recorded runs behind it. **Phase 26** after the
merge.

### Parallel opportunities

- **Phase 20**: T233, T234, T235 are `[P]` with each other; T236 and T237 both edit `quickstart.md` and are
  **not** parallel with each other or with T234
- **Phase 22 and Phase 23 are fully parallel** — the executor's output pipeline and its workflow ports share
  no file, and neither touches the other's tests. This is the largest parallel opportunity in the layer
- **Phase 24 is parallel with everything**, being minutes-to-hours per task
- **Phase 25 is not parallel with itself**: eight of the carried-forward runs are `[P]` only in the sense that
  different engineers can hold different stages, and T222 and T226 are strictly last

---

## Dependencies & Execution Order

### Phase dependencies

| Phase              | Depends on                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Setup            | —                         | T001 (zod pin) blocks everything else                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2 Foundational     | Phase 1                   | Spikes T011–T013 gate Phases 4, 7, 8                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 3 US7+US12+US13    | Phase 2                   | **T038 first** — no admin means no configuration at all                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 4 US1              | Phase 3, T013             | Live output needs the transport spike closed. Carries T041/T042 (after T064), T046 (before T055) and T047 (after T066) — all four need provisioning or existing workflows                                                                                                                                                                                                                                                                                                                                                                                                  |
| 5 US9              | Phase 4                   | Profiles prefill the launch form T064a builds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 6 US11             | Phase 4                   | Notifications need workflows that reach outcomes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 7 US2              | Phase 4, **T011 (S1)**    | Correction injection is what S1 proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 8 US3              | Phase 7, **T012 (S2)**    | Shares `suspend()` with US2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 9 US10             | Phase 4                   | Extends single-entry checkout                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 10 US8             | Phase 5                   | Mappings resolve to profiles, so profiles must exist                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 11 US4             | Phase 10                  | Autonomous runs are integration-fed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 12 US5             | Phase 11                  | Reuses review machinery                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 13 US6             | Phase 6                   | Aggregates over completed runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 14 Polish          | All desired stories       |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 15 Shell & entry   | Phase 3 (roles exist)     | **T146 first** — the auth layer already points at a route that 404s, so this is a break being fixed, not a gap being filled. T149/T150 need the session role from Phase 3                                                                                                                                                                                                                                                                                                                                                                                                  |
| 16 Notify settings | Phase 15, Phase 6         | The screen has nowhere to be reached from until the shell exists; the procedures it calls landed with T086                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 17 Infra re-shape  | Phase 1                   | Independent of 15 and 16 — touches no application code. **T161 before T162–T166**: extract the pure assertions before deleting the tests that hold them                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 18 Assembly        | Phases 3–14 (parts exist) | **Runs before 15, 16 and 17.** T190 first — until CI executes the database suites, no verdict on anything else is trustworthy. Then T172 and T173, the two entry points, which unblock T174–T180. T193 last                                                                                                                                                                                                                                                                                                                                                                |
| 19 Ports           | Phase 18                  | **T194 and T195 first, in parallel** — together they are the whole distance to Scenario 2, and T213 cannot start without both. Then the ports gate the assembly tasks: T194+T195 gate T213, T219, T223, T224 and T225; T194 alone gates T218; T196 gates T214, T220 and T221; T197 gates T219's reclamation step; T198 gates T214, since integration ticks refuse until the redactor is packaged; T200 gates T226. T222 runs last of all — fleet oversight over an empty fleet proves nothing. T215–T217 depend on nothing and should run first of all, being minutes each |

_Phases 12–18 are complete as of 2026-08-07. Phase 19's remaining tasks are the only open work in this feature
other than the four original polish tasks (T140–T143). Phase 19's open range is T194–T198, T200–T205,
T209–T228 — T199, T206, T207 and T208 are checked. Of those, T213, T214 and T218–T226 are the eleven assembly
tasks: one per story, each a recorded run on a stage rather than a CI target, and together the only evidence
this feature will ever have that its thirteen stories work. The phases marked complete above are complete in
their components; their paths are proven by those eleven and by nothing that has run yet._

### Story independence

US7, US12 and US13 are **deliberately not independent** — plan.md ships them as one slice, because registration
without its gate installs client credentials for anyone and an unscoped list leaks across clients. Every other
story is independently testable once its phase dependency is met.

### Parallel opportunities

- **Phase 1**: T002–T007 (six members), then T009–T010
- **Phase 2**: all three spikes T011–T013 concurrently; all eight schema files T017–T024 concurrently
- **Phase 3**: the three stories' UI tasks T039, T043, T048 concurrently once their routers land
- **Phase 4**: T058, T059 (output pipeline) and T072–T074 (design layer) concurrently with backend work. T041,
  T042, T046, T047 and T064a are **not** parallel — each sits behind a named task in the same phase
- **Cross-phase**: Phases 5, 6 and 9 are all independent once Phase 4 lands — three developers, no collisions
- **Phase 15**: T147, T148 concurrently with T146; T151, T153, T154 concurrently once T149 lands. T150 and
  T152 are **not** parallel with each other — T152 moves the routes T150's links point at
- **Phase 17**: T163 and T165 concurrently after T161; T167 and T169 concurrently with anything. T162, T164 and
  T166 are **not** parallel — all three land on the barrel. T168 before T170
- **Phase 15 vs 17**: fully independent, and the largest parallel opportunity left in the plan — one developer
  on the panel, one on infrastructure, no shared file between them
- **Phase 18**: T182, T184, T185, T186, T187, T188, T191, T192 all carry [P] and can run concurrently once the
  entry points land. T172 and T173 are concurrent with each other — different apps — but almost nothing else
  in the phase is, because T174–T180 all wire into one of the two
- **Phase 19**: T215–T217 concurrently with everything, first, being minutes each; T194 and T195 concurrently
  with each other; T196, T197, T200–T205 and T209–T212 all carry [P] and collide with nothing. The assembly
  tasks T218–T221 and T223–T225 carry [P] **only in the sense that different engineers can run them on their
  own stages** — they are eight recorded manual runs, not eight parallel builds, and two engineers cannot share
  one stage for them because Scenario 5's pause and Scenario 10's fleet view both read state the other
  perturbs. **T213, T214, T222 and T226 are not parallel**: T213 is the phase checkpoint and comes first of the
  eleven; T222 needs the history the others leave behind and comes last; T226 needs T213's and T223's workflows
  before its leak test means anything; T214 needs its own Jira project and integration schedule, which is a
  stage configuration the others do not want

---

## Parallel Example: Phase 2 schema

```bash
# All eight schema files touch different files with no interdependencies:
Task: "Schema: identity tables in packages/sisyphus-api/src/db/schema/identity.ts"
Task: "Schema: workflow tables in packages/sisyphus-api/src/db/schema/workflow.ts"
Task: "Schema: bundle tables in packages/sisyphus-api/src/db/schema/bundle.ts"
Task: "Schema: profile tables in packages/sisyphus-api/src/db/schema/profile.ts"
Task: "Schema: integration tables in packages/sisyphus-api/src/db/schema/integration.ts"
Task: "Schema: run-record tables in packages/sisyphus-api/src/db/schema/run-record.ts"
Task: "Schema: supervision tables in packages/sisyphus-api/src/db/schema/supervision.ts"
Task: "Schema: notification tables in packages/sisyphus-api/src/db/schema/notify.ts"
```

---

## Implementation Strategy

### MVP scope

**Phases 1 → 2 → 3 → 4.** That is the smallest thing that is both useful and safe: an engineer launches a run
against a registered bundle, watches it, and gets a draft PR — with roles and scoping already enforced.

Phase 3 cannot be deferred to "after the MVP" even though it looks like administration. Without it there is no
first admin (T038), no bundle to boot from, and no scoping — so the first multi-client run leaks. Note that the
MVP boundary is Phase 4, not Phase 3: the four gates Phase 3 defines but cannot exercise (validation run, setup
redaction, leak test, deactivation) are release gates **of the MVP**, not of a later phase.

**Correction, 2026-08-06 — the MVP is not reached.** Phase 4's tasks are all checked and its components are all
tested, but there is no module that composes them: `apps/sisyphus-executor/src/workflows/` has no delegated
orchestrator, `main.ts` is a 22-line scaffold, and the control plane's declared Lambda handler names a file
that does not exist. The phase checkpoint at line 339 — "A delegated run completes end to end" — has never
been executable, and no task in Phases 1–14 was responsible for making it so. **The MVP boundary is now
Phase 4 + Phase 18's trunk tasks (T172–T178).** This is a genuine gap in the original decomposition, not a
regression: the task list was built story-by-story, each story's components were tasked, and the assembly of
them was tasked nowhere.

**Second correction, 2026-08-07 — the boundary moved once more, and this position is measured rather than
assumed.** Phase 18's trunk landed and the gate is green across 14 projects (5,695 passing). Building it
revealed that some of the parts Phase 4 "completed" are types with no implementation: a delegated run now
composes correctly, halts at dispatch **before the agent starts**, and reports terminal `failed` naming the
missing port.

| Boundary | Contents                                                      | Status                                                |
| -------- | ------------------------------------------------------------- | ----------------------------------------------------- |
| Planned  | Phases 1–4                                                    | Reached on paper; its checkpoint was never executable |
| Revised  | + Phase 18 trunk (T172–T178)                                  | **Reached**, 2026-08-07                               |
| Actual   | + **T194 (`DeveloperPort`) + T195 (`Forge`)**, proven by T213 | Open — these two are the whole distance to Scenario 2 |

Worth stating so the remaining distance is not overestimated: `Forge` is three methods over a host API, and
`DeveloperPort` is one function returning a five-field proposal on top of a frame stream that already works
(spike S1, closed). Everything structurally hard — provisioning, cross-instance snapshot and restore, the
supervision protocol, live log transport, profile-scoped access, spend accounting — is built and tested.

**What is shippable today**: the administration surface. Sign-in, the shell and every screen, roles and
profile-scoped access, setup bundles, workspaces, execution profiles, integration configuration, users, audit,
notification preferences — all database-backed and tested, and the panel builds. What is not shippable is a
run: a launch provisions an instance, bootstraps it, halts at the missing port, reports failed, and tears down
cleanly. Safe, and pointless. Two further caveats belong with any deploy decision: the infrastructure was
rewritten in this feature and **has never been deployed** — per FR-200 its constructs are deploy-verified by
design and carry no unit tests, so the first deploy is the first exercise of that code — and integration ticks
refuse outright until T198.

### Incremental delivery

1. Phases 1–2 → foundation, spikes closed
2. Phase 3 → an admin can register a client's bundle, roles and grants exist **(no runs yet, so nothing to
   validate against and nothing to leak)**
3. Phase 4 → **MVP**: delegated runs, watchable, draft PR
4. Phase 5 → launching stops being an expert activity
5. Phase 6 → nobody has to watch a run to know it needs them
6. Phases 7–8 → supervision and resumability
7. Phases 9–13 → multi-repo, autonomy, oversight

### Risk notes

- **T011 (S1) may fail.** The Agent SDK fallback is pre-chosen, but only survives as a module swap if T035 lands
  first. Sequence it that way.
- **T013 (S3) is the least certain decision in the plan.** `LISTEN/NOTIFY` needs a pinned session, which
  transaction-mode pooling does not give you. Both fallbacks keep the SSE contract, so a failure is a transport
  change rather than a redesign — but find out before Phase 4 depends on it.
- **T031 and T042 are the tests that matter most.** FR-190's rule that out-of-scope returns `NOT_FOUND` rather
  than `FORBIDDEN` is one keystroke from being wrong and silent when it is.

---

## Notes

- Every implementation task carries its colocated `<name>.test.ts` — Constitution III, non-negotiable, enforced
  by the pre-commit hook
- Commit subjects prefixed `BTAI-<n>: ` or `<branch-name>: ` on `feature/sisyphus-workflow-platform`
- All task execution through `pnpm nx`, never the underlying tool
- Stop at any checkpoint to validate the slice independently
