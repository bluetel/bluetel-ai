---
description: 'Task list for Sisyphus — Supervised & Autonomous Agentic Delivery Platform'
---

# Tasks: Sisyphus — Supervised & Autonomous Agentic Delivery Platform

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
      `setEnabled(true)` runs the FR-124 gate — bundle enabled **and** every workspace entry reachable — and
      refuses naming the failing element, which is what stops a profile/bundle mismatch reaching a run.
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
- [ ] T143 [P] Knip and cspell clean — unused exports removed rather than suppressed, unless `knip.json`
      documents why the code is legitimately unreferenced (`knip.json`, `cspell.json`)

---

## Phase 15: Application shell, entry and per-screen states (FR-193..FR-197, FR-201)

_Added 2026-08-06 from the second clarification session. plan.md Phase Sequencing row 12; research.md R17;
quickstart.md Scenario 14. No story label — the shell is cross-cutting over every story that has a screen._

**Goal**: the twelve built screens stop being reachable only by typing a URL, and the route the auth layer
already points at stops returning a 404.

**Independent test**: sign out, request any route, and arrive at a styled sign-in screen; sign in as an engineer
and reach every permitted screen from the sidebar without touching the address bar; sign out from a deep screen.

- [ ] T146 Sign-in screen at `apps/sisyphus-admin/src/app/sign-in/page.tsx` — **do this first, it is a live
      defect**: `apps/sisyphus-admin/src/lib/auth/config.ts:106-110` sets both `pages.signIn` and `pages.error`
      to `/sign-in` and no such route exists, so every unauthenticated visit and every auth failure 404s today.
      One Google provider, so no provider picker; built from `components/ui` primitives, not the framework
      default (FR-195)
- [ ] T147 [P] Auth-error reason mapping in `apps/sisyphus-admin/src/app/sign-in/error-reason.ts` — translate
      the `error` query parameter into a readable cause covering at minimum out-of-domain identity, deactivated
      account and generic provider failure, reusing the existing decision vocabulary in
      `apps/sisyphus-admin/src/lib/auth/sign-in-decision.ts`. A reason MUST NOT disclose whether an account
      exists (FR-195, FR-190)
- [ ] T148 [P] Root route redirect in `apps/sisyphus-admin/src/app/page.tsx`, replacing the current 7-line
      `<h1>Sisyphus</h1>` stub — authenticated to `/workflows`, unauthenticated to `/sign-in` (FR-196)
- [ ] T149 Application shell layout at `apps/sisyphus-admin/src/app/(app)/layout.tsx` — a route group so a new
      screen is inside the shell by existing rather than by remembering to import it. Renders the sidebar and
      top bar around `children` (FR-193, R17)
- [ ] T150 Sidebar in `apps/sisyphus-admin/src/components/shell/sidebar.tsx` with
      `apps/sisyphus-admin/src/components/shell/nav-items.ts` — Workflows, Needs attention, Fleet, plus an Admin
      group (bundles, workspaces, profiles, integrations, users, audit) **filtered out entirely for engineers,
      not rendered disabled**, so the nav never advertises a surface that will answer `NOT_FOUND` (FR-193,
      FR-190). Current section marked by something other than colour alone (FR-201)
- [ ] T151 [P] Top bar in `apps/sisyphus-admin/src/components/shell/top-bar.tsx` — signed-in identity plus a
      sign-out control wired to `signOut`, which is exported at
      `apps/sisyphus-admin/src/lib/auth/index.ts:16` and imported by no component today (FR-194, SC-058)
- [ ] T152 Move `app/workflows/`, `app/admin/` and the new `app/settings/` under `apps/sisyphus-admin/src/app/(app)/`
      so the shell wraps them. Route-group parentheses keep every URL unchanged — verify with the existing
      colocated page tests, which must pass without edits to their asserted paths
- [ ] T153 [P] Root not-found boundary at `apps/sisyphus-admin/src/app/not-found.tsx` — catches the
      `notFound()` that `requireAdminPage()` throws for non-admins, which lands on the framework's unstyled
      default today. Renders inside the shell with a route back, reusing
      `apps/sisyphus-admin/src/components/admin/not-found-card.tsx` (FR-197)
