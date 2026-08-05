# Feature Specification: Sisyphus — Supervised & Autonomous Agentic Delivery Platform

**Feature Branch**: `feature/sisyphus-workflow-platform`

**Created**: 2026-08-05

**Status**: Draft

**Input**: User description: a scalable, AI-native delivery platform (codename **Sisyphus**) that runs Claude Code on isolated cloud instances on behalf of Bluetel engineers — supervised delegation of a ticket, a fully autonomous develop→review→integrate loop, and a standalone review workflow — administered and observed through an internal admin panel.

## Overview

Sisyphus turns "remote Claude Code" into a first-class, observable product. An engineer hands a ticket
to a worker that runs in a disposable, isolated instance; they watch it work in the browser, and —
crucially — they can **pause it and correct it mid-flight** the same way they would locally, without
killing the run or losing the conversation.

Every convention that varies by client (branch names, PR etiquette, ticket transitions, review
rubric, integration steps) lives in **skills inside the target repository**, not in Sisyphus. Sisyphus
supplies the harness: provisioning, isolation, session durability, log capture, correction, budget
control, and reporting.

Two configuration constructs keep client onboarding out of the platform's release cycle entirely:

- **Setup profiles** — a named, versioned archive with a `setup.sh` at its root that turns a bare instance
  into a worker able to do one client's work, installing the agent credentials and whatever else that work
  needs. A new client is a new profile, not a deploy.
- **Integrations** — configurable connectors that discover work externally and start workflows for it. Jira
  is the only type implemented; several can run at once, one per board, each with its own credential,
  filters, cron schedule and setup profile.

Together with repository skills, that means the three things that vary per client — conventions,
credentials, and how work arrives — are all configuration rather than code.

The platform is delivered as five workspace projects, all carrying the codename:

| Project                       | Kind    | Role                                                                                                                            |
| ----------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `packages/sisyphus-api`       | package | The one shared contract: database schema, domain types, entire typed API surface + resolvers                                    |
| `packages/sisyphus-infra`     | package | Shared, app-agnostic infrastructure primitives for all Sisyphus deployables                                                     |
| `apps/sisyphus-admin`         | app     | Internet-facing admin panel — auth, workflow list/detail, live log view, pause/correct UI, webhook + executor reporting ingress |
| `apps/sisyphus-control-plane` | app     | Non-network-facing backend job runner — provisions and tears down workflow compute, mints scoped credentials                    |
| `apps/sisyphus-executor`      | app     | The worker that runs on the provisioned instance and drives the Claude Code CLI                                                 |

Existing workspace apps (`kiro-github-worker`, `admin-dashboard`, `dify-kiro-node`, `rockhub`) are
proofs of concept. Sisyphus **takes inspiration from them and supersedes them**; it does not extend
them, and no Sisyphus project may depend on them.

## User Scenarios & Testing _(mandatory)_

**Delivery order is by priority, not by story number.** Stories 7 and 8 were added after the original six
were numbered; in priority terms the order is:

> US7 (P1) → US1 (P1) → US2 (P1) → US3 (P2) → US8 (P2) → US4 (P2) → US5 (P3) → US6 (P3)

US7 comes first because no run can install its credentials without it, and US8 precedes US4 because an
integration is how a labelled ticket reaches the autonomous pipeline.

### User Story 1 - Delegate a ticket without losing ownership (Priority: P1)

An engineer has been assigned a Jira ticket. Rather than doing the work locally, they open the
Sisyphus admin panel, sign in with their Bluetel Google account, and start a **delegated** workflow:
they pick the repository and base branch, choose the Claude model, set the instance size and whether
interruptible capacity is acceptable, set turn and spend caps, and write a prompt describing what they
want done. Sisyphus provisions an isolated instance, the worker clones the repo, installs the
credentials the job needs, and runs Claude Code. The engineer watches the run stream into the panel.
When it finishes, a **draft** pull request exists on a branch and the Jira ticket has **not** moved —
the engineer still owns delivery.

**Why this priority**: This is the smallest slice that delivers the platform's core value — an
engineer offloads work and keeps control. It exercises provisioning, isolation, execution, log
capture, reporting, and auth end to end. Without it, nothing else has a place to run.

**Independent Test**: Start a delegated workflow against a test repository with a trivial prompt
("add a CHANGELOG entry"). Verify: an instance is provisioned and later destroyed; the run's output is
readable in the panel; a draft PR exists on the expected branch; the ticket status is unchanged; the
workflow appears in the workflow list attributed to the signed-in engineer.

**Acceptance Scenarios**:

1. **Given** a signed-in engineer and a repository Sisyphus can reach, **When** they submit a delegated
   workflow with a model, base branch, instance size and prompt, **Then** the workflow appears
   immediately in the list as queued, then provisioning, then running, and the run's output is visible
   while it runs.
2. **Given** a delegated workflow that completed successfully, **When** the engineer opens the workflow
   detail, **Then** they see the resulting pull request link, the final run summary, the full sanitized
   log, elapsed time, turns used, and spend.
3. **Given** a delegated workflow, **When** it completes for any reason (success, failure, cap reached,
   cancellation), **Then** the pull request is created in **draft** state and no ticket transition is
   performed.
4. **Given** a user who is not signed in, **When** they request any workflow page or data, **Then**
   access is denied and no workflow information is disclosed.
5. **Given** a completed workflow, **When** an operator inspects the account afterwards, **Then** no
   compute instance for that workflow remains, and the run's logs and artifacts are retrievable from
   durable storage rather than from the instance.

---

### User Story 2 - Pause and correct a run in flight (Priority: P1)

An engineer watching a run sees Claude Code heading down the wrong path. They press **Pause**. The run
stops advancing but is _not_ terminated: the conversation is intact and the workspace is snapshotted.
The engineer types a correction ("stop refactoring the router — only change the validation helper") and
presses **Send**. The run resumes with that guidance applied, and the correction is recorded in the
run's timeline. If they instead press **Stop**, the run ends cleanly with everything captured.

**Why this priority**: This is the single biggest gap in the current proof-of-concept worker and the
main reason engineers distrust delegated runs. It is co-P1 because supervision without intervention is
just watching money burn.

**Independent Test**: Start a long-running workflow, pause it mid-task, confirm no further output is
produced and the run is marked paused, send a correction, and confirm the subsequent output reflects
the correction and the timeline shows who sent it and when.

**Acceptance Scenarios**:

1. **Given** a running workflow, **When** the engineer pauses it, **Then** within a few seconds the
   workflow shows as paused, output stops advancing, the instance is still alive, and a recoverable
   snapshot of conversation + workspace exists.
2. **Given** a paused workflow, **When** the engineer submits a correction message, **Then** the
   workflow returns to running, the correction is delivered as an additional user turn in the same
   conversation, and no repository state produced before the pause is lost.
3. **Given** a running workflow, **When** the engineer submits a correction _without_ pausing first,
   **Then** the correction is queued and delivered at the next safe point, and the UI states that it is
   pending rather than silently dropping it.
4. **Given** a paused workflow, **When** nobody interacts with it for the configured idle limit,
   **Then** the workflow is snapshotted, marked resumable, its instance is released, and the engineer is
   told it was parked rather than failed.
5. **Given** a workflow being paused, **When** the pause is requested, **Then** the path taken is the
   same path used for an involuntary interruption of the instance.

---

### User Story 3 - Resume a conversation on a fresh instance (Priority: P2)

A run was parked, interrupted by reclaimed interruptible capacity, or deliberately continued the next
day. The engineer opens the parked workflow and presses **Resume** (or starts a new workflow supplying
an existing session reference). A fresh instance is provisioned, the stored conversation and workspace
are restored onto it, and Claude Code continues with its history intact — the model does not start over
and does not "remember" a repository state that no longer exists on disk.

**Why this priority**: Durability is what makes cheap, interruptible capacity usable and what makes a
multi-day ticket possible. It is not required for a first supervised run, so it follows P1.

**Independent Test**: Run a workflow, park it, destroy its instance, resume it, and confirm the model
demonstrably retains earlier context (e.g. it can answer "what file did you change and why?") and the
workspace contains the earlier work.

**Acceptance Scenarios**:

1. **Given** a workflow with a stored session, **When** it is resumed on a new instance, **Then** the
   conversation history is available to the model and the run continues rather than restarting.
2. **Given** a stored session whose last record was written during an abrupt interruption and is
   truncated, **When** the session is restored, **Then** restoration succeeds using all complete records
   and the truncation is logged as a warning, not a failure.
3. **Given** a resumed workflow, **When** the model inspects the repository, **Then** the working tree
   matches the state captured at snapshot time (including uncommitted work in progress), so the model's
   beliefs about the filesystem match reality.
4. **Given** a workflow running on interruptible capacity, **When** the platform receives an
   interruption warning, **Then** the run is snapshotted and marked resumable before capacity is lost,
   and it is presented as resumable rather than failed.
5. **Given** a session stored for a workflow, **When** a different user attempts to resume it, **Then**
   the attempt is refused unless that user is permitted to see the original workflow.

---

### User Story 4 - Autonomous develop → review → integrate loop (Priority: P2)

A ticket enters the autonomous pipeline. Sisyphus reads the target repository's `sisyphus-dev` skill and
follows it to produce the work and open a draft PR, then moves the ticket to review. A review workflow
then evaluates the PR per the repository's `sisyphus-review` skill and leaves feedback. If the review
fails, the ticket goes back to in progress and the loop repeats — to a hard maximum of three
iterations. When the review passes, Sisyphus reads the repository's `sisyphus-integration` skill and
performs the integration steps it defines. Branch names, target branches, merge and promotion etiquette,
and ticket transitions are all defined **in those skills**, never in Sisyphus.

**Why this priority**: This is the scale story — throughput without an engineer in the seat. It composes
P1 and P2 machinery, and it needs their safety rails (caps, correction, durability) to exist first.

**Independent Test**: Point the pipeline at a test repository containing the three skills and a
deliberately under-specified ticket. Confirm the loop runs, iterates on review failure, stops at three
iterations, records each iteration, and never performs a branch or ticket action that isn't described in
a skill.

**Acceptance Scenarios**:

1. **Given** a repository containing a `sisyphus-dev` skill, **When** an autonomous workflow starts,
   **Then** the steps taken (branch naming, commit and PR conventions) match that skill, and a draft PR
   is opened.
2. **Given** a review that fails, **When** the loop continues, **Then** the ticket is returned to the
   in-progress state defined by the skill, the failure feedback is available to the next development
   iteration, and the iteration counter increments.
3. **Given** three completed iterations without a passing review, **When** the third review fails,
   **Then** the pipeline stops, marks the workflow as needing human attention, and states which review
   findings remain unresolved.
4. **Given** a passing review, **When** integration begins, **Then** Sisyphus follows the repository's
   `sisyphus-integration` skill and performs no promotion, merge, or ticket transition that the skill
   does not describe.
5. **Given** a target repository missing one of the required skills, **When** the pipeline reaches the
   step that needs it, **Then** the workflow halts with an explicit "missing skill" outcome naming the
   skill, and takes no fallback action of its own invention.
6. **Given** an autonomous workflow, **When** either its turn cap or its spend cap is reached, **Then**
   the run stops at the cap, the state is snapshotted, and the workflow is reported as capped with the
   consumption figures.

---

### User Story 5 - Standalone review workflow (Priority: P3)

A pull request needs an automated review, independent of who or what wrote it. A review workflow is
triggered; it reads the repository's `sisyphus-review` skill, evaluates the PR as that skill prescribes,
posts its findings to the PR, and — if the skill says a failing review returns the ticket to in
progress — performs exactly that transition.

**Why this priority**: Useful on its own and reusable by Story 4, but it is a subset of that machinery,
so it can land after the loop's development half.

**Independent Test**: Trigger a review workflow against a PR with a known defect and a repository whose
review skill defines a clear pass/fail rubric; confirm findings appear on the PR and the ticket
transition matches the skill.

**Acceptance Scenarios**:

1. **Given** a PR and a repository with a `sisyphus-review` skill, **When** a review workflow runs,
   **Then** its findings are posted to the PR and its pass/fail verdict is recorded on the workflow.
2. **Given** a failing review and a skill that specifies a return transition, **When** the review
   completes, **Then** that transition is performed and recorded in the workflow timeline.
3. **Given** a review workflow, **When** it completes, **Then** it has made no code changes to the PR
   branch.
4. **Given** a review workflow whose target pull request was closed or merged before the run started,
   **When** the run begins, **Then** it exits with a recorded no-op outcome, posting no findings and
   performing no ticket transition.

---

### User Story 6 - Operate and audit the fleet (Priority: P3)

An engineering lead opens the panel to see every current and past workflow: who started it, which
repository and ticket, type, status, elapsed time, turns and spend, and the outcome. They filter by
user, repository, status and type, open any historical run, and read its complete log and timeline long
after its instance is gone.

**Why this priority**: Required for trust, cost control, and post-mortems, but the platform can be
demonstrated without filtering and history views.

**Independent Test**: With a mix of finished workflows from several users, filter by user and by status
and confirm the result set and each workflow's stored log and timeline are complete and attributable.

**Acceptance Scenarios**:

1. **Given** workflows started by several engineers, **When** a lead filters by user, **Then** only that
   user's workflows are listed, with status, type, repository, ticket, duration, turns and spend.
2. **Given** a workflow whose instance was destroyed weeks ago, **When** its detail page is opened,
   **Then** its full sanitized log, timeline (including pauses and corrections), artifacts and outcome
   are still readable.
3. **Given** any workflow, **When** its log is displayed, **Then** it is free of terminal control
   sequences, progress-spinner frames and cursor movement, and remains faithful to the meaningful
   output.

---

### User Story 7 - Register an executor setup profile (Priority: P1)

A platform administrator needs Sisyphus to be able to work on a new client's repository, which requires a
different set of credentials and tooling from the last one. Rather than changing Sisyphus, they build a
setup profile: a gzipped tar archive with a `setup.sh` at its root that installs the agent credentials, the
repository and ticket-tracker credentials, and whatever else that client's work needs. They upload it in the
admin panel, give it a name and description, and enable it. From then on any workflow — started by hand or
by an integration — can name that profile, and the executor unpacks and runs it before the agent starts.

**Why this priority**: This is how any credential reaches an instance at all, so nothing else runs without
it. It is also the mechanism that keeps client onboarding out of the platform's release cycle — a new
client is a new profile, not a deploy.

**Independent Test**: Register a profile whose `setup.sh` writes a recognisable marker file and exports a
credential, start a workflow referencing it, and confirm the marker exists on the instance, the agent
started with the credential available, and the profile and its version are recorded on the workflow.
Then register a profile with a deliberately failing `setup.sh` and confirm the workflow fails at bootstrap
with a profile-setup error and the agent never starts.

**Acceptance Scenarios**:

1. **Given** an authorised administrator, **When** they upload a valid profile archive with a name and
   description, **Then** it is stored privately and encrypted, registered with a content digest and version,
   and appears in the profile list as enabled.
2. **Given** a workflow referencing an enabled profile, **When** the instance bootstraps, **Then** the
   archive is downloaded, verified against its digest, unpacked, and `setup.sh` is run to completion before
   any agent work begins.
3. **Given** a profile whose archive fails digest verification, is missing `setup.sh` at its root, or whose
   `setup.sh` exits non-zero, **When** bootstrap runs, **Then** the workflow fails with an explicit
   profile-setup failure naming the profile and the failing step, and the agent is never started.
4. **Given** a `setup.sh` that echoes a credential to its output, **When** its output is captured, **Then**
   the credential is redacted before it is stored or displayed.
5. **Given** an administrator replacing a registered profile's contents, **When** they upload the new
   archive, **Then** a new version is created rather than the existing one mutated, and a completed workflow
   still reports the exact profile version it ran with.
6. **Given** a profile referenced by an integration or a non-terminal workflow, **When** deletion is
   attempted, **Then** it is refused with the references named, and the administrator is offered disabling
   instead; runs already in flight are unaffected.