- [ ] T154 [P] Root error boundary at `apps/sisyphus-admin/src/app/error.tsx` — styled, inside the shell, with
      an error code and a next action rather than a dead end (FR-197, FR-031)
- [ ] T155 Per-screen loading, empty and error states across all thirteen screens — a list with zero rows
      renders a stated empty case, a query in flight renders a loading case, a failed query renders the reason
      plus a next action. Walk every `page.tsx` under `apps/sisyphus-admin/src/app/(app)/`; this is the
      criterion T141's "every screen" audit had no way to check (FR-201)
- [ ] T156 Reconcile `apps/sisyphus-admin/src/components/admin/admin-shell.tsx` with the new layout — it
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

- [ ] T157 [US11] Notification settings screen at
      `apps/sisyphus-admin/src/app/(app)/settings/notifications/page.tsx` — reads
      `workflow.notificationPreferences`, already mounted at
      `packages/sisyphus-api/src/server/workflow/router.ts:237` (FR-138)
- [ ] T158 [US11] Preferences panel in
      `apps/sisyphus-admin/src/components/settings/notification-preferences-panel.tsx` — one control per
      notification event, writing through `workflow.setNotificationPreference`. Defaults come from
      `applyPreferenceDefaults` in `packages/sisyphus-api/src/server/workflow/watch.ts:171`, so a user who has
      never opened this screen is still notified about their own runs (FR-138)
- [ ] T159 [P] [US11] Slack identity readout in
      `apps/sisyphus-admin/src/components/settings/slack-identity-readout.tsx` — states plainly when no Slack
      identity resolved and that notifications will not be delivered, rather than the screen silently
      succeeding (FR-140)
- [ ] T160 [US11] Watch / Unwatch control in
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