---

### User Story 8 - Configure a Jira integration to feed the pipeline (Priority: P2)

A lead wants labelled tickets on a specific Jira board to be picked up automatically. In the admin panel
they create an integration: name it, give it the Jira base URL and an API credential, scope it to a project
prefix, name the label that marks a ticket for autonomous delivery, pick the setup profile and target
repository and branch, set the model and caps the resulting workflows inherit, and give it a cron schedule.
They enable it, and its schedule is registered. On each tick it looks for newly-labelled tickets in scope
and starts one autonomous workflow per ticket. A second board is handled by adding a second integration with
its own credential, profile and schedule — both run side by side.

**Why this priority**: This is the entry point for the autonomous pipeline (US4), and the thing that makes
Sisyphus scale past one engineer starting runs by hand. It is not needed for supervised delegation, so it
follows the P1 slices.

**Independent Test**: Configure an integration against a test board with a short cron, label one in-scope
ticket, and confirm exactly one autonomous workflow starts with the configured profile, repository, branch,
model and caps. Confirm a second tick does not start a duplicate. Add a second integration for a different
board and confirm both operate independently. Break the credential and confirm the runs are recorded as
failing and the integration auto-disables after the threshold.

**Acceptance Scenarios**:

1. **Given** an authorised user, **When** they submit an integration configuration, **Then** it is validated
   — including a connectivity check against Jira — before it can be enabled, and the credential is stored
   encrypted and never rendered back.
2. **Given** an enabled integration, **When** its schedule is created, changed, disabled or the integration
   deleted, **Then** the registered schedule is created, updated or removed to match, so stored
   configuration and registered schedules never diverge.
3. **Given** an in-scope ticket carrying the configured label, **When** the next tick runs, **Then** exactly
   one autonomous workflow starts, using the integration's setup profile, repository, base branch, model and
   caps.
4. **Given** a ticket a workflow has already been started for, **When** later ticks run, **Then** no second
   workflow is started for it, including across a control plane restart.
5. **Given** two enabled integrations whose filters both match one ticket, **When** a tick runs, **Then**
   exactly one workflow is started and the ambiguity is recorded.
6. **Given** a tick still in progress when the next is due, **When** the schedule fires, **Then** the tick is
   skipped or coalesced rather than run concurrently, and the skip is recorded.
7. **Given** a bulk label application across many tickets, **When** a tick runs, **Then** no more workflows
   are started than the integration's per-tick and rolling-period ceilings allow, and the deferred items are
   picked up on later ticks.
8. **Given** Jira is unreachable or the credential is invalid, **When** a tick runs, **Then** the run is
   recorded as failed with the reason, no partial workflow is started, and after the configured number of
   consecutive failures the integration auto-disables with the reason surfaced.
9. **Given** several configured integrations, **When** they are viewed in the panel, **Then** each shows its
   schedule, enabled state, last run outcome, and counts of items examined, matched, started and skipped.

---

### Edge Cases

- **Provisioning fails or capacity is unavailable** — the workflow reports a provisioning failure with
  the reason, retries within a bounded policy, and never leaves an orphaned instance or a workflow stuck
  in "provisioning" indefinitely.
- **Instance vanishes mid-run** (interruption, hardware failure) — the workflow is reconciled from its
  last heartbeat into a resumable or failed state rather than remaining "running" forever.
- **Worker cannot reach the reporting endpoint** — it buffers locally, retries with backoff, and on
  final termination flushes logs to durable storage so the run is never silently lost.
- **Worker's credential expires mid-run** — the credential is renewed or the run parks cleanly; it never
  terminates in a way that discards captured work.
- **Two corrections submitted in quick succession** — both are delivered, in submission order, exactly
  once each.
- **Pause requested at the very moment the run completes** — the completion wins, the pause is recorded
  as not applied, and the UI reflects the final state rather than a stuck "pausing".
- **Resume requested for a session that is missing or unreadable** — the workflow refuses to start rather
  than silently beginning a fresh conversation the user believes is a continuation.
- **Repository checkout path differs between the original and resuming instance** — must not break
  resumption; the workspace location is a platform invariant, not an incidental value.
- **Log volume from a very long run** — capture remains bounded and the panel remains usable (streamed or
  paged), with no truncation of the record in durable storage.
- **Secrets appear in model or tool output** — captured logs are redacted before they are stored or
  displayed.
- **A skill in the target repository is malformed or contradicts itself** — the workflow halts with an
  explicit error naming the skill and step, instead of guessing.
- **A ticket is closed or reassigned while an autonomous loop is mid-iteration** — the loop detects the
  change at its next checkpoint and stops rather than continuing to push work at a dead ticket.
- **Concurrent workflows on the same repository and branch** — detected and either serialised or refused
  with a clear reason, so two runs cannot race the same branch.
- **The same workflow is started twice** (double-clicked button, retried webhook delivery) — at most one
  compute instance is provisioned; the duplicate is coalesced or refused, never given a second instance.
- **Durable storage unreachable at a snapshot boundary** — the run parks and retries rather than advancing
  unsnapshotted, so it can never progress past its last recoverable point.
- **Base branch advances mid-run, making the work stale** — recorded on the workflow, with the decision to
  rebase left to the repository's skills rather than taken by Sisyphus.
- **A retry duplicates an external action** (two PRs, two comments, a double transition) — external actions
  are issued idempotently so a retry cannot produce a duplicate.
- **Setup profile archive is malformed, missing `setup.sh`, or its digest does not match** — bootstrap fails
  explicitly naming the profile and step; the agent is never started and no partial work is attributed.
- **`setup.sh` hangs** — bootstrap is bounded by a timeout, and exceeding it fails the workflow as a
  profile-setup failure rather than holding a paid instance indefinitely.
- **`setup.sh` echoes a credential** — setup output is redacted to the same standard as run output.
- **A profile is disabled or superseded while a run using it is in flight** — the in-flight run is unaffected
  and still reports the exact version it ran with; only new runs see the change.
- **A profile still referenced by an integration or live workflow is deleted** — refused, with the references
  named; disabling is offered instead.
- **The label is applied and then removed before the next tick** — the ticket no longer matches and no
  workflow starts; a workflow already started is unaffected.
- **A bulk label application across a whole board** — per-tick and rolling-period ceilings bound how many
  workflows start, with the remainder picked up on later ticks rather than dropped.
- **Two integrations' filters overlap on one ticket** — exactly one workflow starts and the ambiguity is
  recorded, so overlapping board configurations cannot double-spend.
- **A tick is still running when the next fires** — skipped or coalesced, never run concurrently, and the
  skip recorded.
- **Ticks are missed entirely** (control plane restart, schedule not registered) — the next successful tick
  picks up everything still matching, since matching is by current label state rather than by an event.
- **An integration's credential is revoked or its board deleted** — runs are recorded as failed with the
  reason and the integration auto-disables after the consecutive-failure threshold rather than retrying a
  broken configuration forever.
- **An integration is edited while a tick is mid-flight** — the in-flight tick completes under the
  configuration it started with, and the schedule is re-registered for subsequent ticks.

## Requirements _(mandatory)_

### Functional Requirements

#### Workspace & project structure

- **FR-001**: The platform MUST be delivered as workspace projects whose names all carry the Sisyphus
  codename: `packages/sisyphus-api`, `packages/sisyphus-infra`, `apps/sisyphus-admin`,
  `apps/sisyphus-control-plane`, `apps/sisyphus-executor`, published under the `@bluetel-ai/*` scope.
- **FR-002**: Sisyphus projects MUST NOT depend on the existing proof-of-concept projects
  (`kiro-github-worker`, `admin-dashboard`, `dify-kiro-node`, `rockhub`); shared behaviour MUST be
  reimplemented in `sisyphus-api` or `sisyphus-infra` rather than imported from a POC.
- **FR-003**: Every Sisyphus project MUST be runnable and verifiable in isolation from its own directory,
  MUST own its own lint/test/typecheck configuration, and MUST expose those as workspace-orchestrated
  targets.
- **FR-004**: Every module MUST have a colocated test file, each directory and package MUST expose its
  public surface through a barrel, and consumers MUST import from the barrel rather than internal paths.

#### Shared contract package (`sisyphus-api`)

- **FR-005**: `sisyphus-api` MUST be the single source of truth for the persistence schema, domain types,
  and the complete typed API surface — procedure definitions **and** their implementations.
- **FR-006**: `sisyphus-api` MUST be consumable in three modes from one definition: by the admin panel as
  the server implementation, by the control plane as a direct in-process caller (no network hop), and by
  the executor as a fully type-checked remote client that imports the types rather than restating them.
- **FR-007**: The API surface MUST be organised into distinct capability groups — at minimum workflow
  lifecycle, run reporting (log and event ingestion), pause/correction control, session snapshot
  registration, and administration/query — each independently authorised.
- **FR-008**: Every procedure MUST validate its inputs against a declared schema and MUST surface
  validation failures in a machine-readable form the calling surface can render field-by-field.
- **FR-009**: `sisyphus-api` MUST expose the enumerations defining workflow state, workflow type and
  terminal outcome, and all three applications MUST derive their behaviour from those enumerations
  rather than redeclaring string literals.
- **FR-010**: Schema changes MUST be applied through versioned, forward-only migrations runnable
  independently of an application deployment.

#### Admin panel (`sisyphus-admin`)

- **FR-011**: The panel MUST authenticate users via Google OAuth and MUST restrict access to identities
  in the Bluetel-controlled workspace domain; unauthenticated and out-of-domain requests MUST be denied
  without disclosing workflow data.
- **FR-012**: The panel MUST list all current and past workflows with, per row: initiating user or
  originating integration, workflow type, status, repository, base branch, ticket reference, model, setup
  profile, start time, duration, turns consumed, spend, and outcome.
- **FR-013**: The panel MUST support filtering the workflow list by initiating user, originating
  integration, status, type, repository and setup profile, and MUST remain responsive at the platform's
  target workflow history volume.
- **FR-014**: The panel MUST provide a workflow detail view showing the live or archived log, a timeline
  of lifecycle events (provisioned, started, paused, corrected, resumed, capped, completed), the
  resulting pull request and ticket links, artifacts, and consumption figures.
- **FR-015**: The panel MUST expose Pause, Resume, Stop and Send-correction controls on a workflow, each
  visible only when valid for the workflow's current state, and MUST reflect the resulting state
  transition without requiring a manual reload.
- **FR-016**: The panel MUST provide a start-workflow form capturing: repository, base branch, workflow
  type, model, prompt, instance size, interruptible-capacity preference, turn cap, spend cap, the **setup
  profile** to bootstrap with, and an optional session reference to resume. Only enabled profiles MUST be
  selectable.
- **FR-017**: The panel MUST expose an ingress for external event delivery (ticket-tracker and
  repository-host events) and for executor reporting, authenticating each independently of the human
  session — external events by verified provider signature, executor reporting by its scoped credential.
- **FR-018**: The panel MUST reject an executor report whose credential does not match the workflow it
  claims to be reporting for.
- **FR-019**: All log output rendered in the panel MUST be sanitized of terminal control sequences,
  progress-animation frames and cursor manipulation, and MUST have secrets redacted, while preserving
  the meaningful content and its ordering.

#### Design system (`sisyphus-admin`)

- **FR-020**: The panel's visual system MUST be recorded in an app-level `DESIGN.md` conforming to the
  DESIGN.md format (`version: alpha`), with front matter declaring `colors`, `typography`, `spacing`,
  `rounded` and `components`, and body sections appearing **at most once each, in this order**:
  Overview · Colors · Typography · Layout · Elevation & Depth · Shapes · Components · Do's and Don'ts. A
  deliberately absent section MUST be declared in `omitted:` with a reason, never left as an empty
  heading.
- **FR-021**: `DESIGN.md` MUST be the precedence root for visual decisions: `DESIGN.md` → global
  stylesheet/theme tokens → components. A literal colour, font size or radius in a component is a defect;
  a design need with no token MUST be satisfied by adding the token to `DESIGN.md` first, then consuming
  it.
- **FR-022**: A `design-lint` target MUST validate `DESIGN.md` on every change to it or to the tokens
  derived from it, MUST be part of the affected-project verification set, and MUST pass with zero errors.
  A residual warning is acceptable only where the document's own prose explains it. The linter MUST be a
  pinned dependency of the app, never resolved outside the lockfile.
- **FR-023**: The design system MUST implement the "instrumentation, not intelligence" direction —
  hairline rules, monospace machine readouts, status indicators and measured type, borrowed from
  engineering instrument panels — and MUST NOT use the generic AI register of gradient fills, glows, orbs
  or hover-lift shadows. Every interactive element MUST report its own state.
- **FR-024**: The palette MUST be one brand colour plus three state-locked machine colours, defined for
  both a light ("sheet") and a dark ("ink") theme:

  | Token                      | Light                                       | Dark                                              | Meaning                                                                         |
  | -------------------------- | ------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------- |
  | `signal`                   | `#1B4FE0`                                   | `#5C86FF`                                         | Every action, link and focus ring. The only decorative use of colour permitted. |
  | `signal-deep`              | `#14369C`                                   | `#3A64E8`                                         | Pressed / active signal                                                         |
  | `signal-wash`              | `rgba(27,79,224,.08)`                       | `rgba(92,134,255,.13)`                            | Selected and highlighted rows                                                   |
  | `ink`                      | `#0B1015`                                   | `#E7EAE6`                                         | Text; blue-green undertone, never pure black                                    |
  | `graphite`                 | `#4E5A63`                                   | `#8B99A2`                                         | Secondary text and metadata                                                     |
  | `sheet`                    | `#F1F2EE`                                   | `#0B1015`                                         | Page base — a cool paper grey, deliberately not warm cream                      |
  | `paper` / `paper-2`        | `#FFFFFF` / `#FAFAF8`                       | `#141B21` / `#101720`                             | Card and inset surfaces                                                         |
  | `hairline` / `hairline-hi` | `rgba(11,16,21,.14)` / `rgba(11,16,21,.30)` | `rgba(231,234,230,.14)` / `rgba(231,234,230,.32)` | Structure — borders do the work shadows would                                   |
  | `amber`                    | `#B4700F`                                   | `#E0A03C`                                         | **In flight** — running, validating, pending review                             |
  | `verdigris`                | `#1F6E63`                                   | `#4FB3A2`                                         | **Passed** — healthy, deployed. Muted, never celebratory                        |
  | `rust`                     | `#A83A22`                                   | `#E0715A`                                         | **Failed / destructive** — earthy, so failure reads as fact not alarm           |

- **FR-025**: `amber`, `verdigris` and `rust` MUST only ever report machine state. Using a state colour
  decoratively is a defect. Colour MUST always mean something.
- **FR-026**: Typography MUST enforce a two-family split as a rule, not a texture: a humanist sans
  (Archivo) for anything a **person** wrote, and a monospace face (IBM Plex Mono) for anything a
  **machine** produced. Uppercase monospace with wide tracking (~.11em) is reserved for labels, eyebrows,
  metadata, table headers and state readouts. Buttons MUST stay sentence-case in the sans face. Body copy
  MUST be set around 15px/1.55 with a comfortable measure (~52 characters).
- **FR-027**: Radii MUST descend from container to instrument: floating surfaces `10px`, containers `6px`,
  data elements and fields `3px`. Nothing MUST be a full pill; the roundest element in the system is a
  radio control.
- **FR-028**: Surfaces MUST be border-led, not shadow-led: a card is a 1px hairline plus a tinted header
  strip. Exactly **one** elevation step MUST exist, reserved for temporarily floating things (menus,
  popovers, modals), so elevation continues to mean "transient".
- **FR-029**: Buttons MUST use a tactile inset bottom shade that compresses on press (a panel-key feel),
  with one primary action per view and a defined hierarchy of primary, secondary, quiet, link and danger.
  An in-flight action MUST replace its label with a live readout rather than showing a spinner.