- [ ] T161 Extract the pure layer first, before anything is rewritten:
      `packages/sisyphus-infra/src/retention.ts` (days and transitions per object class),
      `packages/sisyphus-infra/src/policies.ts` (each policy document's actions, resources and conditions, plus
      the CI identity provider's trusted subject), each with its colocated test. Move the assertions that
      already exist in `buckets.test.ts`, `oidc-provider.test.ts` and `runner-role.test.ts` onto these, so no
      security or retention assertion is lost in the rewrite (FR-200)
- [ ] T162 Rewrite `packages/sisyphus-infra/src/buckets.ts` as `createBuckets(config)` instantiating
      `sst.aws.Bucket` / `aws.s3.*` directly and returning `{ logs, snapshots, bundles, artifacts }`. Delete
      `BucketProvider`, `BucketSpecification(s)` and the `build*Specification` indirection; lifecycle rules come
      from `retention.ts`. Delete `buckets.test.ts` — the construct is deploy-verified (FR-066, FR-200)
- [ ] T163 [P] Rewrite `packages/sisyphus-infra/src/database.ts` as `createDatabase(config)` returning the
      instance and its parameter, deleting `DatabaseProvider` and `DatabaseSpecification` with
      `database.test.ts`
- [ ] T164 Rewrite `packages/sisyphus-infra/src/oidc-provider.ts` as `async createOidcProvider(config)` —
      create in production, `getOpenIdConnectProvider` lookup elsewhere via the Promise API so the absence can
      be caught and rethrown naming the bootstrap step. Rewrite
      `packages/sisyphus-infra/src/runner-role.ts` as `createRunnerRole(config)`. Both take their policy
      documents from `policies.ts`; delete `OidcProviderSurface`, `RunnerRoleProvider` and both construct tests
- [ ] T165 [P] Rewrite `packages/sisyphus-infra/src/scheduler.ts` as `createScheduler(config)` and add
      `packages/sisyphus-infra/src/nextjs-website.ts` as `createNextjsWebsite(config)`, deriving its argument
      types from the construct's own constructor rather than restating them. Delete `SchedulerProvider` and
      `scheduler.test.ts`
- [ ] T166 Retire the structural type layer: delete `SstConfigDefinition`, `SstAppInput` and `SstAppConfig`
      from `packages/sisyphus-infra/src/sst-app.ts`, keeping only the pure removal-policy/protect decision as
      a tested helper so three deployables cannot disagree about teardown. Fold
      `packages/sisyphus-infra/src/stack-scope.ts` into `lib.ts` if it is only naming. Rewrite
      `packages/sisyphus-infra/src/index.ts` — explicit named re-exports, no `export *`, and none of the
      deleted provider types (FR-066, SC-060)
- [ ] T167 [P] Add the `./scripts` subpath to `packages/sisyphus-infra/package.json` and populate
      `packages/sisyphus-infra/src/scripts/` — `deploy-role-name.ts` as the single exported constant both the
      bootstrap role and the CI script build their identifier from, `ci-deploy-utils.ts` (OIDC token,
      assume-role, parameter-store → `process.env` / `.env` file), `get-deployment-environment.ts`, and an
      `index.ts` barrel. Two string literals that agree today are the failure this prevents (FR-200)
- [ ] T168 Split each deployable's deployment config into three, replacing the stage-suffix `if` branch in
      `apps/sisyphus-admin/sst.config.ts` and its siblings: `sst.config.ts` (application stack),
      `sst-bootstrap.config.ts` (parameters, CI identity provider, deploy role), `sst-install.config.ts`
      (no-op, providers only) — for `apps/sisyphus-admin`, `apps/sisyphus-control-plane` and
      `apps/sisyphus-executor`. Configuration is read inside `app()` / `run()`, never at module scope, and every
      import is a dynamic `await import()`; the install config's providers must be pinned to exactly the
      versions the application config declares (FR-199, FR-202, R16)
- [ ] T169 [P] Wire the filtered typecheck: `ignored-error-codes.json` and `loosely-type-checked-files.json` in
      each of `apps/sisyphus-admin`, `apps/sisyphus-control-plane`, `apps/sisyphus-executor` and
      `packages/sisyphus-infra`, with the target changed to `tsc --noEmit | loose-ts-check` in each
      `project.json`. `.sst/**/*.ts` goes in all three of `tsconfig.json` `include`, the loose-glob list, and
      `eslint.config.mjs` `ignores`. `sisyphus-infra`'s ignored set stays narrow — only what its use of the
      ambient globals raises. `sisyphus-api` and `sisyphus-integration-jira` get neither file (FR-198, SC-061)
- [ ] T170 Update each deployable's `project.json` so **every** command naming a stack also names its config
      file — `deploy`, `bootstrap`, `destroy` and `unlock`. A `destroy` that omits it loads the wrong stack's
      configuration and mis-plans the teardown. Add the install config to `postinstall` in each deployable's
      `package.json`, so a fresh clone can typecheck (FR-199)
- [ ] T171 Run quickstart.md Scenario 16 — the clean-clone, no-credentials typecheck, the install/application
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

- [ ] T172 Control-plane Lambda entry point at `apps/sisyphus-control-plane/src/main.ts`, exporting the
      `handler` symbol that `apps/sisyphus-control-plane/sst.config.ts:114` already declares as
      `src/main.handler` and passes to the function at `:225`. **The file does not exist**, so the deployed
      function has no handler to load. It dispatches by event to `jobs/admit-workflow`, `drain-queue`,
      `start-workflow`, `teardown-workflow`, `reconcile`, `integration-tick`, `sync-schedules` and
      `bootstrap-admins` — all built and tested (536 tests), all currently unreachable (FR-203)
- [ ] T173 Executor entry point — replace the 22-line scaffold at `apps/sisyphus-executor/src/main.ts`, whose
      own doc comment says "Bootstrap phases, the agent adapter and report-back land in later tasks". It must
      parse the job envelope, run the bootstrap phases, resolve skills, start the agent, run the output
      pipeline and report back, then suspend or tear down — composing `bootstrap/`, `agent/`, `session/`,
      `output/`, `report/`, `caps/`, `skills/`, `supervision/` and `workflows/`, **none of which it imports
      today** (FR-203)
- [ ] T174 [US1] Delegated-run orchestrator at `apps/sisyphus-executor/src/workflows/delegated.ts` —
      `apps/sisyphus-executor/src/workflows/` has `autonomous.ts` and thirteen siblings but no delegated path,
      so US1, the MVP story, has no module composing it. tasks.md:339 asserts "A delegated run completes end
      to end" as a Phase 4 checkpoint with no task behind it (FR-203)
- [ ] T175 Call the supervision loop from the executor entry point: `watchForInterruption`
      (`apps/sisyphus-executor/src/session/interruption.ts:128`) has no production caller, so the one
      `suspend()` path it guards is unreachable. **Nothing anywhere imports `session/`.** Two source comments
      already record this — `apps/sisyphus-executor/src/supervision/poll.ts:7` and
      `packages/sisyphus-api/src/server/workflow/supervision.ts:29` both read "`suspend()` is fully specified
      and never invoked" (FR-203, FR-054)
- [ ] T176 Start the heartbeat loop from the executor entry point — `report/client.ts` defines `heartbeat` at
      `:101` and no non-test code calls it. Without it, `reconcile.ts`'s heartbeat-lapse detection
      (`HEARTBEAT_LAPSE_MS`, `reconcile.ts:76`) will park every live run (FR-048)
- [ ] T177 [US11] Call `notifyWorkflowEvent` from the state-transition path —
      `apps/sisyphus-control-plane/src/notify/delivery.ts:177` has no production caller, and **no job imports
      `notify/` at all**. T084 and T085 built `slack.ts` and `coalesce.ts`; nothing invokes the delivery entry
      point they serve, so no notification has ever been sent (FR-136, FR-141)
- [ ] T178 [US4] Call `runAutonomousWorkflow` (`apps/sisyphus-executor/src/workflows/autonomous.ts:195`) and
      `runReviewWorkflow` from the executor entry point, selected by workflow type. Both are tested and both
      are reachable only from their barrel and their tests (FR-203)

### Dead schema — a tested producer and a tested consumer with nothing joining them

- [ ] T179 Mount a skill-reference report procedure on the machine router
      (`packages/sisyphus-api/src/server/machine/router.ts`, which mounts twenty procedures and none for
      skills), and bind the executor's `SkillReferenceReporter` callback to it in
      `apps/sisyphus-executor/src/report/client.ts`. `reportSkillReferenceInput`
      (`packages/sisyphus-api/src/schemas/machine.ts:100`) is imported by nothing; the executor computes
      digests and calls `report(...)` at `skills/resolve.ts:253,313,360` into a callback bound to nothing.
      `workflow.skillReferences` reads the table against live Postgres and can only ever return empty, so
      T134 is complete over a table no run will populate (FR-055, Scenario 12)
- [ ] T180 [US4] Make external-action idempotency durable — mount a report procedure for
      `reportExternalActionInput` (`packages/sisyphus-api/src/schemas/machine.ts:145`, imported by nothing) and
      write through the `external_actions` unique index at
      `packages/sisyphus-api/src/db/schema/supervision.ts:151`. Today retry safety is
      `new Map()` at `apps/sisyphus-executor/src/delivery/external-action.ts:152` — per-process, empty after a
      re-provision. The source concedes it at `:138-141` ("the durable half of FR-076 is `external_actions` on
      the machine surface"), and **nothing, including the tests, ever inserts a row**. The spec says the index
      is what guarantees exactly-once; that is currently not true of the implementation (FR-076)

### Requirements with no implementation, or none that meets them

- [ ] T181 Implement the pause idle ceiling — `'on-idle-ceiling'`
      (`apps/sisyphus-executor/src/session/suspend.ts:57`) is a union member whose only consumer is
      `plan.computeRelease === 'immediate'` at `:252`, i.e. it means "don't release" and nothing else. No
      threshold constant, no timer, no `paused_at`, no sweep. Add the threshold, record when a pause began,
      and extend `apps/sisyphus-control-plane/src/jobs/reconcile.ts` to park a run paused past it — its
      `ACTIVE_STATES` already includes `paused` (`:88`) but it only acts on lease loss and heartbeat lapse
      (FR-049, Scenario 5.6)
- [ ] T182 [P] Seed a `paused` workflow in `apps/sisyphus-control-plane/src/jobs/reconcile.test.ts` — `paused`
      is in the fixture's own state union at `:43` and appears in no seed in the file, so that arm of
      `ACTIVE_STATES` is entirely untested
- [ ] T183 Fix FR-104's determinism — `apps/sisyphus-control-plane/src/jobs/integration-store.ts:283-286`
      concedes the requirement is unmet: "the deterministic lowest-`integrations.id` winner holds **when the
      ticks are ordered**; where a higher-id integration claimed first, the claim stands." FR-104 forbids
      exactly that tick-timing dependence. Resolve the winner by the stated rule regardless of tick order, and
      test both branches — `integration-tick.test.ts:575-588` ticks sequentially and would pass if reversed
- [ ] T184 [P] Consume `onParked` / `parkedAttempts` outside `session/` (FR-082) — both are implemented and
      unit-tested in `apps/sisyphus-executor/src/session/park.ts` and `restore.ts`, with **zero hits outside
      that directory**. The continuing heartbeat and the panel's "waiting on storage" state both depend on
      them; the phrase appears in three executor comments and nowhere in `apps/sisyphus-admin/src`
- [ ] T185 [P] Enforce the supervision budget terms as real timeouts —
      `apps/sisyphus-executor/src/supervision/budget.ts:47-70` declares five terms and only `POLL_INTERVAL_MS`
      is wired to anything (`supervision/poll.ts:150`). `PULL_ROUND_TRIP_MS`, `QUIESCE_BUDGET_MS`,
      `SNAPSHOT_BUDGET_MS` and `ACKNOWLEDGE_BUDGET_MS` are passed as a timeout to no operation, so the budget
      is an intention rather than a bound (FR-205, SC-003)

### Tests that pass without asserting the requirement

- [ ] T186 [P] Assert the seven launch values `claimAndStart` copies onto the workflow row
      (`apps/sisyphus-control-plane/src/jobs/integration-store.ts:399-419`) — `workspaceVersionId`,
      `setupBundleVersionId`, `model`, `instanceType`, `purchaseMode`, `turnCap`, `spendCap`. Its colocated
      test asserts only `state`, `initiatedByUserId`, `executionProfileVersionId` and `ticketReference`;
      deleting `turnCap` and `spendCap` from the insert leaves the whole suite green (FR-101)
- [ ] T187 [P] Test FR-125's actual claim — that a pin survives an edit landing **mid-run**. Both existing
      tests (`packages/sisyphus-api/src/server/admin/workspaces.test.ts:331` and `profiles.test.ts:448`) are
      sequential seed-edit-assert and prove append-only versioning, not concurrency. The machinery is already
      in the repo: reuse the `createGate` / `pg_stat_activity` choreography from
      `packages/sisyphus-api/src/server/workflow/start.test.ts:142-155`
- [ ] T188 [P] Test SC-021 — read a completed run back and reconstruct its exact launch configuration. No test
      does this today, and the production read path cannot: `queries.ts:146,194,374` join
      `executionProfiles` (the mutable current row, for its name) and never `executionProfileVersions`, so
      `findProfileVersion` is only ever called with `profile.currentVersionId`. This needs a resolver change,
      not only a test
- [ ] T189 Replace the constant-arithmetic latency tests with measured ones (FR-205) —
      `apps/sisyphus-control-plane/src/notify/coalesce.test.ts:34-49` asserts a function equals the sum of its
      own addends and that `80_000 < 120_000`; `apps/sisyphus-executor/src/supervision/budget.test.ts` does
      the same for the 10-second pause ceiling. Keep the budgets as declared intent, but add at least one test
      per criterion that performs the operation and observes elapsed time (SC-003, SC-034)

### The gate itself

- [ ] T190 **Make CI run the database-backed suites** (FR-204) — `.github/workflows/ci.yml` declares no
      `services:`, no Postgres, and never sets `SISYPHUS_TEST_DATABASE_URL`. Roughly a third of the suite's
      assertions therefore never execute in CI while it reports green, including the exactly-once unique-index
      proof, the branch-lock advisory-lock proof, the iteration `CHECK` constraint, spend scoping and the
      skill-digest readback. Add a Postgres service, set the variable, run migrations, and make the guarded
      suites **fail rather than skip** when the variable is absent **in CI** — skipping locally stays correct
- [ ] T191 [P] Fix the five broken commands in `specs/002-sisyphus-workflow-platform/quickstart.md` (SC-065):
      `sisyphus-control-plane:e2e` (`:185`) and `dev` on `sisyphus-control-plane` (`:38`) name targets that
      project does not have; `sisyphus-executor:spike-stdin` (`:57`), `sisyphus-admin:spike-log-stream`
      (`:70`) and `sisyphus-executor:spike-restore` (`:83`) name targets that exist nowhere — so the entire
      "reproduce the spikes" section is unrunnable. Either add the targets or correct the guide
- [ ] T192 [P] Add a check that fails when a shipped module has no production caller (SC-063) — the condition
      that hid T172–T180. Knip's unused-export detection covers most of it; the residue is symbols a barrel
      re-exports and nothing imports. Anything legitimately unreferenced gets a documented `knip.json` entry,
      never a silent pass
- [ ] T193 Re-run the full gate after this phase — `pnpm nx affected -t lint typecheck test design-lint
--base=main` plus `pnpm qlty:diff`, **with `SISYPHUS_TEST_DATABASE_URL` set**, and record the skipped
      count as zero. The previously reported 4,930-passing figure was measured with the variable set; the
      figure CI produces is not the same number

**Checkpoint**: a delegated run launched from the panel reaches a draft PR on a real instance — quickstart.md
Scenario 2, which has never been executable.

---

## Dependencies & Execution Order

### Phase dependencies

| Phase              | Depends on                | Notes                                                                                                                                                                                                       |
| ------------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Setup            | —                         | T001 (zod pin) blocks everything else                                                                                                                                                                       |
| 2 Foundational     | Phase 1                   | Spikes T011–T013 gate Phases 4, 7, 8                                                                                                                                                                        |
| 3 US7+US12+US13    | Phase 2                   | **T038 first** — no admin means no configuration at all                                                                                                                                                     |
| 4 US1              | Phase 3, T013             | Live output needs the transport spike closed. Carries T041/T042 (after T064), T046 (before T055) and T047 (after T066) — all four need provisioning or existing workflows                                   |
| 5 US9              | Phase 4                   | Profiles prefill the launch form T064a builds                                                                                                                                                               |
| 6 US11             | Phase 4                   | Notifications need workflows that reach outcomes                                                                                                                                                            |
| 7 US2              | Phase 4, **T011 (S1)**    | Correction injection is what S1 proves                                                                                                                                                                      |
| 8 US3              | Phase 7, **T012 (S2)**    | Shares `suspend()` with US2                                                                                                                                                                                 |
| 9 US10             | Phase 4                   | Extends single-entry checkout                                                                                                                                                                               |
| 10 US8             | Phase 5                   | Mappings resolve to profiles, so profiles must exist                                                                                                                                                        |
| 11 US4             | Phase 10                  | Autonomous runs are integration-fed                                                                                                                                                                         |
| 12 US5             | Phase 11                  | Reuses review machinery                                                                                                                                                                                     |
| 13 US6             | Phase 6                   | Aggregates over completed runs                                                                                                                                                                              |
| 14 Polish          | All desired stories       |                                                                                                                                                                                                             |
| 15 Shell & entry   | Phase 3 (roles exist)     | **T146 first** — the auth layer already points at a route that 404s, so this is a break being fixed, not a gap being filled. T149/T150 need the session role from Phase 3                                   |
| 16 Notify settings | Phase 15, Phase 6         | The screen has nowhere to be reached from until the shell exists; the procedures it calls landed with T086                                                                                                  |
| 17 Infra re-shape  | Phase 1                   | Independent of 15 and 16 — touches no application code. **T161 before T162–T166**: extract the pure assertions before deleting the tests that hold them                                                     |
| 18 Assembly        | Phases 3–14 (parts exist) | **Runs before 15, 16 and 17.** T190 first — until CI executes the database suites, no verdict on anything else is trustworthy. Then T172 and T173, the two entry points, which unblock T174–T180. T193 last |

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