- **FR-030**: The system MUST include a reusable **state chip** — a small square status indicator plus a
  monospace readout — used consistently everywhere state is displayed (idle, queued, running, paused,
  passed, failed, capped).
- **FR-031**: Fields MUST place a monospace label above a hairline-bordered input, and every error MUST
  carry a code **and** a next action rather than a dead-end message.
- **FR-032**: Motion MUST be restrained and purposeful: ~160ms on state change, ~60ms on press, one
  looping pulse that only ever means "working", a single shared easing curve, and a 2px offset focus ring
  in the brand colour. Under a reduced-motion preference the pulse MUST stop while colour meaning is
  retained. There MUST be no scroll-triggered reveals or ambient animation.
- **FR-033**: All UI MUST be built from a single shared primitive component library (shadcn-style
  primitives) with class names composed through the shared class-merge utility. A hand-rolled or
  duplicated variant of a primitive that already exists (buttons, inputs, dialogs, tables, badges) is a
  defect.
- **FR-034**: Every colour pairing used for text MUST meet WCAG AA contrast in both themes; a contrast
  finding MUST be fixed at the token, never by relaxing the check.

#### Backend control plane (`sisyphus-control-plane`)

- **FR-035**: The control plane MUST NOT be reachable from the public internet, MUST expose no inbound
  network surface for external callers, and MUST be the only component permitted to provision or destroy
  workflow compute.
- **FR-036**: On workflow start the control plane MUST provision an isolated compute instance sized and
  priced per the job specification (instance class, and interruptible vs reserved capacity), bootstrap the
  executor onto it, and hand it everything it needs to identify itself — leaving the substantive work to
  the executor.
- **FR-037**: The control plane MUST mint a **short-lived, workflow-scoped** credential per workflow,
  authorising only the reporting and control operations for that one workflow, and MUST NOT issue any
  long-lived or broadly-scoped credential to an executor.
- **FR-038**: On workflow completion the control plane MUST confirm logs and artifacts are persisted to
  durable storage and the workflow's terminal state is recorded, and only then destroy the instance and
  revoke its credential.
- **FR-039**: The control plane MUST reconcile reality against recorded state on a schedule: any instance
  whose workflow is terminal MUST be destroyed, and any workflow whose instance is gone or whose heartbeat
  has lapsed beyond the threshold MUST be moved to a resumable or failed state with the reason recorded.
- **FR-040**: The control plane MUST enforce a configurable ceiling on concurrently running workflows and
  MUST queue beyond it rather than provisioning unbounded compute.
- **FR-041**: The control plane MUST record, per workflow, the compute cost basis (instance class,
  capacity type, lifetime) alongside model consumption figures, so total run cost is attributable.

#### Workflow executor (`sisyphus-executor`)

- **FR-042**: The executor MUST run on a dedicated, isolated instance per workflow, MUST support only the
  Claude Code agent, and MUST NOT contain multi-agent routing, agent registries, tunnelling, or inbound
  webhook handling.
- **FR-043**: The executor MUST provision its own runtime prerequisites on the instance — the agent CLI, its
  credentials, repository access, and the third-party credentials the job needs (e.g. ticket tracker,
  repository host) — by running the **setup profile** its job references at bootstrap, never baking them into
  a machine image and never writing them to the log.
- **FR-044**: The executor MUST run the agent in a non-interactive streaming mode that (a) emits
  structured events it can parse and (b) accepts additional user turns on its input stream while the agent
  is working, so a correction can be injected **without terminating and relaunching the agent**.
- **FR-045**: The executor MUST sanitize captured output — stripping terminal control sequences, spinner
  and progress frames, and cursor movement — before reporting or persisting it, while preserving the
  meaningful content and its ordering.
- **FR-046**: The executor MUST stream sanitized output and lifecycle events to the reporting API in near
  real time, and MUST also persist the complete log to durable object storage partitioned per workflow, so
  the record survives instance destruction.
- **FR-047**: The executor MUST buffer and retry reporting with backoff when the API is unreachable, and
  MUST flush everything it holds to durable storage before terminating for any reason.
- **FR-048**: The executor MUST send a heartbeat at a defined interval carrying its current state, so a
  lapsed heartbeat is detectable as an interruption.
- **FR-049**: **Pause** MUST suspend the relaying of work to the agent, capture a snapshot, and hold the
  process alive without terminating it. **Stop** MUST end the run cleanly after capturing everything.
  **Correction** MUST be delivered as an additional user turn in the same conversation, exactly once, in
  submission order.
- **FR-050**: At the end of every session — and on pause, on stop, and on interruption warning — the
  executor MUST persist a snapshot to durable storage comprising **both** the agent's conversation state
  **and** the workspace state (including uncommitted work in progress), and MUST register the snapshot's
  reference against the workflow so it can be resumed.
- **FR-051**: The workflow's workspace location MUST be a fixed platform invariant, identical on every
  instance, and the agent's entire state tree MUST live inside the snapshotted workspace — so a snapshot
  restored onto a fresh instance resolves correctly rather than depending on the original instance's paths.
- **FR-052**: The workflow's session identifier MUST be assigned by the platform before the agent starts,
  not discovered by parsing agent output, so a workflow's session is addressable even if the run fails
  before producing output.
- **FR-053**: Given a session reference at startup, the executor MUST restore that snapshot onto the
  instance and continue the existing conversation. Restoration MUST tolerate an incomplete trailing record
  in an append-only session log, using all complete records and logging the truncation as a warning.
- **FR-054**: The executor MUST treat an involuntary capacity-interruption warning as identical to a
  pause — snapshot, persist, register, mark resumable — via the same code path, not a separate one.
- **FR-055**: The executor MUST enforce the job's turn cap and spend cap, MUST stop at whichever is
  reached first, and MUST report the terminal reason as "capped" together with the consumption figures.
- **FR-056**: The executor MUST report every state transition and terminal outcome to the reporting API,
  and MUST never exit leaving the workflow's recorded state as "running".

#### Skill-driven conventions

- **FR-057**: All client- and repository-specific delivery convention — branch naming, target branches,
  promotion and merge etiquette, PR content and readiness, ticket state transitions, review rubric,
  integration steps — MUST be read from **skills in the target repository** (`sisyphus-dev`,
  `sisyphus-review`, `sisyphus-integration`) and MUST NOT be hardcoded in any Sisyphus project.
- **FR-058**: When a required skill is absent, unreadable, or self-contradictory at the point it is
  needed, the workflow MUST halt with an explicit outcome naming the skill and the step, and MUST NOT
  substitute a default of its own.
- **FR-059**: The skill documents actually resolved for a run — and their content version — MUST be
  recorded on the workflow, so a past run's behaviour is explainable after the skills change.

#### Workflow types & lifecycle

- **FR-060**: A **delegated** workflow MUST leave delivery ownership with the initiating engineer: the
  pull request MUST be opened as a draft unless the request explicitly says otherwise, and **no** ticket
  transition MUST be performed.
- **FR-061**: An **autonomous** workflow MUST follow: develop per `sisyphus-dev` → open draft PR → move
  ticket to review → review per `sisyphus-review` → on failure post feedback and return the ticket to in
  progress → repeat, to a **hard maximum of three** development iterations → on a passing review, follow
  `sisyphus-integration`.
- **FR-062**: An autonomous workflow that exhausts its three iterations without a passing review MUST
  stop, be marked as needing human attention, and surface the unresolved review findings.
- **FR-063**: A **review** workflow MUST evaluate a pull request per `sisyphus-review`, post its findings
  to the pull request, record its verdict, perform only the ticket transition the skill prescribes, and
  make no code changes.
- **FR-064**: Every workflow MUST reach exactly one recorded terminal outcome from a closed set
  (succeeded, failed, capped, cancelled, needs-attention, parked-resumable), and every state transition
  MUST be timestamped and attributed to the actor (user, executor, control plane, or reconciler) that
  caused it.
- **FR-065**: A workflow MUST record its ticket reference, repository, base branch, resulting branch, pull
  request, model, caps, consumption, initiating user, and — for autonomous runs — each iteration with its
  review verdict.
- **FR-074**: An autonomous workflow MUST be startable manually from the panel, and MUST additionally be
  started when a **configured label is present on a ticket** that an enabled integration matches on its
  next scheduled poll. Ticket creation alone MUST NOT start a workflow — a human applying the label is the
  opt-in, and it is what bounds unattended spend.

#### Infrastructure & delivery

- **FR-066**: All Sisyphus infrastructure MUST be defined as code and composed from shared, app-agnostic
  primitives in `sisyphus-infra` rather than duplicated per app — including the deployed web application,
  object storage buckets, the CI identity-federation provider, and the deploy role.
- **FR-067**: Deployments MUST be per-stage, with resource identifiers derived from the stage so stages
  are fully isolated within an account, and MUST be triggerable only from the protected integration
  branches — never from a feature branch or a hand-run deploy target.
- **FR-068**: CI MUST authenticate to the cloud provider by short-lived federated identity from the
  pipeline — no long-lived cloud access keys in CI configuration — and the identity provider MUST be
  created once by the production bootstrap and looked up by every other stage, failing with an explicit
  message naming the bootstrap step when it is absent.
- **FR-069**: The delivery pipeline MUST run on CircleCI, MUST verify only the affected projects (lint,
  typecheck, test, design-lint) on a pull request, and both the code-health gate and the affected-project
  gate MUST be green before merge.
- **FR-070**: Deployment of a stage MUST require an explicit human approval step that records who
  approved, which commit, and which stage.
- **FR-071**: Object storage for logs, session snapshots and artifacts MUST be private, encrypted,
  partitioned per workflow, and MUST carry a lifecycle policy expiring each class of object on a defined
  retention schedule.
- **FR-072**: Every credential the platform holds MUST be obtained at runtime, MUST be scoped to the least
  privilege its purpose needs, and MUST NOT appear in logs, snapshots, integration run records, or
  infrastructure state in plain text. Two paths exist and MUST NOT be conflated: credentials the **platform
  itself** uses (integration credentials for discovering work, cloud and database credentials) come from the
  managed secret store; credentials an **executor** uses to do the work come from the setup profile its job
  references (FR-075, FR-083).
- **FR-075**: The agent and every other integration credential MUST be delivered to the executor by the
  **setup profile** the job references (see _Executor setup profiles_ below), never baked into a machine
  image, never committed, and never held as a platform-wide constant. A credential installed by a profile
  MUST NOT be shared with the target repository's own automation.

#### Boundary with existing tooling

- **FR-073**: Sisyphus MUST be scoped to developer-facing, repository-bearing automation. Non-developer
  internal workflows where a non-engineer iterates on prompts (support triage, document QA, retrieval over
  internal knowledge) MUST remain out of scope and stay on the existing low-code workflow tooling. A
  capability request that would move that audience into Sisyphus MUST be specified as a separate product
  rather than absorbed.

#### Executor setup profiles

A **setup profile** is the unit that turns a bare instance into a worker able to do a specific client's
work. It exists so that onboarding a new client, or changing which credentials a run gets, is a
configuration change rather than a platform change.

- **FR-083**: A setup profile MUST be stored as a single **gzipped tar archive** in private object storage,
  with an executable **`setup.sh` at the archive root** as its entry point. The archive MAY contain any
  supporting files that script needs.
- **FR-084**: Setup profile archives MUST be stored encrypted, MUST NOT be publicly reachable, and MUST be
  readable only by the control plane and by an executor presenting a workflow-scoped credential whose
  workflow references that profile.
- **FR-085**: Each profile MUST be registered as a record in the platform database carrying at least: a
  human-readable name, a description, the archive's storage reference, its version or content digest, who
  registered it, when, and whether it is enabled.
- **FR-086**: The admin panel MUST allow an authorised user to register a new profile, upload or replace its
  archive, edit its metadata, enable and disable it, and see which workflows and integrations reference it.
- **FR-087**: On bootstrap the executor MUST download the profile its job references, verify the archive
  against the registered digest, unpack it, and execute `setup.sh` to completion **before** any agent work
  begins.
- **FR-088**: A profile whose archive is missing, fails digest verification, lacks an executable `setup.sh`
  at its root, or whose `setup.sh` exits non-zero MUST fail the workflow during bootstrap with an explicit
  profile-setup failure naming the profile and the failing step. The agent MUST NOT be started.
- **FR-089**: Output produced while running `setup.sh` MUST be captured and redacted to the same standard as
  run output, so a profile that echoes a credential cannot leak it into the log.
- **FR-090**: Profile archives MUST be immutable once registered: replacing a profile's contents MUST create
  a new version rather than mutate the existing one, so a historical workflow's setup remains
  reconstructable.
- **FR-091**: Every workflow MUST record which setup profile and which profile version it ran with.
- **FR-092**: A profile that is referenced by any integration or non-terminal workflow MUST NOT be deletable;
  it MUST be disabled instead, and disabling MUST NOT affect runs already in flight.
- **FR-093**: Whether a per-workflow **spend cap is enforceable** depends on the credential the profile
  installs. A profile installing a metered, per-token credential MUST support the caps in FR-055; a profile
  installing a flat-rate seat credential MUST declare that spend caps are not enforceable under it, and the
  panel MUST show that limitation wherever a cap is set for a job using that profile.

#### Integrations

An **integration** is a configurable connector that discovers work in an external system and starts
workflows for it. Several may be configured and enabled at once — one per Jira board, for example — each
with its own credentials, filters, schedule and setup profile.

- **FR-094**: The platform MUST support multiple independently-configured integrations existing and running
  concurrently, each with its own configuration, schedule and enabled state.
- **FR-095**: **Jira is the only integration type implemented** by this feature. The construct MUST be
  extensible to further types without reworking the integration model, but no second type is in scope.
- **FR-096**: A Jira integration's configuration MUST capture at least: a name, the Jira base URL, its API
  credential, the project key or prefix to scope to, the **label that marks a ticket for autonomous
  delivery**, any additional filtering criteria (e.g. status or issue type), the **executor setup profile**
  workflows it starts will use, the target repository and base branch, the model and caps those workflows
  inherit, its **schedule expressed as a cron expression**, and whether it is enabled.
- **FR-097**: The admin panel MUST allow an authorised user to create, edit, enable, disable, delete and
  manually trigger an integration, and MUST validate its configuration — including a connectivity check
  against the external system — before it is enabled.
- **FR-098**: An integration's credential MUST be stored encrypted, MUST be write-only from the panel's
  perspective (never rendered back after saving), and MUST NOT appear in logs or integration run records.
- **FR-099**: Integration schedules MUST run on the **backend control plane**, not on the network-facing
  panel and not on an executor instance.
- **FR-100**: Schedules MUST be registered from the stored configuration, and MUST be **re-registered
  whenever an integration's schedule or enabled state changes** — created on enable, updated on change,
  removed on disable or delete — so the registered schedules and the database never diverge.
- **FR-101**: On a scheduled tick an integration MUST query the external system for items matching its
  filters, and MUST start one workflow per newly-matched item using its configured setup profile,
  repository, branch, model and caps.
- **FR-102**: An integration MUST NOT start a second workflow for an item it has already started one for,
  even across restarts or overlapping ticks. Each item MUST be claimed exactly once.
- **FR-103**: If a scheduled run is still in progress when the next tick is due, the tick MUST be skipped or
  coalesced rather than run concurrently, and the skip MUST be recorded.
- **FR-104**: Where two enabled integrations match the same item, exactly one workflow MUST be started and
  the ambiguity MUST be recorded, so overlapping board configurations cannot double-spend.
- **FR-105**: Each integration run MUST be recorded with its start and end time, the trigger (scheduled or
  manual), how many items were examined, matched, started and skipped, and any error — and that history MUST
  be visible in the panel so a silently-failing connector is detectable.
- **FR-106**: An integration MUST record consecutive failures and MUST auto-disable itself after a
  configurable threshold, surfacing the reason, rather than retrying a broken configuration indefinitely.
- **FR-107**: An integration MUST enforce a configurable ceiling on how many workflows it may start per tick
  and per rolling period, so a bulk label application cannot provision unbounded paid compute.
- **FR-108**: An external system being unreachable on a tick MUST be recorded as a failed integration run and
  retried on the next tick; it MUST NOT start partial workflows or lose an item that still matches.

#### External system interactions & idempotency

- **FR-076**: Every action the platform takes against an external system (pull request opened, comment
  posted, ticket transitioned, branch pushed) MUST be recorded on the workflow with its kind, target
  reference, result and attempt count, and MUST be retried under a bounded backoff policy on transient
  failure. On retry exhaustion the workflow MUST halt with the pending action recorded, and MUST NOT
  leave a multi-step action half-applied.
- **FR-077**: Where an external action can be repeated by a retry (opening a pull request, posting a
  comment, transitioning a ticket), it MUST be issued idempotently so a retry cannot produce a duplicate.
- **FR-078**: Starting the same workflow more than once concurrently MUST provision at most one compute
  instance; the duplicate request MUST be rejected or coalesced, never satisfied with a second instance.
- **FR-079**: If the base branch advances during a run such that the work in progress is stale, the
  staleness MUST be recorded on the workflow, and whether to rebase MUST be decided by the repository's
  skills rather than by Sisyphus.
- **FR-080**: A review workflow whose target pull request has been closed or merged before the run starts
  MUST exit with a recorded no-op outcome, posting no comments and performing no ticket transition.
- **FR-081**: A pause, resume, correction or stop request against a workflow already in a terminal state
  MUST be refused with an explicit already-finished response and recorded as requested-but-not-applied.
- **FR-082**: If durable storage is unreachable at a snapshot boundary, the run MUST park and retry rather
  than continue unsnapshotted, so no work advances beyond the last recoverable point.

### Key Entities

- **Workflow** — one run of a job. Carries type (delegated · autonomous · review), state, initiating user or
  originating integration, repository, base branch, ticket reference, model, caps, resulting branch and pull
  request, consumption (turns, spend, compute cost basis), terminal outcome, the skill versions it resolved,
  and the setup profile and profile version it ran with.
- **Job Specification** — the immutable input to a workflow: prompt, model, repository and branch,
  instance class, interruptible-capacity preference, turn cap, spend cap, the **setup profile reference**
  that supplies its credentials and tooling, and an optional session reference to resume.
- **Session Snapshot** — a durable capture of one point in a workflow's life: the agent's conversation
  state plus the workspace state, addressable by a platform-assigned session identifier, restorable onto
  any fresh instance.
- **Correction** — an operator-authored additional user turn: text, author, submitted-at, delivered-at,
  delivery status. Ordered within a workflow.
- **Workflow Event** — one timestamped, attributed entry in a workflow's timeline (provisioned, started,
  paused, corrected, resumed, snapshot-registered, interrupted, capped, completed).
- **Log Segment** — an ordered, sanitized, redacted slice of run output, streamable to the panel and
  concatenable into the complete durable record.
- **Iteration** — for autonomous workflows: sequence number, development run, review run, verdict, and the
  findings carried forward.
- **Review Finding** — one issue raised by a review run: location, severity, description, and whether it
  was resolved in a later iteration.
- **Compute Lease** — the provisioned instance backing a workflow: identifier, class, capacity type,
  lifecycle timestamps, last heartbeat.
- **Scoped Credential** — a short-lived credential bound to exactly one workflow and one set of
  operations, with issue and revocation times recorded.
- **User** — an authenticated Bluetel identity: directory identity, display name, role, and the workflows
  attributed to them.
- **Skill Reference** — the identity and resolved content version of a `sisyphus-*` skill used by a run.
- **Setup Profile** — a named, versioned, immutable bootstrap bundle: a gzipped tar archive with an
  executable `setup.sh` at its root, held in private encrypted storage. Carries name, description, storage
  reference, content digest, version, registering user, registration time, enabled state, whether the
  credential it installs makes spend caps enforceable, and the workflows and integrations referencing it.
- **Integration** — a configurable connector that discovers work externally and starts workflows for it.
  Carries type (Jira for now), name, base URL, encrypted credential, project prefix, the label marking a
  ticket for autonomous delivery, additional filters, the setup profile and target repository and branch to
  use, the model and caps started workflows inherit, a cron schedule, enabled state, and consecutive-failure
  count. Several may be enabled at once.
- **Integration Run** — one execution of an integration's schedule: start and end time, trigger (scheduled
  or manual), counts of items examined, matched, started and skipped, the workflows it started, and any
  error. The history that makes a silently-failing connector detectable.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: An engineer can go from opening the panel to a running delegated workflow in under 2
  minutes, entering no more than one screen of job details.
- **SC-002**: Run output becomes visible in the panel within 5 seconds of the agent producing it, for at
  least 95% of output, throughout a run.
- **SC-003**: A pause takes effect within 10 seconds of the request in at least 99% of attempts, and in no
  case terminates the run or loses work already produced.
- **SC-004**: A correction is reflected in the agent's subsequent behaviour without the conversation being
  restarted, in 100% of successful deliveries; no correction is ever silently dropped.
- **SC-005**: A workflow resumed on a fresh instance retains its earlier conversation and workspace state
  in at least 99% of resume attempts, and a truncated trailing session record never causes a resume to
  fail.
- **SC-006**: 100% of workflows reach exactly one recorded terminal outcome; no workflow remains in a
  non-terminal state longer than the reconciliation threshold.
- **SC-007**: No compute instance survives its workflow's terminal state by more than 10 minutes, verified
  by reconciliation reporting zero orphans over a 30-day window.
- **SC-008**: An interrupted run on interruptible capacity is recoverable — not failed — in at least 95% of
  interruptions, with the work produced before the interruption intact.
- **SC-009**: Delegated workflows perform zero unrequested ticket transitions and open zero non-draft pull
  requests, measured across all runs.
- **SC-010**: Autonomous workflows never exceed three development iterations, and 100% of capped or
  exhausted runs report their consumption figures and the unresolved findings that stopped them.
- **SC-011**: Every workflow's spend is attributable to a user, repository and ticket, and total platform
  spend for any period can be produced without inspecting cloud provider billing directly.
- **SC-012**: A workflow's complete log, timeline and artifacts remain retrievable for the full retention
  period after its instance is destroyed, verified for 100% of sampled historical runs.
- **SC-013**: Zero rendered log lines contain terminal control sequences or spinner frames, and zero
  contain a value matching a known secret pattern, across a sampled corpus of runs.
- **SC-014**: Access is refused for 100% of unauthenticated and out-of-domain attempts, and an executor
  credential can be demonstrated to grant nothing beyond its own workflow.
- **SC-015**: The design system lints with zero errors, and an audit of the panel finds zero literal
  colours, font sizes or radii outside the token set and zero hand-rolled duplicates of an existing
  primitive.
- **SC-016**: A change to a client's branch or ticket convention is delivered by editing skills in the
  target repository alone, with zero changes to any Sisyphus project — demonstrated for at least two
  materially different convention sets.
- **SC-017**: The platform sustains its target concurrent-workflow count without degrading panel
  responsiveness or breaching the concurrency ceiling.
- **SC-018**: Zero duplicated external actions (duplicate pull requests, duplicate comments, repeated
  transitions) and zero half-applied multi-step actions occur across all runs, including runs that
  exercised a retry.
- **SC-019**: No run ever advances past its last recoverable snapshot point; every parked or interrupted
  workflow is resumable from a snapshot containing both conversation and workspace state.
- **SC-020**: Onboarding a new client — new credentials, new tooling — is achieved by registering a setup
  profile and an integration, with zero changes to any Sisyphus project and zero redeploys.
- **SC-021**: 100% of workflows record the setup profile and profile version they ran with, and a completed
  workflow's bootstrap remains reconstructable for the full retention period.
- **SC-022**: Zero credentials installed by a setup profile appear in any captured setup or run output, across
  a sampled corpus of runs.
- **SC-023**: Zero tickets result in more than one workflow being started for them, measured across all
  integrations and including control plane restarts and overlapping ticks.
- **SC-024**: A bulk label application never causes more workflows to start than the configured per-tick and
  rolling-period ceilings permit, and no matching ticket is permanently dropped.
- **SC-025**: Registered schedules match enabled integration configuration 100% of the time — no orphaned
  schedule fires for a disabled or deleted integration, and no enabled integration lacks a schedule.
- **SC-026**: A broken integration is detectable from the panel within one scheduled interval of its first
  failure, and auto-disables within the configured consecutive-failure threshold.

## Assumptions

- **Environment**: One cloud account per stage-isolated deployment, with stages distinguished by resource
  naming. Compute is a general-purpose instance family; the specific class is per-job configuration, not a
  platform constant.
- **Persistence**: A single managed relational database holds workflow state, setup profile registrations and
  integration configuration; object storage holds logs, session snapshots, artifacts and setup profile
  archives. The schema is owned exclusively by `sisyphus-api`.
- **Identity**: Users are Bluetel Google Workspace identities; there is no self-registration and no
  external or client access. Roles are coarse (engineer, lead/admin) — per-repository permissioning is out
  of scope for v1.
- **Ticket tracker and repository host**: Jira and GitHub respectively, reached over their public APIs. The
  platform depends on their availability; an outage parks affected workflows rather than failing them, and
  fails the affected integration tick rather than losing the item.
- **Streaming input for corrections**: Delivering a correction as an extra user turn on the agent's input
  stream is the primary mechanism; conversation resumption from a snapshot is the **cold-start** path only,
  not the correction path. The stream format is not fully documented beyond the flag reference, so a spike
  to confirm the exact message shape — and to evaluate the agent SDK, which exposes the same message model
  more legibly — is assumed as the first implementation step. Structured output streaming additionally
  requires verbose output to be enabled.
- **Session storage layout**: The agent stores conversation state on disk in a directory derived from the
  absolute working directory, in an append-only log that is not written atomically. The platform therefore
  pins the workspace path, relocates the agent's entire configuration tree inside that workspace, assigns
  the session identifier itself, and tolerates a truncated trailing record on restore. Conversation state
  alone is insufficient — the working tree is snapshotted alongside it (or work in progress committed to a
  scratch branch), so the model's beliefs about the filesystem match the restored instance.
- **Caps**: Turn and spend caps are part of the job specification from day one, with platform defaults
  applied when a request omits them, specifically so unattended iteration cannot produce a surprise bill.
  Spend caps are only enforceable when the run's setup profile installs a metered, per-token credential; a
  flat-rate seat credential makes them advisory, and the profile declares which it is (FR-093).
- **Setup profiles**: A profile is a gzipped tar archive with an executable `setup.sh` at its root, held in
  private encrypted object storage and registered in the database. The script is a black box to the platform:
  Sisyphus verifies, unpacks and runs it with a bounded timeout, captures and redacts its output, and treats
  a non-zero exit as a bootstrap failure — it does not inspect or validate what the script does internally.
  Archives are assumed to be authored and reviewed by platform administrators, not by end users, and are
  therefore trusted to run with the privileges the instance has. Profiles are immutable once registered;
  changing one creates a new version.
- **Integrations and scheduling**: Work discovery is **poll-based on a cron schedule**, not webhook-driven.
  Matching is evaluated against the item's current state (the label being present now) rather than against a
  received event, which is what makes missed ticks self-healing — the next successful tick picks up anything
  still matching. Cron expressions are interpreted in a single fixed timezone (UTC) to avoid daylight-saving
  ambiguity. The claim record that stops a ticket being picked up twice is assumed to live in the platform
  database rather than as state in the external tracker, so it survives a tracker-side change.
- **Integration credentials**: An integration's credential is stored encrypted and is write-only from the
  panel — it can be replaced but never read back. It is distinct from the credentials a setup profile
  installs on an instance: the integration credential is used by the control plane to discover work, the
  profile's credentials are used by the executor to do work.
- **Skills**: Target repositories carry `sisyphus-dev`, `sisyphus-review` and `sisyphus-integration` skills
  in the repository's agent-skill location. Authoring those skills for a client repository is a
  client-onboarding activity, not part of this feature.
- **Reference implementations**: Behaviour worth keeping from the existing proof-of-concept worker (output
  sanitisation, process-group timeout handling, pushed-commit verification, structured logging) is
  reimplemented in `sisyphus-executor`, not imported.
- **Excluded POC behaviour**: Multi-agent routing and agent registries, non-Claude executors, inbound
  tunnelling, agent-to-agent servers, and in-worker webhook receipt are deliberately not carried over.
- **Retention**: Logs and artifacts are retained for a defined operational window (assumed 12 months);
  session snapshots for a shorter window (assumed 30 days after a workflow reaches a terminal state), both
  enforced by storage lifecycle policy.
- **Scale**: Sized for tens of concurrent workflows and tens of thousands of historical workflows — not a
  multi-tenant public service.

## Dependencies

External prerequisites this feature cannot deliver for itself. Each is a blocker for the stories noted.

- **Cloud account access** for ephemeral compute, private object storage, a managed relational database and
  a managed secret store, provisioned per stage with full isolation between stages. _(All stories.)_
- **Google Workspace identity configuration** permitting sign-in restricted to Bluetel-controlled domains.
  _(Story 1 onward.)_
- **Agent credentials** with a spend limit appropriate to unattended execution, packaged into a setup
  profile. _(All stories; note FR-093 — a flat-rate seat credential makes per-workflow spend caps
  advisory rather than enforceable.)_
- **Repository host credentials** with the scopes needed for the actions the repository skills instruct
  (clone, push, open and comment on pull requests), packaged into a setup profile. _(All stories.)_
- **At least one authored setup profile** per client whose work Sisyphus will do — the archive and its
  `setup.sh` are authored by a platform administrator, not generated by this feature. _(All stories; Story
  7 delivers the mechanism, not the profiles.)_
- **Ticket tracker credentials, project keys, the autonomous-delivery label, and transition names** for each
  client project — the integration configuration and the transitions the skills name. _(Stories 4, 5 and 8.)_
- **A schedule execution mechanism on the control plane** capable of registering and re-registering per
  integration schedules. _(Story 8.)_
- **CircleCI configured with federated cloud identity** for each stage, with the identity provider created
  by the production bootstrap before any other stage can deploy. _(Deployment of all stories.)_
- **Target repositories carrying `sisyphus-dev`, `sisyphus-review` and `sisyphus-integration` skills.**
  Authoring these per client is a client-onboarding activity outside this feature, and their absence blocks
  autonomous and review workflows specifically. _(Stories 4 and 5.)_
- **A confirmed mechanism for multi-turn input to a live agent process**, established by the spike named in
  the Assumptions. Correction-without-restart (Story 2) depends on it; if the spike fails, the fallback is
  the agent SDK exposing the same message model.

## Out of Scope

- Support for any agent other than Claude Code.
- Non-developer-facing prompt-iteration workflows (support triage, document QA, retrieval over internal
  knowledge) — these stay on the existing low-code workflow tooling, deliberately, so the audience
  boundary stays clean.
- Client- or customer-facing access to the panel; external identity providers; fine-grained per-repository
  authorisation.
- Local execution of the executor as a supported product mode (a local run is a development aid only).
- Automated authoring of the `sisyphus-*` skills for a client repository.
- Migration of any data or behaviour out of the existing proof-of-concept applications.
- Interactive terminal (TUI) attachment to a running agent.
- Any integration type other than Jira. The construct is extensible, but no second connector is built here.
- Webhook-driven work discovery. Integrations poll on a cron; event-driven entry is a later change.
- Authoring setup profile archives or their `setup.sh` scripts, and any validation of what those scripts do
  internally beyond verifying the archive and treating a non-zero exit as a bootstrap failure.
- A visual or in-panel editor for building setup profiles; archives are authored outside Sisyphus and
  uploaded.
- Automatic discovery or rotation of the credentials a setup profile installs.
