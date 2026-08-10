# Feature Specification: Sisyphus — Supervised & Autonomous Agentic Delivery Platform

**Feature Branch**: `feature/sisyphus-workflow-platform`

**Created**: 2026-08-05

**Status**: Draft

**Input**: User description: a scalable, AI-native delivery platform (codename **Sisyphus**) that runs Claude Code on isolated cloud instances on behalf of Bluetel engineers — supervised delegation of a ticket, a fully autonomous develop→review→integrate loop, and a standalone review workflow — administered and observed through an internal admin panel.

> ### Partly superseded by `003-agent-credential-pool`
>
> Four requirements in this document have been **replaced** by
> [`specs/003-agent-credential-pool/spec.md`](../003-agent-credential-pool/spec.md), and each carries a
> note where it appears: **FR-043**, **FR-049**, **FR-072** and **FR-075**.
>
> They are marked rather than deleted, and deliberately. This specification is the record of what the
> platform was designed to do and why, and a requirement that quietly vanished would leave the
> reasoning behind it — and every design decision downstream of it — with nothing to point at. A
> reader arriving at `002/FR-049` from a code comment written in 2026 needs to find it, and needs to
> find out in the same breath that it is no longer what the platform does.
>
> The two changes in one sentence each:
>
> - **The agent's credential left the setup bundle.** 002 assumed it was a static secret a bundle
>   could install and a boot could reinstall. That is true of a metered API key and false of a
>   subscription login session, whose refresh credential rotates every time the agent uses it — so a
>   bundle-carried copy is stale the moment the agent works, and bundles are shared across clients
>   besides. The agent identity is now a **pooled credential leased to one workflow at a time**;
>   bundles keep every _other_ credential exactly as 002 describes.
> - **A pause stops the instance instead of holding the process alive.** 002's pause kept the agent
>   in memory on a running instance, which made a resume instant and made a pause cost the same as
>   running. A pause is now a turn boundary, a durable snapshot, and then a **stop with the disk
>   retained**; spot instances cannot be stopped at all and degrade to 002's snapshot path.
>
> Everything else in this document stands. In particular 003 leaves untouched: access control and
> execution profiles, workspaces and entries, integrations and scheduling, correction and
> supervision, the output strip-and-redact pipeline, notifications, snapshots as a durability
> mechanism, and the reconciliation sweep.

## Overview

Sisyphus turns "remote Claude Code" into a first-class, observable product. An engineer hands a ticket
to a worker that runs in a disposable, isolated instance; they watch it work in the browser, and —
crucially — they can **pause it and correct it mid-flight** the same way they would locally, without
killing the run or losing the conversation.

Every convention that varies by client (branch names, PR etiquette, ticket transitions, review
rubric, integration steps) lives in **skills inside the target repository**, not in Sisyphus. Sisyphus
supplies the harness: provisioning, isolation, session durability, log capture, correction, budget
control, and reporting.

Four configuration constructs keep client onboarding out of the platform's release cycle entirely:

- **Setup bundles** — a named, versioned archive with a `setup.sh` at its root that turns a bare instance
  into a worker able to do one client's work, installing the repository, ticket-tracker and other
  credentials that work needs, and whatever tooling goes with them. A new client is a new bundle, not a
  deploy. (The **agent's own** credential is no longer among them — see the supersession note at the top
  of this document, and `003/FR-048`.)
- **Workspaces** — a named set of repositories, each on its own branch, checked out side by side into one
  folder. A workspace may hold a single repository or several (backend, frontend, admin), which is what lets
  one run make a coordinated change across all of them.
- **Execution profiles** — reusable launch presets pairing a workspace with a model, instance size, caps and
  setup bundle, so starting a run is choosing a preset and writing a prompt rather than filling in eleven
  fields.
- **Integrations** — configurable connectors that discover work externally and start workflows for it. Jira
  is the only type implemented; several can run at once, one per board, each with its own credential,
  filters, cron schedule and execution profile.

Together with repository skills, that means the four things that vary per client — conventions,
credentials, what to work on, and how work arrives — are all configuration rather than code.

The platform is delivered as seven workspace projects, all carrying the codename:

| Project                              | Kind    | Role                                                                                                                            |
| ------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `packages/sisyphus-api`              | package | The one shared contract: database schema, domain types, entire typed API surface + resolvers                                    |
| `packages/sisyphus-infra`            | package | Shared, app-agnostic infrastructure primitives for all Sisyphus deployables                                                     |
| `packages/sisyphus-integration-jira` | package | The Jira connector — one standalone package per integration type, implementing the connector contract owned by `sisyphus-api`   |
| `packages/sisyphus-notify`           | package | Slack notification delivery, recipient resolution and the attempt record — shared by the two apps that notify                   |
| `apps/sisyphus-admin`                | app     | Internet-facing admin panel — auth, workflow list/detail, live log view, pause/correct UI, webhook + executor reporting ingress |
| `apps/sisyphus-control-plane`        | app     | Non-network-facing backend job runner — provisions and tears down workflow compute, mints scoped credentials                    |
| `apps/sisyphus-executor`             | app     | The worker that runs on the provisioned instance and drives the Claude Code CLI                                                 |

Existing workspace apps (`kiro-github-worker`, `admin-dashboard`, `dify-kiro-node`, `rockhub`) are
proofs of concept. Sisyphus **takes inspiration from them and supersedes them**; it does not extend
them, and no Sisyphus project may depend on them. Updated these poc now removed.

## Clarifications

### Session 2026-08-05

- Q: Two user-facing concepts both ended in "profile" (the bootstrap archive and the launch preset) — how
  should they be named? → A: Rename the archive to **Setup Bundle**; keep **Execution Profile**. "Bundle"
  names the packaged artifact, "profile" names the reusable configuration, and the two MUST NOT be used
  interchangeably.
- Q: Where does an integration-started workflow's prompt come from? → A: Layered assembly — the execution
  profile's optional prompt preamble (codebase context), then the integration's prompt intro (how work from
  this board should be approached), then the ticket's title, URL, description and comments. Sisyphus's own
  ticket comments are excluded, and the assembled prompt is recorded as sent.
- Q: Who may register a setup bundle, given it carries client credentials and runs arbitrary shell? → A: Define
  an **admin** role; only admins may register, replace, enable or disable a setup bundle. Adds an admin-only user
  management surface (FR-166..FR-178, User Story 12).
- Q: Who may see and supervise which workflows, and who may configure the platform? → A: The **execution profile
  is the unit of access control**. Admins configure everything (bundles, workspaces, profiles, integrations,
  grants, users) and see all runs; engineers launch and supervise only within the profiles granted to them, and
  see only those runs — plus any workflow they own or initiated, regardless of grant (FR-179..FR-191, User Story
  13).

### Session 2026-08-06

- Q: What shape should the panel's navigation chrome take, and what should the root route `/` do? → A: A
  **persistent role-aware left sidebar** (Workflows, Needs attention, Fleet, plus an Admin group visible only
  to admins) alongside a **top bar carrying the signed-in identity and a sign-out control**, applied to every
  authenticated screen. `/` **redirects to `/workflows`** rather than becoming a thirteenth screen
  (FR-193..FR-196).
- Q: Where should FR-138's notification preferences and workflow-watching live in the panel? → A: Split by
  subject — a dedicated **`/settings/notifications` screen** owns the account-level per-event preferences and
  shows the resolved Slack identity (or its absence, FR-140); a **Watch / Unwatch control on the workflow
  detail view** owns watching a workflow you do not own (FR-138 amended).
- Q: How should the typecheck gate handle generated code it does not author, given `strict` may not be
  relaxed? → A: Filter, don't relax. The typecheck target pipes strict `tsc --noEmit` through a
  loose-check filter configured by two per-project files — an ignored-error-code list and a glob list of
  loosely-checked files. Adopted **only where generated types exist**: the three deployables (the
  infrastructure tool's generated type tree) and `sisyphus-infra`. `sisyphus-api` and
  `sisyphus-integration-jira` keep a plain strict `tsc --noEmit` with no suppression channel at all
  (FR-198).
- Q: Is folding bootstrap into a stage-suffix branch inside one deployment config file intentional? → A: No —
  replace it with a **three-file split per deployable**: an application config, a bootstrap config invoked
  explicitly against the bootstrap stage, and a no-op install config used only to generate provider types
  without credentials. The stage suffix is kept as well, so a bootstrap deploy is identified by both its
  stage and its config file (FR-199).
- Q: How far should `sisyphus-infra` be de-abstracted, given its primitives currently take injected provider
  interfaces so the package can typecheck without generated types? → A: All the way for the constructs, but
  not for the pure logic. Each primitive **instantiates its infrastructure resources directly**; every
  `*Provider` / `*Surface` structural interface and the structurally-declared deployment-config type are
  **deleted**. The pure `build*` helpers — resource naming, retention schedules, IAM policy documents, the
  CI identity provider's trusted subject — are **kept with their colocated tests**, because a mistake there
  is a security or data-retention defect rather than a deploy failure. The install config (FR-199) and the
  filtered typecheck (FR-198) are what make the direct form viable in CI without credentials (FR-066
  amended, FR-200, FR-202).

## User Scenarios & Testing _(mandatory)_

**Delivery order is by priority, not by story number.** Stories 7 to 13 were added after the original six
were numbered; in priority terms the order is:

> US7 + US12 + US13 (P1, together) → US1 (P1) → US9 (P1) → US11 (P1) → US2 (P1) → US3 (P2) → US10 (P2) →
> US8 (P2) → US4 (P2) → US5 (P3) → US6 (P3)

US7 comes first because no run can install its credentials without it — and **US12 and US13 ship with it, not
after it**, because the admin role is what gates bundle registration and profile access is what scopes everything
else; shipping either surface before its gate would mean every user could install client credentials or read every
client's runs. Retrofitting an access boundary after workflows exist is materially harder than building to it.
US9 follows US1 because presets are only meaningful once there is something to preset. US11 precedes US2 because being told a run needs you is what makes correcting it possible
at all — an engineer who is not watching cannot catch a tangent. US10 precedes US8 because an integration resolves
a ticket to an execution profile, which may carry a multi-repository workspace. US8 precedes US4 because an
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
   detail, **Then** they see a link to every resulting pull request, the final run summary, the full sanitized
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

An **admin** opens the panel to see every current and past workflow across all execution profiles: who started
it, which repository and ticket, type, status, elapsed time, turns and spend, and the outcome. They filter by
user, repository, status and type, open any historical run, and read its complete log and timeline long
after its instance is gone. An engineer opening the same views sees the same information, narrowed to the
execution profiles granted to them plus the workflows they own.

**Why this priority**: Required for trust, cost control, and post-mortems, but the platform can be
demonstrated without filtering and history views.

**Independent Test**: With a mix of finished workflows from several users, filter by user and by status
and confirm the result set and each workflow's stored log and timeline are complete and attributable.

**Acceptance Scenarios**:

1. **Given** workflows started by several engineers, **When** an admin filters by user, **Then** only that
   user's workflows are listed, with status, type, repository, ticket, duration, turns and spend.
2. **Given** a workflow whose instance was destroyed weeks ago, **When** its detail page is opened,
   **Then** its full sanitized log, timeline (including pauses and corrections), artifacts and outcome
   are still readable.
3. **Given** any workflow, **When** its log is displayed, **Then** it is free of terminal control
   sequences, progress-spinner frames and cursor movement, and remains faithful to the meaningful
   output.

---

### User Story 7 - Register an executor setup bundle (Priority: P1)

A platform administrator needs Sisyphus to be able to work on a new client's repository, which requires a
different set of credentials and tooling from the last one. Rather than changing Sisyphus, they build a
setup bundle: a gzipped tar archive with a `setup.sh` at its root that installs the repository and
ticket-tracker credentials and whatever else that client's work needs. They upload it in the
admin panel, give it a name and description, and enable it. From then on any workflow — started by hand or
by an integration — can name that bundle, and the executor unpacks and runs it before the agent starts.

> Under 003 a bundle no longer installs the **agent's** credential: that is a pooled seat fetched from
> the machine surface during bootstrap (`003/FR-048`, `003/FR-011`). Every other credential in this
> story is unchanged, and so is the whole of the bundle mechanism around it.

**Why this priority**: This is how every credential except the agent's own reaches an instance at all, so
nothing else runs without it. It is also the mechanism that keeps client onboarding out of the platform's release cycle — a new
client is a new bundle, not a deploy.

**Independent Test**: Register a bundle whose `setup.sh` writes a recognisable marker file and exports a
credential, start a workflow referencing it, and confirm the marker exists on the instance, the agent
started with the credential available, and the bundle and its version are recorded on the workflow.
Then register a bundle with a deliberately failing `setup.sh` and confirm the workflow fails at bootstrap
with a bundle-setup error and the agent never starts.

**Acceptance Scenarios**:

1. **Given** a user holding the admin role, **When** they upload a valid bundle archive with a name and
   description, **Then** it is stored privately and encrypted, registered with a content digest and version,
   and appears in the bundle list as enabled.
2. **Given** an authenticated user **without** the admin role, **When** they attempt to register, replace,
   enable or disable a bundle, **Then** it is refused with the reason stated and the attempt is recorded — but
   they can still see the enabled bundles in order to build an execution profile.
3. **Given** a workflow referencing an enabled bundle, **When** the instance bootstraps, **Then** the
   archive is downloaded, verified against its digest, unpacked, and `setup.sh` is run to completion before
   any agent work begins.
4. **Given** a bundle whose archive fails digest verification, is missing `setup.sh` at its root, or whose
   `setup.sh` exits non-zero, **When** bootstrap runs, **Then** the workflow fails with an explicit
   bundle-setup failure naming the bundle and the failing step, and the agent is never started.
5. **Given** a `setup.sh` that echoes a credential to its output, **When** its output is captured, **Then**
   the credential is redacted before it is stored or displayed.
6. **Given** an admin replacing a registered bundle's contents, **When** they upload the new
   archive, **Then** a new version is created rather than the existing one mutated, and a completed workflow
   still reports the exact bundle version it ran with.
7. **Given** a bundle referenced by an integration or a non-terminal workflow, **When** deletion is
   attempted, **Then** it is refused with the references named, and the admin is offered disabling
   instead; runs already in flight are unaffected.

---

### User Story 8 - Configure a Jira integration to feed the pipeline (Priority: P2)

An admin wants labelled tickets on a specific Jira board to be picked up automatically. In the admin panel
they create an integration: name it, give it the Jira base URL and an API credential, scope it to a project
prefix, name the label that marks a ticket for autonomous delivery, pick the setup bundle and target
repository and branch, set the model and caps the resulting workflows inherit, and give it a cron schedule.
They enable it, and its schedule is registered. On each tick it looks for newly-labelled tickets in scope
and starts one autonomous workflow per ticket. A second board is handled by adding a second integration with
its own credential, execution profile and schedule — both run side by side.

**Why this priority**: This is the entry point for the autonomous pipeline (US4), and the thing that makes
Sisyphus scale past one engineer starting runs by hand. It is not needed for supervised delegation, so it
follows the P1 slices.

**Independent Test**: Configure an integration against a test board with a short cron, label one in-scope
ticket, and confirm exactly one autonomous workflow starts with the configured execution profile, repository, branch,
model and caps. Confirm a second tick does not start a duplicate. Add a second integration for a different
board and confirm both operate independently. Break the credential and confirm the runs are recorded as
failing and the integration auto-disables after the threshold.

**Acceptance Scenarios**:

1. **Given** an admin, **When** they submit an integration configuration, **Then** it is validated
   — including a connectivity check against Jira — before it can be enabled, and the credential is stored
   encrypted and never rendered back.
2. **Given** an enabled integration, **When** its schedule is created, changed, disabled or the integration
   deleted, **Then** the registered schedule is created, updated or removed to match, so stored
   configuration and registered schedules never diverge.
3. **Given** an in-scope ticket carrying the configured label, **When** the next tick runs, **Then** exactly
   one autonomous workflow starts, using the integration's setup bundle, repository, base branch, model and
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
10. **Given** an integration with a prompt intro and an execution profile with a prompt preamble, **When** a
    ticket is picked up, **Then** the assembled prompt contains the preamble, then the intro, then the ticket's
    title, URL, description and comments oldest-first, in that order, and is recorded on the workflow as sent.
11. **Given** a ticket carrying comments Sisyphus itself posted, **When** the prompt is assembled, **Then** those
    comments are excluded.
12. **Given** an integration being configured, **When** the author edits the prompt intro, **Then** the interface
    states which ticket fields are appended and offers a preview of the assembled prompt for a sample ticket.
13. **Given** a ticket whose title and description are both empty, **When** a tick runs, **Then** no workflow is
    started and the ticket receives a comment stating why.

---

### User Story 9 - Launch from a saved execution profile (Priority: P1)

An engineer has run Sisyphus against the same client repository a dozen times. Rather than re-entering the
repository, branch, model, instance size, purchase mode, caps and setup bundle every time, they pick the
`client-a-backend` execution profile from a dropdown, paste a prompt, and press start — two fields, not
eleven. A colleague who has never run Sisyphus against that repository can do the same, once granted that
profile, without knowing which instance size or setup bundle is appropriate — because the admin who does know
has already encoded it. When a run needs something unusual, the engineer overrides the model or raises the cap
for that one run, and the override is recorded next to the profile it came from.

**Why this priority**: Launch friction is the single most likely reason an engineer goes back to running the
agent locally. It also removes the three fields nobody has a basis to answer — instance size, caps, and which
setup bundle matches the repository — and the execution profile's validation is what prevents a run being launched with
a setup bundle that does not match its repositories at all.

**Independent Test**: Create an execution profile, then start a run supplying only a prompt, and confirm the
workflow ran with every value the profile carried and recorded the profile and version. Override one value on
a second run and confirm both the override and the originating profile are recorded. Attempt to enable a
execution profile whose setup bundle is disabled or whose repository is unreachable and confirm it is refused.

**Acceptance Scenarios**:

1. **Given** an admin, **When** they create an execution profile naming a workspace, model, instance
   size, purchase mode, caps and setup bundle, **Then** it is validated and — once enabled — is selectable on
   the launch form.
2. **Given** an enabled execution profile, **When** an engineer selects it, **Then** every value it carries is
   prefilled and the run is startable with the prompt as the only further input.
3. **Given** a prefilled form, **When** the engineer changes an unlocked value, **Then** the run uses the
   changed value and the workflow records both the override and the profile it derived from.
4. **Given** a profile that marks a field locked, **When** an engineer attempts to override it, **Then** the
   override is refused and the reason is shown.
5. **Given** an execution profile whose setup bundle is disabled, or one of whose workspace entries is
   unreachable with the available credentials, **When** enabling is attempted, **Then** it is refused naming
   the failing element.
6. **Given** an ad hoc launch with no profile selected, **When** the run is started, **Then** it proceeds
   normally, records that it was ad hoc, and offers to save the entered configuration as a new profile.
7. **Given** an execution profile edited while a workflow launched from it is running, **When** the edit is
   saved, **Then** a new version is created, the in-flight workflow is unaffected, and it still reports the
   version it ran with.

---

### User Story 10 - Make a coordinated change across several repositories (Priority: P2)

A ticket requires a change to the backend API, a matching change in the frontend that consumes it, and a
config change in the admin app — three separate repositories, each on its own branch. The engineer picks an
execution profile whose workspace declares all three, checked out side by side into one folder. One run, one
conversation: the agent can read the backend contract and the frontend call site together, which is the whole
point. It produces one pull request per repository it changed, all on the same branch name and
cross-referencing each other, and the merge order is whatever the primary repository's integration skill says
it is.

**Why this priority**: Coordinated cross-repository change is exactly the work that is most painful by hand
and most valuable to delegate, and single-run visibility across repositories is something a per-repository
worker fundamentally cannot offer. It depends on the workspace and profile machinery, so it follows those.

**Independent Test**: Define a three-entry workspace, run a prompt requiring a change in two of the three, and
confirm one folder contains all three checkouts at their declared branches, two pull requests are produced on
a shared branch name cross-referencing each other, the untouched repository produces none, and the workflow
records each entry's resolved commit and result.

**Acceptance Scenarios**:

1. **Given** a workspace with several entries, **When** the instance bootstraps, **Then** every entry is
   checked out at its declared branch into its declared subdirectory beneath the pinned workspace root before
   the agent starts.
2. **Given** a multi-entry workspace, **When** the agent runs, **Then** its working directory is the workspace
   root and it can read and change files in any entry within one session.
3. **Given** one entry that fails to check out, **When** bootstrap runs, **Then** the workflow fails naming
   that entry and the agent is never started against a partial workspace.
4. **Given** a run that changed two of three entries, **When** it completes, **Then** one pull request exists
   per changed entry, none for the unchanged entry, all sharing the branch name and cross-referencing each
   other, and each recorded against its entry.
5. **Given** a run whose changes landed for one entry and failed to push for another, **When** it completes,
   **Then** a per-entry result is recorded and the terminal outcome states the partial state rather than
   success.
6. **Given** a multi-entry workflow under review, **When** the review completes, **Then** one verdict is
   recorded with each finding anchored to entry, file and line.
7. **Given** a workspace configuration whose entry subdirectories collide or resolve outside the workspace
   root, **When** it is validated, **Then** it is rejected with the offending entries named.
8. **Given** a running workflow holding a repository and branch, **When** another workflow whose workspace
   includes that same repository and branch is started, **Then** it is refused or serialised with the holding
   workflow named.
9. **Given** a multi-entry workflow, **When** it is paused and later resumed on a fresh instance, **Then** every
   entry's working tree — including uncommitted work — is restored, because the snapshot covers the whole
   workspace root.

---

### User Story 11 - Be told when you are needed, without watching (Priority: P1)

An engineer starts a run and closes the tab. Twelve minutes later Slack messages them directly: the run has
finished and there are two draft pull requests, with a link. On another run the message says the review failed
for the second time and the workflow now needs a human — again with a link. They never had to keep a tab open,
and they never had to remember to check. Meanwhile the Jira ticket itself shows a comment saying Sisyphus
picked it up, so a colleague looking at the board knows what is happening without being told.

**Why this priority**: Without this, supervising a run means watching a run, which cancels the time saving that
justifies delegating in the first place. It is also the precondition for corrections ever being used in
practice — an engineer who is not watching cannot catch a tangent. And it is what stops
integration-started workflows ending in needs-attention with nobody responsible for them.

**Independent Test**: Start a run, close the panel, and confirm a Slack direct message arrives on completion
with a working link. Force a run into needs-attention and confirm the owner is messaged. Start a workflow from
an integration against a ticket with an assignee and confirm the assignee owns it; remove the assignee and
confirm the integration's default owner does. Label a ticket that matches no execution profile mapping and
confirm the ticket receives a comment saying why it was skipped.

**Acceptance Scenarios**:

1. **Given** a workflow with an owner, **When** it reaches a terminal outcome, **Then** the owner receives a
   Slack direct message stating the workflow, ticket, workspace, state, reason and consumption, linking to the
   workflow detail view.
2. **Given** a workflow that enters needs-attention, capped or parked-resumable, **When** the state is
   recorded, **Then** the owner is notified, and the workflow appears in their needs-attention view.
3. **Given** an integration-started workflow whose ticket has an assignee, **When** the workflow is created,
   **Then** that assignee is its owner; **and given** a ticket with no assignee, **Then** the integration's
   declared default owner is.
4. **Given** an integration with no default owner, **When** enabling is attempted, **Then** it is refused.
5. **Given** a user with no resolvable Slack identity, **When** a notification is due, **Then** the workflow
   proceeds unaffected, the failure is recorded, and the unnotifiable user is surfaced in the panel.
6. **Given** an integration tick that starts many workflows, **When** notifications are sent, **Then** one
   summary message is delivered rather than one message per workflow.
7. **Given** a ticket a workflow has been started for, **When** the workflow is created, **Then** a comment
   identifying and linking to the workflow appears on the ticket.
8. **Given** a labelled ticket that matches the integration's filters but no execution profile mapping, **When**
   the tick completes, **Then** the ticket receives a comment stating why it was skipped.
9. **Given** repeated ticks over an already-claimed ticket, **When** they run, **Then** no duplicate comment is
   posted.

---

### User Story 12 - Administer users and who may install credentials (Priority: P1)

A new engineer joins and signs in with their Bluetel Google account; they can immediately launch runs from
existing execution profiles without anyone provisioning them. Later they need to onboard a new client, which
means registering a setup bundle carrying that client's credentials — an admin grants them the admin role from
the user management screen. When someone leaves, an admin deactivates them: they lose access at their next
request, the workflows they owned surface for reassignment, and everything they did stays attributed to them.

**Why this priority**: Registering a setup bundle is the most privileged action in the system — it places client
credentials on an instance and runs arbitrary shell there — so who may do it needs to be a deliberate,
auditable decision rather than a side effect of domain membership. It is P1 and ships **with** US7 rather than
after it: a bundle registration surface without the role that gates it means every authenticated user can install
client credentials. Everything else stays open, so this is a narrow gate rather than a permissions system.

**Independent Test**: Sign in as a new user and confirm the engineer role is assigned automatically and bundle
registration is refused. Grant admin and confirm registration succeeds. Attempt to revoke the last remaining
admin and confirm refusal. Deactivate a user who owns a running workflow and confirm they are denied at the next
request, the workflow is flagged for reassignment, and their history remains attributed.

**Acceptance Scenarios**:

1. **Given** a member of a permitted domain signing in for the first time, **When** authentication succeeds,
   **Then** a user record is created automatically with the engineer role and no invitation step is required.
2. **Given** an engineer without the admin role, **When** they attempt to register or replace a setup bundle,
   **Then** it is refused with the reason stated and the attempt is recorded.
3. **Given** an admin on the user management screen, **When** they grant the admin role to an engineer, **Then**
   that user may register bundles from their next request onward, and the grant is recorded with actor, subject
   and time.
4. **Given** the only active admin, **When** they attempt to revoke their own admin role or deactivate
   themselves, **Then** the change is refused because the platform would be left with zero active admins.
5. **Given** a deployment with no users yet, **When** it is deployed, **Then** at least one admin exists from
   configuration, so the first admin does not require an admin to create them.
6. **Given** a user who is deactivated while signed in, **When** they make their next request, **Then** access is
   denied without waiting for their session to expire.
7. **Given** a deactivated user who owned workflows, **When** deactivation completes, **Then** those workflows are
   flagged for reassignment and their past workflows, corrections and configuration changes remain attributed to
   them.
8. **Given** any role or activation change, **When** it is applied, **Then** it appears in a history that names
   the acting admin, the affected user, the change and the time, and that history cannot be edited or deleted.

---

### User Story 13 - Work only on what you have been granted (Priority: P1)

An engineer joins the team assigned to one client. An admin grants them that client's execution profile — one
action, and they can now launch runs on those repositories with those credentials at those caps, and watch
everything that has ever run on that profile. They cannot see another client's runs, cannot launch against a
profile they were not granted, and cannot reconfigure anything. When they move onto a second client, an admin
grants a second profile. An admin, meanwhile, sees every run across every profile.

**Why this priority**: Bluetel works on many clients' code with many clients' credentials, and the execution
profile is the only place that combination is already named. Scoping access to it means one grant conveys exactly
"you may do this work, here, with these credentials, at this cost" — and it means an engineer on client A's team
cannot read client B's run logs, which is a commitment likely to appear in client contracts.

**Independent Test**: Grant an engineer one of two profiles. Confirm they can launch on the granted profile and
not the other; confirm the workflow list, filters, search and spend totals show only granted-profile runs with no
trace of the other's existence; confirm an admin sees both. Assign them ownership of a workflow on the ungranted
profile and confirm they can see and supervise that one workflow without gaining access to the profile.

**Acceptance Scenarios**:

1. **Given** an engineer granted one execution profile, **When** they open the launch form, **Then** only that
   profile is selectable, and ad hoc launching is unavailable to them.
2. **Given** an engineer, **When** they attempt to launch against a profile they do not hold, **Then** it is
   refused and the attempt is recorded.
3. **Given** workflows across several profiles, **When** an engineer lists, filters or searches them, **Then**
   only runs on their granted profiles appear, and runs outside that scope are not disclosed by any count,
   aggregate spend figure or search result.
4. **Given** an engineer viewing a workflow on a granted profile, **When** they pause, correct, resume or stop it,
   **Then** the action succeeds and is attributed to them.
5. **Given** an engineer and a workflow on a profile they do **not** hold, **When** they attempt to view or
   supervise it, **Then** access is refused — unless they own or initiated it, in which case both are permitted.
6. **Given** an admin, **When** they open any view, **Then** they see every workflow across every profile without
   needing a grant.
7. **Given** an engineer holding a profile, **When** they attempt to create or edit a workspace, execution
   profile, integration or setup bundle, **Then** it is refused; configuration is admin-only.
8. **Given** an engineer whose access to a profile is revoked, **When** they next launch, **Then** it is refused;
   **and** any workflow on that profile they own or initiated remains visible and supervisable by them.
9. **Given** any grant or revocation, **When** it is applied, **Then** it is recorded with the acting admin, the
   affected user, the profile and the time.

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
- **Setup bundle archive is malformed, missing `setup.sh`, or its digest does not match** — bootstrap fails
  explicitly naming the bundle and step; the agent is never started and no partial work is attributed.
- **`setup.sh` hangs** — bootstrap is bounded by a timeout, and exceeding it fails the workflow as a
  bundle-setup failure rather than holding a paid instance indefinitely.
- **`setup.sh` echoes a credential** — setup output is redacted to the same standard as run output.
- **A bundle is disabled or superseded while a run using it is in flight** — the in-flight run is unaffected
  and still reports the exact version it ran with; only new runs see the change.
- **A bundle still referenced by an integration or live workflow is deleted** — refused, with the references
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
- **A ticket matches the integration's filters but no execution profile mapping** — skipped with the reason
  recorded, never started under a guessed profile.
- **A ticket has a title but an empty description** — permitted; the title, URL and any comments still carry
  task content. Only an empty title **and** description together cause a skip.
- **A ticket carries hundreds of comments** — the assembled prompt is bounded and comments are dropped
  oldest-first, with the truncation recorded; title, URL and description are never truncated away.
- **A ticket comment contains a credential** — redacted before the assembled prompt is stored, to the same
  standard as run output.
- **Sisyphus's own ticket comments would be re-read as task input** — platform-authored comments are excluded
  from assembly, so its write-back cannot feed back into a later run.
- **The ticket is edited between the tick that matched it and the prompt being assembled** — the prompt as
  actually sent is recorded on the workflow, so the run stays explicable even though the ticket has moved on.
- **An execution profile's workspace grows an entry after a workflow using it has started** — the in-flight
  run keeps the version it started with; only later runs see the new entry.
- **A workspace entry's declared branch does not exist** — validation refuses to enable the profile, and if
  the branch is deleted later the workflow fails at checkout naming the entry rather than silently defaulting
  to the repository's default branch.
- **Two entries in one workspace point at the same repository** on different branches — permitted only if
  their subdirectories differ, and the concurrency guard (FR-120) treats each repository+branch pair
  separately.
- **A multi-entry workspace where the primary entry has no `sisyphus-*` skills** — halts per FR-058 naming the
  primary entry; skills are not searched for in the other entries.
- **The agent changes files in an entry the ticket did not concern** — permitted (it may be a genuine
  cross-repository requirement) but every changed entry produces its own pull request, so the change is never
  invisible.
- **A workspace so large that checkout dominates the run** — checkout is bounded by the bootstrap timeout and
  a workspace that cannot be prepared in time fails as a bootstrap failure rather than consuming the budget.
- **An engineer overrides a locked field** — refused with the reason shown, rather than silently ignored.
- **The owner's Slack identity cannot be resolved, or Slack is unreachable** — the workflow proceeds and reaches
  its outcome normally; the delivery failure is recorded and the unnotifiable user surfaced. Notification is
  never load-bearing for correctness.
- **A workflow changes state repeatedly in quick succession** (fails, is resumed, fails again) — notifications
  are coalesced rather than sent per transition.
- **The owner leaves the company or is deactivated** — the workflow is flagged as unowned and appears in a
  reassignment queue rather than notifying nobody in silence.
- **The last active admin tries to revoke or deactivate themselves** — refused, because the platform would be
  left unable to register or disable a setup bundle at all.
- **A user's admin role is revoked mid-session** — the loss takes effect at their next request rather than at
  next sign-in, so a stale session cannot register a bundle.
- **An admin is deactivated while a bundle upload is in progress** — the upload is refused at its next
  authorised step; a partially-uploaded archive is never registered.
- **A non-admin needs a bundle registered** — they can see enabled bundles and build execution profiles from
  them, so only the registration itself queues behind an admin.
- **A deployment starts with no users at all** — at least one admin is established from configuration, so the
  first admin never requires an admin to create them.
- **A user's profile access is revoked while they own a running workflow on it** — the in-flight workflow is
  unaffected and they retain visibility and supervision over it (FR-189); only new launches are refused.
- **An engineer filters or searches for a workflow outside their granted profiles** — it is absent from results
  entirely; neither its existence, nor a count including it, nor an aggregate spend figure containing it is
  disclosed.
- **An integration's default owner has no access to the profile that integration uses** — permitted; they own and
  can act on the resulting workflows without gaining profile-wide access.
- **An engineer needs a new kind of work they hold no profile for** — refused, and the action is an admin
  granting a profile rather than the engineer configuring one. Accepted friction of the access model.
- **The last admin is deactivated while profiles have granted users** — refused (FR-173); engineers would
  otherwise be left able to launch work that nobody could reconfigure or revoke.
- **A profile is disabled while engineers hold grants to it** — existing runs continue; new launches are refused
  because the profile is disabled, independently of who holds access to it.
- **A ticket comment fails to post** — retried idempotently per FR-077; on exhaustion the pending comment is
  recorded on the workflow, and the failure does not change the workflow's outcome.
- **A bootstrap phase hangs** — that phase's own timeout fails the workflow naming the phase, so the failure is
  attributable rather than a generic bootstrap timeout.
- **A setup bundle validates cleanly but fails in a real run** (or the reverse) — both results are recorded
  against the bundle version, so the discrepancy is visible rather than confusing.
- **A successor workflow is created from a predecessor whose snapshot has since expired** — refused with the
  retention limit stated, rather than silently starting a fresh conversation.
- **A successor chain grows long** — consumption is reportable per workflow and summed across the chain, so
  repeated cap-raising cannot hide the true cost of a piece of work.
- **A wall-clock schedule crosses a daylight-saving transition** — it stays at its wall-clock time in the
  integration's own timezone rather than drifting by an hour.

## Requirements _(mandatory)_

### Functional Requirements

#### Workspace & project structure

- **FR-001**: The platform MUST be delivered as workspace projects whose names all carry the Sisyphus
  codename: `packages/sisyphus-api`, `packages/sisyphus-infra`,
  `packages/sisyphus-integration-<type>` — one standalone package per integration type, of which
  `packages/sisyphus-integration-jira` is the only one in scope — `packages/sisyphus-notify`, which
  owns the Slack notification path (FR-136 to FR-141), `apps/sisyphus-admin`,
  `apps/sisyphus-control-plane`, `apps/sisyphus-executor`, published under the `@bluetel-ai/*` scope.
  Each integration type is its own package (FR-192).

  _Amended 2026-08-07 during implementation._ As first written this listed six projects and placed the
  notification path inside `apps/sisyphus-control-plane`, where it began, because the abandoned-run sweep was
  the only caller. It is not the only caller: five of the nine notifiable events are raised on the machine
  surface, which `apps/sisyphus-admin` mounts, so two apps need one delivery path. An app MUST NOT depend on
  another app, so the shared half is a seventh member both apps depend on rather than a directory one of them
  owns. Adding it is a promotion of existing code, not new scope; no other requirement changes, and the
  dependency arrow to `sisyphus-api` stays one-way.

- **FR-002**: Sisyphus projects MUST NOT depend on the existing proof-of-concept projects
  (`kiro-github-worker`, `admin-dashboard`, `dify-kiro-node`, `rockhub`); shared behaviour MUST be
  reimplemented in `sisyphus-api` or `sisyphus-infra` rather than imported from a POC. Updated these poc now removed.
- **FR-003**: Every Sisyphus project MUST be runnable and verifiable in isolation from its own directory,
  MUST own its own lint/test/typecheck configuration, and MUST expose those as workspace-orchestrated
  targets.
- **FR-004**: Every module MUST have a colocated test file, each directory and package MUST expose its
  public surface through a barrel, and consumers MUST import from the barrel rather than internal paths.
- **FR-203**: Every deployable MUST have an **assembled entry point** that composes its modules into the
  behaviour the deployable exists to perform, reachable from the command or handler its deployment
  configuration declares. A deployable whose declared handler names a file that does not exist, or whose
  entry point wires nothing, is incomplete regardless of how well its parts are tested. Correspondingly, a
  shipped module reachable from **no** production caller — only from its own tests and from a barrel that
  re-exports it — MUST be treated as a defect, not as a component awaiting integration. A user story is not
  complete until the path a user takes through it runs end to end; passing unit suites over its components
  are evidence of the parts, not of the story.
- **FR-204**: A database-backed test MUST NOT pass by not running. Where a suite requires a live database,
  CI MUST provide one and the suite MUST **fail** rather than skip when it is absent in CI, so a green
  pipeline means the assertions ran. Skipping locally when the variable is unset remains correct; skipping
  in CI does not. Any requirement whose only proof is a database-backed assertion — exactly-once claiming,
  advisory-lock serialisation, constraint enforcement, access scoping — is unverified until this holds.
- **FR-205**: A latency or duration criterion MUST be verified by **measuring the operation**, not by summing
  declared constants and asserting the total sits under a ceiling. A budget expressed as constants is a
  useful statement of intent, and each term MUST additionally be enforced as a real timeout at the operation
  it bounds; but the criterion itself MUST have at least one test that performs the work and observes the
  elapsed time. A test that adds numbers together keeps passing when the operation is slow, and when the
  operation never runs at all.

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
- **FR-012**: The panel MUST list the current and past workflows **the requester is permitted to see** (FR-181,
  FR-183, FR-190) with, per row: initiating user or originating integration, workflow type, status, workspace,
  ticket reference, model, execution profile, start time, duration, turns consumed, spend, and outcome. Where a
  workspace has several entries the row MUST identify the workspace rather than enumerate every repository.
- **FR-013**: The panel MUST support filtering that list by initiating user, originating integration, status,
  type, workspace, individual repository within a workspace, execution profile and setup bundle, and MUST remain
  responsive at the platform's target workflow history volume. Filters MUST operate only within the requester's
  permitted scope and MUST NOT reveal the existence of workflows outside it.
- **FR-014**: The panel MUST provide a workflow detail view showing the live or archived log, a timeline
  of lifecycle events (provisioned, started, paused, corrected, resumed, capped, completed), the execution
  profile and any per-run overrides, the workspace with each entry's repository, branch and resolved commit,
  **every** resulting pull request with the entry it belongs to and its per-entry result, the ticket links,
  artifacts, and consumption figures.
- **FR-015**: The panel MUST expose Pause, Resume, Stop and Send-correction controls on a workflow, each
  visible only when valid for the workflow's current state, and MUST reflect the resulting state
  transition without requiring a manual reload.
- **FR-016**: The panel MUST provide a start-workflow form that is **execution-profile-first**: selecting an
  enabled execution profile MUST prefill the workspace, workflow type, model, instance size,
  interruptible-capacity preference, turn cap, spend cap and setup bundle, leaving the prompt as the only
  required input (FR-122). The form MUST also permit an ad hoc launch where those values are entered directly
  (FR-129), MUST allow overriding any unlocked prefilled value (FR-123), and MUST accept an optional session
  reference to resume. Only enabled execution profiles and setup bundles MUST be selectable.
- **FR-017**: The panel MUST expose an ingress for external event delivery (ticket-tracker and
  repository-host events) and for executor reporting, authenticating each independently of the human
  session — external events by verified provider signature, executor reporting by its scoped credential.
- **FR-018**: The panel MUST reject an executor report whose credential does not match the workflow it
  claims to be reporting for.
- **FR-019**: All log output rendered in the panel MUST be sanitized of terminal control sequences,
  progress-animation frames and cursor manipulation, and MUST have secrets redacted, while preserving
  the meaningful content and its ordering.
- **FR-193**: Every authenticated screen MUST render inside one **application shell** providing a persistent
  left sidebar and a top bar. The sidebar MUST link to every screen the signed-in user may open, and MUST NOT
  link to any screen they may not — the rule is the user's own access, not a fixed list. For an engineer that
  is at minimum Workflows, Launch a run, Needs attention and their own account settings; for an admin it
  additionally includes fleet oversight and the **Admin** group (setup bundles, workspaces, execution profiles,
  integrations, users, audit). A group left with no permitted items MUST be absent entirely, not rendered empty
  or disabled. The shell MUST mark the section matching the current route by some signal other than colour
  alone. No screen may be reachable only by typing its URL.

  _Amended 2026-08-06 during implementation._ As first written this requirement listed Fleet among the
  always-visible items while fleet oversight is an admin-gated surface, so satisfying it literally would have
  shown engineers a link that answers `NOT_FOUND` — which FR-190 forbids. Access is now the criterion and the
  list is illustrative, which resolves the contradiction in FR-190's favour. If fleet oversight should instead
  be visible to engineers scoped to their own profiles, that is a change to the gate on that screen, not to
  this requirement.

- **FR-194**: The top bar MUST display the signed-in user's identity and MUST expose a **sign-out** control
  that terminates the session and returns the user to the sign-in screen.
- **FR-195**: The panel MUST provide a **sign-in screen** at the route the authentication layer is configured
  to use for both the sign-in prompt and the authentication-error return. It MUST offer the single Google
  provider, MUST render inside the design system rather than the framework default, and MUST show a readable
  reason when it has been reached as an error return. A reason MUST NOT disclose whether an account exists,
  and where two causes cannot be distinguished without disclosing that, the screen MUST name both causes and
  say plainly that it will not identify which applies. At minimum it MUST distinguish a **refusal** (naming
  both out-of-domain identity and deactivated account) from a **generic provider failure**. An unauthenticated
  request to any authenticated screen MUST arrive here, not at a 404.

  _Amended 2026-08-06 during implementation._ As first written this required out-of-domain and deactivated to
  be shown as distinct reasons. They cannot be: the authentication layer's sign-in callback returns a boolean,
  so both refusals arrive as one `AccessDenied` code, and separating them would require the panel to look up
  whether an account exists and report the answer to an unauthenticated caller — precisely the oracle FR-190
  forbids. Resolved in FR-190's favour; the two causes are named together rather than discriminated.

- **FR-196**: The root route `/` MUST redirect an authenticated user to the workflow list and an
  unauthenticated one to the sign-in screen. It MUST NOT be a dead end.
- **FR-197**: The panel MUST provide **route-level not-found and error boundaries** rendered in the design
  system. A not-found result — including one raised by an authorisation check that must not disclose
  existence (FR-190) — and an unhandled render error MUST both present a styled screen inside the application
  shell with a route back, never the framework's unstyled default.

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
- **FR-201**: Every screen MUST define its **loading, empty and error** presentation, not only its populated
  one — a list with no rows, a permitted-but-unpopulated surface, and a failed query MUST each render in the
  design system with a stated reason and a next action, never as a blank region or a raw error. The
  application shell (FR-193) MUST be fully operable from the keyboard with a visible focus ring, and its
  current-section marking MUST be conveyed by more than colour alone.

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
- **FR-043**: ~~The executor MUST provision its own runtime prerequisites on the instance — the agent CLI, its
  credentials, repository access, and the third-party credentials the job needs (e.g. ticket tracker,
  repository host) — by running the **setup bundle** its job references at bootstrap, never baking them into
  a machine image and never writing them to the log.~~

  > **Superseded in part by `003/FR-048` and `003/FR-011`.** The clause that no longer holds is
  > "**its credentials**" where those are the _agent's_. The bundle still installs the agent CLI,
  > repository access and every third-party credential the job needs, on exactly the terms above; what
  > it no longer installs is the agent's own login. That is a **pooled agent credential**, leased to
  > the workflow at admission and fetched from the machine surface during bootstrap phase
  > `credential_install` — because a subscription login rotates as the agent uses it, so a
  > bundle-carried copy is stale as soon as the run does any work, and bundles are shared across
  > clients besides. See `003/spec.md` → _Why this exists_.

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
- **FR-049**: **Pause** MUST suspend the relaying of work to the agent, capture a snapshot, and ~~hold the
  process alive without terminating it~~. **Stop** MUST end the run cleanly after capturing everything.
  **Correction** MUST be delivered as an additional user turn in the same conversation, exactly once, in
  submission order.

  > **The pause clause is superseded by `003/FR-039`; the rest of this requirement stands.** Suspending
  > the relay at a turn boundary and capturing a snapshot before the pause is acknowledged are
  > unchanged and are still what makes "paused" true. What changed is what happens next: the agent is
  > **ended** and the **instance is stopped with its disk retained**, so compute billing ends while
  > the working tree and the conversation stay where they are and a resume is a `StartInstances`
  > against the same box (`003/FR-041`). Holding the process alive made a pause cost the same as
  > running, which is why pauses were something to avoid using.
  >
  > Two consequences worth stating because they are easy to miss: a **one-time spot instance cannot be
  > stopped at all**, so a spot pause degrades to this document's snapshot-and-terminate path and is
  > held to 002's resume performance (`003/SC-007` reports the two separately); and the pause idle
  > limit in _US2 §4_ is **unchanged** — a pause left too long still parks — except that the workflow
  > **keeps its agent credential** through the park, because a park is an environment ending and not a
  > workflow ending (`003/FR-073`).

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
- **FR-065**: A workflow MUST record its ticket reference, its workspace and every entry's repository, base
  branch and resolved commit, the resulting branch name, the pull request set with each entry's result, the
  execution profile and version with any per-run overrides, the setup bundle and version, model, caps,
  consumption, initiating user or originating integration and mapping, and — for autonomous runs — each
  iteration with its review verdict.
- **FR-074**: An autonomous workflow MUST be startable manually from the panel, and MUST additionally be
  started when a **configured label is present on a ticket** that an enabled integration matches on its
  next scheduled poll. Ticket creation alone MUST NOT start a workflow — a human applying the label is the
  opt-in, and it is what bounds unattended spend.

#### Infrastructure & delivery

- **FR-066**: All Sisyphus infrastructure MUST be defined as code and composed from shared, app-agnostic
  primitives in `sisyphus-infra` rather than duplicated per app — including the deployed web application,
  object storage buckets, the CI identity-federation provider, and the deploy role. Those primitives MUST be
  **plain functions that instantiate infrastructure resources directly** and return the created resources.
  They MUST NOT accept injected provider interfaces, resource-constructor arguments, or any other
  indirection standing between the primitive and the resource it creates, and MUST NOT redeclare the
  deployment tool's own types structurally. A deployable's config file MUST consume them by importing the
  function and calling it — nothing between the import and the resource.
- **FR-067**: Deployments MUST be per-stage, with resource identifiers derived from the stage so stages
  are fully isolated within an account, and MUST be triggerable only from the protected integration
  branches — never from a feature branch or a hand-run deploy target.
- **FR-068**: CI MUST authenticate to the cloud provider by short-lived federated identity from the
  pipeline — no long-lived cloud access keys in CI configuration — and the identity provider MUST be
  created once by the production bootstrap and looked up by every other stage, failing with an explicit
  message naming the bootstrap step when it is absent.
- **FR-069**: The delivery pipeline MUST be the workspace's **existing GitHub Actions pipeline**, extended
  rather than replaced — introducing a second CI provider is not permitted, because the workspace's
  code-health gate, affected-project gate and deploy-approval flow already live there and the constitution
  treats both gates as blocking. It MUST verify only the affected projects (lint, typecheck, test,
  design-lint) on a pull request, and both the code-health gate and the affected-project gate MUST be green
  before merge.
- **FR-198**: The typecheck gate MUST stay `strict` and MUST NOT be weakened by compiler-option relaxation,
  blanket `include` exclusions, or inline suppression comments. Where a project contains **generated** code
  it does not author — principally the infrastructure tool's generated type tree — the target MUST instead
  pipe strict compiler output through a filter configured by two committed, per-project files: a list of
  ignored error codes and a glob list of the loosely-checked files. Only the three deployables and
  `sisyphus-infra` MUST carry those files; `sisyphus-api` and `sisyphus-integration-jira` MUST run a plain
  strict typecheck with no suppression channel. Both files MUST be reviewable diffs, so widening the
  suppression is a visible change rather than a silent one. The generated type tree MUST be **included** in
  the typecheck (the deployment tool's ambient globals are only typed through it), listed in the
  loosely-checked globs, and ignored by the linter — all three, since omitting any one either breaks the
  build or silently re-admits the errors. `sisyphus-infra`'s own suppression list MUST cover only the codes
  raised by its use of those ambient globals, not the wider set an application needs.
- **FR-199**: Each deployable MUST express its infrastructure as **three separate deployment config files**,
  not as conditional branches inside one: an **application config** deploying the app's own stack, a
  **bootstrap config** deploying the once-per-stage prerequisites (configuration parameters, the CI identity
  provider, the deploy role) and invoked explicitly against the bootstrap stage, and a **no-op install
  config** whose only purpose is to declare the providers so generated types can be produced without
  credentials and without deploying anything. A deploy MUST NOT be able to reach the wrong stack by getting
  a stage string wrong alone — the config file selects the stack and the stage selects the environment.
  Every command that acts on a stack — deploy, destroy, unlock — MUST name the config file that owns it; a
  destroy that omits it loads the wrong stack's configuration and mis-plans the teardown. The install
  config MUST declare exactly the same providers, at exactly the same pinned versions, as the application
  config, or the generated types will not describe what a deploy actually resolves. It MUST run
  automatically on dependency installation, since a fresh clone has no generated types and therefore cannot
  typecheck.
- **FR-202**: Configuration MUST be resolved inside the deployment config's own lifecycle functions, not at
  module scope, and MUST come from the stage's parameter store entry rather than from committed files —
  reachable with the ambient credential chain so a bootstrap can be run before any stack exists. The plain
  stage MUST be derived from the deployment stage by stripping the known stack suffixes, and that derivation
  MUST be the single place the mapping is expressed: the parameter path, the resource-name prefix, and every
  "is this production?" test MUST all go through it. A secret MUST be wrapped so it cannot land in
  infrastructure state in plain text, with a single, explicitly-named exception for a value the provider
  itself needs in order to be constructed.
- **FR-200**: The decisions that are security- or retention-critical MUST remain separately expressed and
  directly testable even though the resource-creating primitives are not unit-tested: resource naming and
  stage derivation, object retention schedules per class, the **content** of every access-policy document
  (its actions, resources and conditions), and the exact trusted subject the CI identity provider will
  accept. These MUST be pure functions with colocated tests; only the call that hands the resulting value to
  the provider sits in the untested primitive. Verifying a resource-creating primitive is the deployment's
  job; verifying these is not. Where a name is reconstructed in more than one place — a role created by the
  bootstrap and its identifier rebuilt by the deploy script — the shared part MUST be one exported constant
  used by both, never two string literals that agree today.
- **FR-070**: Deployment of a stage MUST require an explicit human approval step that records who
  approved, which commit, and which stage.
- **FR-071**: Object storage for logs, session snapshots and artifacts MUST be private, encrypted,
  partitioned per workflow, and MUST carry a lifecycle policy expiring each class of object on a defined
  retention schedule.
- **FR-072**: Every credential the platform holds MUST be obtained at runtime, MUST be scoped to the least
  privilege its purpose needs, and MUST NOT appear in logs, snapshots, integration run records, or
  infrastructure state in plain text. Two paths exist and MUST NOT be conflated: credentials the **platform
  itself** uses (integration credentials for discovering work, cloud and database credentials) come from the
  managed secret store; credentials an **executor** uses to do the work come from the setup bundle its job
  references (FR-075, FR-083).

  > **Amended by `003/FR-011`, `003/FR-012` and `003/FR-013`: there are now three paths, not two.**
  > The first two are exactly as written. The third is the **agent credential**: it is held in the
  > managed secret store like a platform credential, but it is used by an _executor_ like a bundle
  > credential — the instance fetches it from the machine surface with its workflow-scoped credential
  > during bootstrap, and writes rotations back the same way.
  >
  > Everything this requirement says about _not appearing in plain text_ applies to it unchanged and
  > is if anything stricter: it is never in the job envelope (user data is readable from the metadata
  > service by anything on the box), never in a snapshot (the credential subtree is excluded at pack
  > time), never in a log segment (it is registered as a known value in the existing redaction
  > pipeline, `003/FR-014`), and never in an administrator-visible response (`003/SC-014`).

- **FR-075**: ~~The agent and~~ every other integration credential MUST be delivered to the executor by the
  **setup bundle** the job references (see _Executor setup bundles_ below), never baked into a machine
  image, never committed, and never held as a platform-wide constant. A credential installed by a bundle
  MUST NOT be shared with the target repository's own automation.

  > **The words "the agent and" are superseded by `003/FR-048`.** The agent's credential is no longer
  > a bundle credential: it is a pooled seat, leased to one workflow for that workflow's entire life
  > (`003/FR-023`) and fetched at bootstrap rather than installed by `setup.sh`. Every other clause
  > holds for it too and then some — never baked into an image, never committed, never a platform-wide
  > constant, and never shared with the target repository's automation.
  >
  > The separation is the point of 003 rather than a side effect of it: a setup bundle answers _what
  > machine setup does this client's work need_, and an agent credential answers _which agent identity
  > performs it_. The two vary independently, so three bundles and four credentials should be seven
  > objects rather than twelve.

#### Boundary with existing tooling

- **FR-073**: Sisyphus MUST be scoped to developer-facing, repository-bearing automation. Non-developer
  internal workflows where a non-engineer iterates on prompts (support triage, document QA, retrieval over
  internal knowledge) MUST remain out of scope and stay on the existing low-code workflow tooling. A
  capability request that would move that audience into Sisyphus MUST be specified as a separate product
  rather than absorbed.

#### Executor setup bundles

A **setup bundle** is the unit that turns a bare instance into a worker able to do a specific client's
work. It exists so that onboarding a new client, or changing which credentials a run gets, is a
configuration change rather than a platform change.

- **FR-083**: A setup bundle MUST be stored as a single **gzipped tar archive** in private object storage,
  with an executable **`setup.sh` at the archive root** as its entry point. The archive MAY contain any
  supporting files that script needs.
- **FR-084**: Setup bundle archives MUST be stored encrypted, MUST NOT be publicly reachable, and MUST be
  readable only by the control plane and by an executor presenting a workflow-scoped credential whose
  workflow references that bundle.
- **FR-085**: Each bundle MUST be registered as a record in the platform database carrying at least: a
  human-readable name, a description, the archive's storage reference, its version or content digest, who
  registered it, when, and whether it is enabled.
- **FR-086**: The admin panel MUST allow a user holding the **admin role** to register a new bundle, upload or
  replace its archive, edit its metadata, enable and disable it, and see which workflows and integrations
  reference it (FR-167, FR-168). Any authenticated user MUST be able to _see_ the list of enabled bundles, since
  selecting one is part of creating an execution profile.
- **FR-087**: On bootstrap the executor MUST download the bundle its job references, verify the archive
  against the registered digest, unpack it, and execute `setup.sh` to completion **before** any agent work
  begins.
- **FR-088**: A bundle whose archive is missing, fails digest verification, lacks an executable `setup.sh`
  at its root, or whose `setup.sh` exits non-zero MUST fail the workflow during bootstrap with an explicit
  bundle-setup failure naming the bundle and the failing step. The agent MUST NOT be started.
- **FR-089**: Output produced while running `setup.sh` MUST be captured and redacted to the same standard as
  run output, so a bundle that echoes a credential cannot leak it into the log.
- **FR-090**: Bundle archives MUST be immutable once registered: replacing a bundle's contents MUST create
  a new version rather than mutate the existing one, so a historical workflow's setup remains
  reconstructable.
- **FR-091**: Every workflow MUST record which setup bundle and which bundle version it ran with.
- **FR-092**: A bundle that is referenced by any integration or non-terminal workflow MUST NOT be deletable;
  it MUST be disabled instead, and disabling MUST NOT affect runs already in flight.
- **FR-093**: Whether a per-workflow **spend cap is enforceable** depends on the credential the bundle
  installs. A bundle installing a metered, per-token credential MUST support the caps in FR-055; a bundle
  installing a flat-rate seat credential MUST declare that spend caps are not enforceable under it, and the
  panel MUST show that limitation wherever a cap is set for a job using that bundle.

#### Workspaces

A **workspace** is the named set of repositories a run works on, checked out side by side into one folder.
It exists so that a change spanning several repositories is one run with one conversation, rather than
several runs that cannot see each other's work.

- **FR-109**: A workspace MUST be a named set of one or more **entries**, each declaring a repository, the
  base branch to check out, and the subdirectory it is checked out into beneath the pinned workspace root. A
  single-entry workspace MUST be expressible and MUST remain the simple, common case.
- **FR-110**: Exactly one entry MUST be designated **primary**. The primary entry's `sisyphus-*` skills
  govern the run, and its conventions apply where a convention is workspace-wide.
- **FR-111**: Entry subdirectories MUST be unique within a workspace and MUST resolve inside the workspace
  root; a configuration whose paths collide or escape the root MUST be rejected at validation. The workspace
  root remains the single pinned, snapshot-able tree required by FR-051.
- **FR-112**: The executor MUST check out every entry at its declared branch into its declared subdirectory
  **before** any agent work begins. If any entry fails to check out, the workflow MUST fail explicitly naming
  that entry; it MUST NOT start the agent against a partial workspace.
- **FR-113**: The agent's working directory MUST be the workspace root, so a single session can read and
  change files across every entry.
- **FR-114**: A workflow MUST record the resolved commit of every entry at checkout time. Base-branch
  staleness (FR-079) MUST be evaluated and recorded **per entry**.
- **FR-115**: A workflow MUST support producing **at most one pull request per entry**, recorded as a set with
  the entry each belongs to. Every requirement written in terms of "the resulting pull request" MUST apply to
  each pull request in that set.
- **FR-116**: Where a workflow produces more than one pull request, they MUST share the branch name derived
  from the primary entry's skills, and each MUST cross-reference the others so a reviewer can see the whole
  set from any one of them.
- **FR-117**: The order in which cross-repository pull requests are merged or promoted MUST be defined by the
  primary entry's `sisyphus-integration` skill, never by Sisyphus.
- **FR-118**: Where changes land for some entries and fail for others, the workflow MUST record a per-entry
  result and MUST reach a terminal outcome that states the partial state. It MUST NOT report plain success.
- **FR-119**: A review workflow over a multi-entry workflow MUST evaluate the pull request set together and
  record one verdict, with each finding anchored to entry, file and line.
- **FR-120**: Two non-terminal workflows MUST NOT hold the same repository and branch concurrently, evaluated
  across every entry of their workspaces; the conflict MUST be refused or serialised with the holding
  workflow named.

#### Execution profiles

An **execution profile** is a reusable launch preset. It exists to remove the per-launch burden of choosing
values an engineer has no basis to choose — instance size, caps, which setup bundle — and to make repeat
runs a one-field operation.

- **FR-121**: An execution profile MUST be a named, versioned preset carrying: the workspace, the model, the
  instance size, the interruptible-capacity preference, the turn cap, the spend cap, the setup bundle, the
  default workflow type, an **optional prompt preamble** (FR-157), a description, and its enabled state.
- **FR-122**: When a user selects an execution profile on the launch form, every value it carries MUST be
  prefilled, and the run MUST be startable **without the user supplying anything but the prompt**.
- **FR-123**: A user MUST be able to override an individual prefilled value for one run, unless the profile
  marks that field as locked. Every override MUST be recorded on the workflow alongside the profile it
  derived from, so a run's configuration is explicable.
- **FR-124**: An execution profile MUST NOT be enableable until validation confirms that its setup bundle is
  enabled, and that every workspace entry's repository and base branch are reachable with the credentials
  available. This validation is what prevents a run being launched with a setup bundle that does not match
  its repositories.
- **FR-125**: Execution profiles and workspaces MUST be versioned: editing either creates a new version
  rather than mutating the existing one, and an in-flight workflow MUST be unaffected by an edit.
- **FR-126**: A workflow MUST record which execution profile and profile version it was launched from, or that
  it was launched ad hoc without one.
- **FR-127**: The panel MUST allow an **admin** to create, edit, clone, enable and disable workspaces and
  execution profiles, to grant and revoke user access to a profile, and to see which integrations and recent
  workflows reference each (FR-184, FR-185).
- **FR-128**: A workspace or execution profile referenced by an integration or a non-terminal workflow MUST NOT
  be deletable; it MUST be disabled instead, and disabling MUST NOT affect runs already in flight.
- **FR-129**: Launching ad hoc — without an execution profile — MUST remain possible **for an admin** (FR-187),
  and MUST offer saving the entered configuration as a new execution profile.

#### Integrations

An **integration** is a configurable connector that discovers work in an external system and starts
workflows for it. Several may be configured and enabled at once — one per Jira board, for example — each
with its own credentials, filters, schedule and setup bundle.

- **FR-094**: The platform MUST support multiple independently-configured integrations existing and running
  concurrently, each with its own configuration, schedule and enabled state.
- **FR-095**: **Jira is the only integration type implemented** by this feature. The construct MUST be
  extensible to further types without reworking the integration model, but no second type is in scope.
- **FR-096**: A Jira integration's configuration MUST capture at least: a name, the Jira base URL, its API
  credential, the project key or prefix to scope to, the **label that marks a ticket for autonomous
  delivery**, any additional filtering criteria (e.g. status or issue type), one or more **execution profile
  mappings** (FR-130), a **prompt intro** (FR-158), a default owner (FR-133), its timezone (FR-155), its
  **schedule expressed as a cron expression**, and whether it is enabled. It MUST NOT restate the repository,
  branch, model, caps or setup bundle — those come from the execution profile it resolves to.
- **FR-130**: An integration MUST resolve each matched ticket to an execution profile through an **ordered list
  of mappings**, each pairing filter criteria (for example a Jira component, issue type, or label) with an
  execution profile. The first matching mapping MUST win, a default mapping MAY be declared as the last
  entry, and a ticket matching no mapping MUST be skipped with the reason recorded rather than started under a
  guessed profile.
- **FR-131**: The mapping that resolved a ticket MUST be recorded on the resulting workflow, so why a run got
  the repositories and settings it did is explicable after the fact.
- **FR-097**: The admin panel MUST allow an **admin** to create, edit, enable, disable, delete and
  manually trigger an integration (FR-186), and MUST validate its configuration — including a connectivity check
  against the external system — before it is enabled.
- **FR-098**: An integration's credential MUST be stored encrypted, MUST be write-only from the panel's
  perspective (never rendered back after saving), and MUST NOT appear in logs or integration run records.
- **FR-099**: Integration schedules MUST run on the **backend control plane**, not on the network-facing
  panel and not on an executor instance.
- **FR-100**: Schedules MUST be registered from the stored configuration, and MUST be **re-registered
  whenever an integration's schedule or enabled state changes** — created on enable, updated on change,
  removed on disable or delete — so the registered schedules and the database never diverge.
- **FR-101**: On a scheduled tick an integration MUST query the external system for items matching its
  filters, and MUST start one workflow per newly-matched item using the execution profile that item resolved
  to (FR-130) — inheriting its workspace, setup bundle, model, instance size and caps.
- **FR-102**: An integration MUST NOT start a second workflow for an item it has already started one for,
  even across restarts or overlapping ticks. Each item MUST be claimed exactly once.
- **FR-103**: If a scheduled run is still in progress when the next tick is due, the tick MUST be skipped or
  coalesced rather than run concurrently, and the skip MUST be recorded.
- **FR-104**: Where two enabled integrations match the same item, exactly one workflow MUST be started and
  the ambiguity MUST be recorded, so overlapping board configurations cannot double-spend. Which integration
  wins MUST be deterministic and stated in the record — it MUST NOT depend on tick timing.
- **FR-105**: Each integration run MUST be recorded with its start and end time, the trigger (scheduled or
  manual), how many items were examined, matched, started and skipped, and any error — and that history MUST
  be visible in the panel so a silently-failing connector is detectable.
- **FR-106**: An integration MUST record consecutive failures and MUST auto-disable itself after a
  configurable threshold, surfacing the reason, rather than retrying a broken configuration indefinitely.
- **FR-107**: An integration MUST enforce a configurable ceiling on how many workflows it may start per tick
  and per rolling period, so a bulk label application cannot provision unbounded paid compute.
- **FR-108**: An external system being unreachable on a tick MUST be recorded as a failed integration run and
  retried on the next tick; it MUST NOT start partial workflows or lose an item that still matches.

#### Ownership & notifications

Every workflow belongs to a person, and that person is told when it needs them. Without this, supervision
requires someone to be watching, which defeats the purpose of delegating.

- **FR-132**: Every workflow MUST have exactly one **human owner**. For a manually-started workflow the owner
  is the initiating user. For an integration-started workflow the owner MUST be the resolved ticket's assignee
  where one exists, and otherwise the integration's declared default owner.
- **FR-133**: An integration MUST declare a default owner and MUST NOT be enableable without one, so no
  autonomous workflow can exist unowned.
- **FR-134**: A workflow's owner MUST be reassignable, recorded with who reassigned it and when.
- **FR-135**: The panel MUST provide a needs-attention view scoped to the signed-in user's owned workflows, so
  a person can see what is waiting on them without filtering the whole fleet.
- **FR-136**: The platform MUST notify a workflow's owner by **Slack direct message** when it reaches a
  terminal outcome, and when it enters needs-attention, capped or parked-resumable, and when a review
  iteration within an autonomous run fails. **Slack direct message is the only notification channel in scope.**
- **FR-137**: A notification MUST state the workflow, its ticket, its workspace, the state reached, the reason,
  and consumption to date, and MUST link directly to the workflow detail view.
- **FR-138**: Users MUST be able to set per-event notification preferences, and MUST be able to watch a
  workflow they do not own in order to receive its notifications. These are two distinct surfaces: per-event
  preferences MUST be set on an account-level **notification settings screen**, reachable from the
  application shell (FR-193), which MUST also show whether the user's Slack identity resolved and surface the
  unnotifiable state from FR-140; watching MUST be a **Watch / Unwatch control on the workflow detail view**,
  offered for any workflow the requester is permitted to see (FR-190) and not only ones they own.
- **FR-139**: Notifications MUST be coalesced and rate-limited so one workflow cannot produce a burst of
  messages, and an integration tick that starts many workflows MUST produce one summary rather than one message
  per workflow.
- **FR-140**: The Slack recipient MUST be resolved from the user's organisation identity. A user with no
  resolvable Slack identity MUST be recorded as unnotifiable, surfaced in the panel, and MUST NOT cause the
  workflow to fail.
- **FR-141**: Every notification attempt MUST be recorded against the workflow with its event, recipient,
  outcome and time. A delivery failure MUST NOT alter the workflow's own state or outcome.
- **FR-142**: On starting a workflow for a ticket, the platform MUST comment on that ticket identifying the
  workflow and linking to it, so the ticket shows that Sisyphus has taken it.
- **FR-143**: Where a ticket matches an integration's filters but no workflow is started — no execution profile
  mapping matched, a ceiling was reached, or the integration is disabled — the reason MUST be recorded and
  communicated on the ticket. A labelled ticket MUST NOT be silently ignored. An already-claimed ticket is
  exempt, since it was commented on when first claimed.
- **FR-144**: On reaching a terminal outcome the platform MUST comment on the ticket with that outcome and links
  to every resulting pull request. Ticket comments MUST be idempotent per FR-077.

#### Bootstrap observability & bundle validation

- **FR-145**: Bootstrap MUST be reported as named, ordered phases — provisioning, bundle download and
  verification, unpack, setup script, per-entry checkout, agent start — each with its own start, end and
  outcome, visible live in the panel. A user MUST never face an opaque "provisioning" state of unknown
  duration.
- **FR-146**: Each bootstrap phase MUST carry its own timeout. A phase exceeding it MUST fail the workflow
  naming that phase, rather than holding a paid instance indefinitely.
- **FR-147**: The platform MUST support a **validation run** of a setup bundle: provision, download, verify,
  unpack, execute `setup.sh`, capture redacted output, report per-phase results and tear down — **without**
  starting the agent and without requiring a ticket, workspace or prompt. This is how a bundle is proven
  before anyone depends on it.
- **FR-148**: A validation run MUST be recorded against the setup bundle and version with its outcome and
  captured output, and the panel MUST show each bundle's most recent validation result.

#### Continuation & successor workflows

- **FR-149**: A workflow's job specification MUST remain immutable for its lifetime, so a completed run is
  always reproducible from its record.
- **FR-150**: Continuing a workflow **with changed configuration** — most commonly a raised spend or turn cap
  after budget exhaustion, or a different model — MUST create a **successor workflow** that inherits the
  predecessor's current session snapshot and workspace, carries its own job specification, and links to its
  predecessor. The predecessor MUST remain terminal and unmodified.
- **FR-151**: Continuing a workflow **without** configuration change MUST resume the same workflow (FR-053)
  rather than creating a successor.
- **FR-152**: A successor chain MUST be traversable in both directions in the panel, and consumption MUST be
  reportable both per workflow and summed across the whole chain, so the true cost of a piece of work is
  visible.

#### Review handoff, scheduling usability & cost presentation

- **FR-153**: Every workflow MUST produce a final summary written **for the reviewer**: what changed and where
  (per workspace entry), the decisions and assumptions it made, what it deliberately did not do, and where it
  was uncertain. It MUST be shown in the panel and included in the description of every pull request it opened.
- **FR-154**: Schedule configuration MUST offer named presets (for example every 15 minutes, hourly, daily at a
  chosen time) with a raw cron expression available as an escape hatch, and MUST show a plain-language readback
  and the next five fire times before the schedule can be saved.
- **FR-155**: Each integration MUST carry its own timezone and its schedule MUST be evaluated in that timezone,
  with daylight-saving transitions handled so a wall-clock schedule stays at its wall-clock time.
- **FR-156**: Spend MUST be recorded per workflow and remain fully attributable, but the panel's **default**
  aggregation MUST be by client, workspace or execution profile rather than by individual. Per-user totals MUST
  be visible to that user and to admins, and MUST NOT be presented as a ranked comparison between individuals.

#### Users, roles & administration

Exactly two roles exist, because only one action needs a gate narrower than domain membership: registering a
setup bundle, which carries client credentials and runs arbitrary shell with the instance's privileges.

- **FR-166**: The platform MUST define exactly two roles: **engineer** and **admin**. Every authenticated user
  holds at least the engineer role.
- **FR-167**: **Registering, uploading, replacing or versioning a setup bundle MUST require the admin role.** A
  non-admin attempting it MUST be refused with the reason stated, and the attempt MUST be recorded.
- **FR-168**: Enabling and disabling a setup bundle MUST also require the admin role, since either changes what
  credentials future runs receive.
- **FR-169**: **All configuration is admin-only.** Registering setup bundles (FR-167), creating and editing
  workspaces and execution profiles, creating and editing integrations, granting and revoking access, and
  managing users MUST all require the admin role. What an engineer does is **launch and supervise work within
  the execution profiles granted to them** (FR-179..FR-191). Where an earlier requirement says "an authorised
  user" or "an authorised administrator", it means a user holding the admin role.
- **FR-170**: A user MUST be created automatically on first successful sign-in, with the engineer role, so no
  invitation step is needed for a member of a permitted domain.
- **FR-171**: The platform MUST provide an **admin-only user management** surface listing every known user with
  their identity, role, active state, last sign-in, and the workflows they own.
- **FR-172**: An admin MUST be able to grant and revoke the admin role, and MUST be able to deactivate and
  reactivate a user.
- **FR-173**: The platform MUST refuse any change that would leave it with **zero active admins**, including an
  admin revoking or deactivating themselves.
- **FR-174**: At least one admin MUST be established at deployment from configuration, so the first admin exists
  without requiring an admin to create them.
- **FR-175**: A deactivated user MUST be denied access at their next request without waiting for a session to
  expire, and a role change MUST take effect on the user's next request rather than at next sign-in.
- **FR-176**: Deactivating a user MUST NOT delete their history. Workflows they own MUST be flagged for
  reassignment (per the ownership rules in FR-132..FR-134) and their past workflows, corrections and
  configuration changes MUST remain attributed to them.
- **FR-177**: Every role grant, role revocation, activation and deactivation MUST be recorded with the acting
  admin, the affected user, the change and the time, and that history MUST be viewable and MUST NOT be editable
  or deletable.
- **FR-178**: Every setup bundle registration, replacement, enable and disable MUST likewise be recorded with the
  acting admin, the bundle and version affected, and the time.

#### Access control

The **execution profile is the unit of access control**. It is the natural one: it already names the workspace,
the model, the instance size, the caps and the setup bundle, so granting someone a profile grants exactly "you
may do this kind of work, on these repositories, with these credentials, at this cost".

- **FR-179**: Each execution profile MUST carry a set of **granted users**. Access is granted per profile, not
  per repository, workflow or client.
- **FR-180**: A non-admin MUST be able to launch workflows **only** on execution profiles granted to them. A
  launch against a profile they do not hold MUST be refused and recorded.
- **FR-181**: A non-admin MUST be able to see **only** those workflows that ran on execution profiles granted to
  them, plus any workflow they initiated or own regardless of grant (FR-189).
- **FR-182**: A non-admin MUST be able to supervise — pause, correct, resume, stop — exactly those workflows they
  can see under FR-181, and no others.
- **FR-183**: An admin MUST be able to see, launch and supervise across **all** execution profiles and all
  workflows, without needing a grant.
- **FR-184**: Granting and revoking profile access MUST require the admin role and MUST be recorded with the
  acting admin, the affected user, the profile and the time.
- **FR-185**: Creating and editing workspaces and execution profiles MUST require the admin role. A non-admin
  able to edit either could point a profile they hold at a repository or setup bundle they were never granted,
  which would defeat the access model entirely.
- **FR-186**: Creating, editing, enabling, disabling, deleting and manually triggering an integration MUST
  require the admin role, because an integration spends money unattended on behalf of everyone.
- **FR-187**: Launching **ad hoc** — supplying a workspace, model, instance size, caps and setup bundle directly
  rather than selecting a profile — MUST require the admin role, since it is equivalent to using an unnamed
  profile and would otherwise bypass FR-180.
- **FR-188**: Revoking a user's access MUST NOT affect workflows already in flight that they own or initiated,
  MUST NOT remove their historical attribution, and MUST take effect for new launches at their next request.
- **FR-189**: A user MUST always be able to see, supervise and be notified about a workflow they **own or
  initiated**, even without access to its execution profile. Being accountable for a run and unable to act on it
  is not an acceptable state.
- **FR-190**: Every list, filter, search, log view, notification and aggregate spend figure MUST be scoped to
  what the requester is permitted to see. A workflow outside that scope MUST NOT be disclosed — **including its
  existence**, so counts and totals MUST NOT leak it either.
- **FR-191**: Ownership MUST NOT require profile access: an integration's default owner, or a resolved ticket
  assignee, MAY own workflows on a profile they do not hold. Ownership confers per-workflow rights under FR-189,
  never profile-wide access.
- **FR-192**: Each integration type MUST be delivered as its own standalone package
  (`packages/sisyphus-integration-<type>`) implementing a connector contract owned by `sisyphus-api`. No
  integration package may import another, and adding a second type MUST require no change to `sisyphus-api`,
  the control plane or the panel beyond registering the new package. Only the Jira type is in scope
  (FR-095).

#### Prompt assembly

A workflow's prompt is **layered**, and each layer belongs to whoever knows that thing: the execution profile
carries standing context about the codebase, the integration carries standing context about how work arrives
from its board, and the ticket carries the actual task. Nobody has to restate what another layer already says.

- **FR-157**: An execution profile MAY carry an **optional prompt preamble**: supporting context about the
  workspace it targets — standing information every run against those repositories should have, such as where a
  contract lives or which conventions the codebase follows. It MUST be prepended to the prompt of every workflow
  launched with that profile, whether started manually or by an integration, and MUST NOT serve as a substitute
  for the task description.
- **FR-158**: An integration MUST carry a **prompt intro**: free text describing how work from this board should
  be approached, prepended to every prompt the integration generates.
- **FR-159**: The prompt for an integration-started workflow MUST be assembled in this **deterministic order**:
  1. the execution profile's prompt preamble, where present;
  2. the integration's prompt intro;
  3. the ticket's title;
  4. the ticket's URL;
  5. the ticket's description (body);
  6. the ticket's comments, oldest first.

  The order MUST be identical across runs, and each part MUST be delimited so the agent can tell the standing
  context apart from the ticket content.

- **FR-160**: The configuration interface MUST state explicitly which ticket fields are appended — title, URL,
  description and comments — so an author writing a prompt intro or preamble does not restate them, and MUST
  offer a preview of the assembled prompt for a sample ticket before the integration is enabled.
- **FR-161**: Comments authored by Sisyphus itself (FR-142, FR-143, FR-144) MUST be excluded from the assembled
  prompt, so the platform's own write-back cannot feed back into a later run's input.
- **FR-162**: The fully assembled prompt **as sent** MUST be recorded on the workflow. Ticket titles,
  descriptions and comments change after the fact, so the record of what the agent was actually asked MUST NOT
  depend on re-reading the ticket.
- **FR-163**: Assembled prompt content MUST be redacted to the same standard as run output before it is stored,
  and MUST be bounded. Where ticket content exceeds the bound, comments MUST be dropped oldest-first, the
  truncation MUST be recorded, and the title, URL and description MUST never be truncated away.
- **FR-164**: A ticket whose title and description are both empty MUST be skipped with the reason recorded and
  communicated on the ticket (FR-143), rather than started with a prompt carrying no task.
- **FR-165**: For a manually-started workflow the engineer's own prompt takes the place of the integration intro
  and ticket content, and the execution profile's preamble MUST still be prepended.

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
  and the setup bundle and its version.
- **Job Specification** — the immutable input to a workflow: the **fully assembled prompt as sent** together with
  the layers it was composed from, model, workspace, instance class, interruptible-capacity preference, turn cap,
  spend cap, the **setup bundle reference** that supplies its credentials and tooling, and an optional session
  reference to resume.
- **Assembled Prompt** — the exact text the agent was asked, recorded as sent: the execution profile's preamble,
  the integration's prompt intro, and the ticket's title, URL, description and comments in defined order, with
  Sisyphus-authored comments excluded, secrets redacted, and any oldest-first comment truncation noted.
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
- **User** — an authenticated Bluetel identity: directory identity, display name, **role** (engineer or admin),
  **active state**, last sign-in, the workflows they own, and the configuration changes attributed to them.
  Created automatically on first sign-in with the engineer role.
- **Role Change** — one grant, revocation, activation or deactivation: the acting admin, the affected user, the
  change, and the time. Append-only; never edited or deleted.
- **Profile Access Grant** — one user's access to one execution profile: the user, the profile, the granting
  admin, and the time granted or revoked. The unit that determines what a non-admin may launch and see.
- **Configuration Audit Entry** — one recorded change to a setup bundle's registration, contents or enabled
  state: the acting admin, the bundle and version affected, the action, and the time. Append-only.
- **Skill Reference** — the identity and resolved content version of a `sisyphus-*` skill used by a run.
- **Setup Bundle** — a named, versioned, immutable bootstrap bundle: a gzipped tar archive with an
  executable `setup.sh` at its root, held in private encrypted storage. Carries name, description, storage
  reference, content digest, version, registering user, registration time, enabled state, whether the
  credential it installs makes spend caps enforceable, and the workflows and integrations referencing it.
- **Integration** — a configurable connector that discovers work externally and starts workflows for it.
  Carries type (Jira for now), name, base URL, encrypted credential, project prefix, the label marking a
  ticket for autonomous delivery, additional filters, its ordered **execution profile mappings**, its **prompt
  intro**, its default owner, its timezone, a cron schedule, per-tick and rolling-period ceilings, enabled
  state, and consecutive-failure count. It does **not** carry a repository, branch, model, caps or setup bundle —
  those come from the execution profile a ticket resolves to. Several may be enabled at once.
- **Integration Run** — one execution of an integration's schedule: start and end time, trigger (scheduled
  or manual), counts of items examined, matched, started and skipped, the workflows it started, and any
  error. The history that makes a silently-failing connector detectable.
- **Workspace** — a named, versioned set of repository entries checked out side by side into one pinned root.
  Carries name, description, its entries, which entry is primary, enabled state, and the execution profiles
  referencing it. A single-entry workspace is the common case.
- **Workspace Entry** — one repository within a workspace: the repository, its base branch, the subdirectory it
  occupies beneath the workspace root, and whether it is the primary entry whose skills govern the run. Per
  workflow it additionally carries its resolved commit, whether it was changed, its pull request, and its
  per-entry result.
- **Execution Profile** — a named, versioned launch preset **and the unit of access control**: the workspace,
  model, instance size, interruptible-capacity preference, turn and spend caps, setup bundle, default workflow
  type, optional prompt preamble, which fields are locked against override, its **set of granted users**,
  description, enabled state, and the integrations and workflows referencing it.
- **Profile Override** — one per-run deviation from the execution profile a workflow was launched with: the
  field, the profile's value, the value used, and who set it.
- **Integration Mapping** — one ordered rule within an integration pairing filter criteria (component, issue
  type, label) with an execution profile, with the first match winning and an optional default last.
- **Notification** — one delivery attempt to a person about a workflow: the event that triggered it, the
  recipient, the channel (Slack direct message), the outcome, and the time. Never load-bearing for the
  workflow's own state.
- **Notification Preference** — one user's choice, per notification event, of whether to be notified. Held
  against the user, defaulted so a user who has never opened the settings screen is still notified about
  their own runs, and readable alongside whether their Slack identity resolved (FR-140).
- **Workflow Watcher** — one user's subscription to one workflow they do not own, created and removed from
  the workflow detail view. Grants notifications only; it confers no supervision rights and MUST NOT widen
  what the user may see beyond their existing scope (FR-190).
- **Bootstrap Phase** — one named, ordered step in preparing an instance (provisioning, bundle verification,
  unpack, setup script, per-entry checkout, agent start) with its own start, end, outcome and timeout.
- **Validation Run** — a proving run of a setup bundle that stops short of starting the agent: the bundle and
  version, per-phase results, redacted captured output, outcome and time.
- **Reviewer Summary** — the run's account written for whoever reviews it: what changed per entry, decisions and
  assumptions made, deliberate omissions, and remaining uncertainties.
- **Successor Link** — the relationship between a terminal workflow and the workflow that continued it under a
  changed job specification, traversable in both directions and summable for consumption across the chain.

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
  bundle and an integration, with zero changes to any Sisyphus project and zero redeploys.
- **SC-021**: 100% of workflows record the setup bundle and its version they ran with, and a completed
  workflow's bootstrap remains reconstructable for the full retention period.
- **SC-022**: Zero credentials installed by a setup bundle appear in any captured setup or run output, across
  a sampled corpus of runs.
- **SC-023**: Zero tickets result in more than one workflow being started for them, measured across all
  integrations and including control plane restarts and overlapping ticks.
- **SC-024**: A bulk label application never causes more workflows to start than the configured per-tick and
  rolling-period ceilings permit, and no matching ticket is permanently dropped.
- **SC-025**: Registered schedules match enabled integration configuration 100% of the time — no orphaned
  schedule fires for a disabled or deleted integration, and no enabled integration lacks a schedule.
- **SC-026**: A broken integration is detectable from the panel within one scheduled interval of its first
  failure, and auto-disables within the configured consecutive-failure threshold.
- **SC-027**: Starting a run from an execution profile requires the engineer to supply **only a prompt**, and
  completes in under 30 seconds of interaction — measured against the eleven-field ad hoc path it replaces.
- **SC-028**: An engineer who has never worked on a given repository can start a correct run against it without
  knowing its instance size, caps or setup bundle, in 100% of cases where an enabled execution profile exists
  for it.
- **SC-029**: Zero workflows run with a setup bundle that does not match their workspace, because no execution
  profile can be enabled until that pairing is validated.
- **SC-030**: 100% of workflows are attributable to either an execution profile and version or an explicit ad
  hoc launch, with every per-run override recorded.
- **SC-031**: For a multi-entry workspace, 100% of changed repositories produce a pull request, unchanged
  repositories produce none, and every pull request in the set is discoverable from any other one.
- **SC-032**: Zero multi-repository runs report plain success while any entry's changes failed to land.
- **SC-033**: A coordinated change across N repositories is delivered by one run with one conversation, with
  zero need to start a separate workflow per repository.
- **SC-034**: A workflow's owner learns it has finished or needs them within 2 minutes of that state being
  reached, **without having the panel open**, for at least 99% of notifiable events.
- **SC-035**: 100% of workflows have exactly one human owner, and zero workflows sit in needs-attention
  unowned.
- **SC-036**: 100% of tickets a workflow is started for receive a comment identifying it, and 100% of tickets
  that matched an integration's filters but were not started receive a comment stating why — no labelled ticket
  is ever silently ignored.
- **SC-037**: Time from launch to first agent output is visible per run and attributable to a named bootstrap
  phase, and no workflow sits in an unexplained preparing state for longer than that phase's timeout.
- **SC-038**: A setup bundle can be proven end to end without starting an agent run, and 100% of registered
  bundles display their most recent validation result.
- **SC-039**: A capped run can be continued with a raised ceiling without losing its session, and the
  total consumption of the resulting chain is reportable as a single figure.
- **SC-040**: 100% of pull requests Sisyphus opens carry a summary stating what changed, the decisions and
  assumptions made, deliberate omissions, and remaining uncertainties.
- **SC-041**: A schedule's next five fire times are visible before it can be saved, and a wall-clock schedule
  does not drift across a daylight-saving transition.
- **SC-042**: Notification failures cause zero changes to workflow outcomes.
- **SC-043**: 100% of workflows record the fully assembled prompt as sent, and that record remains accurate after
  the originating ticket is edited.
- **SC-044**: Zero assembled prompts contain a comment Sisyphus itself authored, and zero contain a value
  matching a known secret pattern.
- **SC-045**: An author configuring an integration can see the assembled prompt for a sample ticket before
  enabling it, and no ticket field is silently omitted from or duplicated in that assembly.
- **SC-046**: Zero setup bundles are registered, replaced, enabled or disabled by a non-admin, and every such
  attempt is recorded.
- **SC-047**: A new member of a permitted domain can sign in and launch a run from an existing execution profile
  with zero provisioning steps by anyone else.
- **SC-048**: The platform can never be left with zero active admins.
- **SC-049**: 100% of role grants, revocations, activations, deactivations and setup bundle registrations are
  attributable to an acting admin with a timestamp, in a history that cannot be edited or deleted.
- **SC-050**: A deactivated user is denied access within one request, and none of their history becomes
  unattributed.
- **SC-051**: Zero workflows are disclosed to a user who holds neither access to their execution profile nor
  ownership of them — including via counts, filters, search results and aggregate spend figures.
- **SC-052**: Zero workflows are launched by a non-admin against an execution profile they do not hold, and every
  such attempt is recorded.
- **SC-053**: 100% of profile access grants and revocations are attributable to an acting admin with a timestamp.
- **SC-054**: A person can always see, supervise and be notified about a workflow they own, in 100% of cases,
  regardless of whether they hold its execution profile.
- **SC-055**: An admin can grant a new engineer everything they need to start working on a client by granting one
  execution profile — no per-repository or per-workflow steps.
- **SC-056**: Every screen the signed-in user is permitted to open is reachable from the application shell in
  three clicks or fewer, from any other screen, without typing a URL — and no link is shown to a screen the
  user's role cannot open.
- **SC-057**: A signed-out visitor reaching any route arrives at the sign-in screen. Zero authentication
  outcomes — unauthenticated, out-of-domain, deactivated, provider failure — produce an unstyled framework
  error page or a 404.
- **SC-058**: A signed-in user can end their session from any screen without leaving it to find the control.
- **SC-059**: A user can change which events notify them, and start or stop watching a workflow they do not
  own, without an administrator.
- **SC-060**: The infrastructure package contains no interface, type alias or parameter whose purpose is to
  stand between a primitive and the resource it creates, and no structural redeclaration of the deployment
  tool's own types — verifiable by inspection, not by judgement.
- **SC-061**: Every project typechecks under `strict` with zero suppressed errors outside the committed
  loosely-checked-file globs, and those globs contain only generated files.
- **SC-062**: Each deployable performs its function when started through the entry point its deployment
  configuration declares — the executor runs a workflow to an outcome, the control plane dispatches its jobs,
  the panel serves its routes. Zero deployables declare a handler that does not resolve.
- **SC-063**: Zero shipped modules are reachable only from their own tests and a barrel. Every exported
  behaviour has a production caller, or it is removed.
- **SC-064**: CI reports zero skipped tests. A pipeline that is green has run every assertion the suite
  contains.
- **SC-065**: Every command a validation guide instructs the reader to run exists and succeeds.

## Assumptions

- **Environment**: One cloud account per stage-isolated deployment, with stages distinguished by resource
  naming. Compute is a general-purpose instance family; the specific class is per-job configuration, not a
  platform constant.
- **Persistence**: A single managed relational database holds workflow state, setup bundle registrations and
  integration configuration; object storage holds logs, session snapshots, artifacts and setup bundle
  archives. The schema is owned exclusively by `sisyphus-api`.
- **Identity, roles and access**: Users are Bluetel Google Workspace identities; there is no self-registration
  and no external or client access. Exactly **two roles** exist — **engineer** (the default, assigned on first
  sign-in) and **admin**. The division is deliberately along a single line: **admins configure, engineers
  consume.** Admins own setup bundles, workspaces, execution profiles, integrations, access grants and users;
  engineers launch and supervise work within the execution profiles granted to them.
- **Execution profile as the access boundary**: Access is granted per execution profile rather than per
  repository, client or workflow, because a profile already bundles exactly the things that matter — which
  repositories, which credentials, which model, and what it may cost. Granting a profile therefore means "you may
  do this kind of work, here, with these credentials, at this cost", which is the sentence a lead actually wants
  to say. The consequence accepted deliberately: an engineer cannot self-serve a new kind of work, so onboarding
  someone onto a new client is an admin action. Ad hoc launching is admin-only for the same reason — it is an
  unnamed profile and would otherwise be a hole straight through the boundary.
- **Ownership is orthogonal to access**: a person can own a workflow on a profile they do not hold — most
  commonly an integration-started run whose ticket assignee they are. Ownership grants rights over that one
  workflow, never over the profile. Being accountable for a run you cannot see or stop is not an acceptable
  state, so FR-189 carves this out explicitly.
- **Not in v1**: per-repository or per-client permissioning finer than a profile, group-based grants, and
  self-service access requests. These are the first things to revisit if the team grows beyond the point where an
  admin granting profiles individually is workable.
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
  Spend caps are only enforceable when the run's setup bundle installs a metered, per-token credential; a
  flat-rate seat credential makes them advisory, and the bundle declares which it is (FR-093).
- **Setup bundles**: A bundle is a gzipped tar archive with an executable `setup.sh` at its root, held in
  private encrypted object storage and registered in the database. The script is a black box to the platform:
  Sisyphus verifies, unpacks and runs it with a bounded timeout, captures and redacts its output, and treats
  a non-zero exit as a bootstrap failure — it does not inspect or validate what the script does internally.
  Archives are assumed to be authored and reviewed by platform administrators, not by end users, and are
  therefore trusted to run with the privileges the instance has. Bundles are immutable once registered;
  changing one creates a new version.
- **Integrations and scheduling**: Work discovery is **poll-based on a cron schedule**, not webhook-driven.
  Matching is evaluated against the item's current state (the label being present now) rather than against a
  received event, which is what makes missed ticks self-healing — the next successful tick picks up anything
  still matching. Each integration carries its own timezone (FR-155), so a board in one region schedules independently of another.
  The claim record that stops a ticket being picked up twice is assumed to live in the platform
  database rather than as state in the external tracker, so it survives a tracker-side change.
- **Integration credentials**: An integration's credential is stored encrypted and is write-only from the
  panel — it can be replaced but never read back. It is distinct from the credentials a setup bundle
  installs on an instance: the integration credential is used by the control plane to discover work, the
  bundle's credentials are used by the executor to do work.
- **Two distinct, deliberately differently-named concepts**: a **setup bundle** is the bootstrap archive that
  installs credentials and tooling on an instance; an **execution profile** is the launch preset describing
  what to work on and with what settings. They are orthogonal — one setup bundle typically serves many
  execution profiles. "Bundle" names the packaged artifact, "profile" names the reusable configuration, and
  the two words MUST NOT be used interchangeably in the schema, the interface or the documentation.
- **Workspaces**: All entries in a workspace are assumed to live on the same repository host and be reachable
  with the same credentials, which the setup bundle installs. Entries are checked out as independent
  repositories side by side — this is not a submodule, subtree or monorepo mechanism, and no attempt is made to
  make a cross-repository change atomic at the version-control level. Ordering and coupling of cross-repository
  merges is skill-defined (FR-117). A single-entry workspace is expected to remain the common case, and the
  multi-entry path must not make it more cumbersome.
- **Execution profiles**: Profiles are authored by whoever knows a client's setup — typically the
  administrator who authored the matching setup bundle (FR-127, FR-185) — and consumed by everyone else. Ad hoc launching stays
  available **to admins** (FR-187) so the profile mechanism never becomes a gate on getting work done, while non-admins
  launch through granted profiles.
- **Prompt assembly**: A prompt is composed of layers owned by different people, deliberately. The execution
  profile's preamble is standing context about the codebase, written by whoever knows the repositories. The
  integration's prompt intro is standing context about how work from that board should be approached, written by
  whoever owns the pipeline. The ticket supplies the task. This keeps standing instructions out of individual
  tickets, and means changing them does not require re-editing any ticket. Ticket comments are included because
  they frequently carry the clarifying detail the description lacks; Sisyphus's own comments are excluded so its
  write-back cannot become its own input. Prompt assembly is a platform concern rather than a skill concern —
  the skills govern what to _do_, the layers govern what the agent is _told_.
- **Notifications**: Bluetel already operates a Slack application capable of messaging people directly, and that
  is the only notification channel in scope. Slack identities are resolved from the user's organisation
  identity. Notification is explicitly **not** load-bearing: a workflow's state, outcome and record are correct
  whether or not anyone was successfully told, so a Slack outage degrades awareness rather than correctness.
- **Ownership**: Owner is a single person, not a group, because the purpose is for exactly one human to feel
  responsible for a stalled workflow. For integration-started work the ticket's assignee is the best available
  signal of who that is, with the integration's default owner as the fallback that guarantees ownership always
  exists.
- **Continuation**: The immutable job specification is preserved deliberately, so raising a cap produces a
  linked successor workflow rather than editing history. This costs a predecessor/successor relationship in the
  model but keeps every completed run reproducible, and gives "run it again from here with a different model"
  the same mechanism for free.
- **Cost presentation**: Spend is fully attributable per workflow and per person, but the default view
  aggregates by client, workspace or execution profile. This is a deliberate choice to avoid the tool becoming
  something engineers avoid because their name sits on a number, while keeping the figures available to the
  person themselves and to admins.
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
  bundle. _(All stories; note FR-093 — a flat-rate seat credential makes per-workflow spend caps
  advisory rather than enforceable.)_
- **Repository host credentials** with the scopes needed for the actions the repository skills instruct
  (clone, push, open and comment on pull requests), packaged into a setup bundle. _(All stories.)_
- **At least one authored setup bundle** per client whose work Sisyphus will do — the archive and its
  `setup.sh` are authored by a platform administrator, not generated by this feature. _(All stories; Story
  7 delivers the mechanism, not the bundles.)_
- **Ticket tracker credentials, project keys, the autonomous-delivery label, and transition names** for each
  client project — the integration configuration and the transitions the skills name. _(Stories 4, 5 and 8.)_
- **A schedule execution mechanism on the control plane** capable of registering and re-registering per
  integration schedules. _(Story 8.)_
- **The existing Bluetel Slack application**, with permission to send direct messages to staff, and a means of
  resolving a Slack identity from an organisation identity. _(Story 11.)_
- **The existing GitHub Actions pipeline configured with federated cloud identity** for each stage, with the
  identity provider created by the production bootstrap before any other stage can deploy. No workflow in the
  repository assumes an AWS role today, so Sisyphus is what introduces OIDC federation to that pipeline.
  _(Deployment of all stories.)_
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
- Submodule, subtree or monorepo tooling. A workspace is independent checkouts side by side; making a
  cross-repository change atomic at the version-control level is not attempted.
- Cross-repository dependency resolution or build orchestration (linking a local frontend against a local
  backend, shared lockfiles). If a client's work needs it, their setup bundle provides it.
- Sharing an execution profile or workspace outside the Bluetel organisation, or per-user private profiles.
- Notification channels other than Slack direct message — no email, no SMS, no browser push, no Slack channel
  posts or threaded conversations, and no acting on a workflow from inside Slack. Notifications link to the
  panel; the panel is where you act.
- Group or team ownership of a workflow. Ownership is a single person by design.
- Editing a completed workflow's job specification in place. Changed configuration produces a successor
  workflow instead.
- Webhook-driven work discovery. Integrations poll on a cron; event-driven entry is a later change.
- Authoring setup bundle archives or their `setup.sh` scripts, and any validation of what those scripts do
  internally beyond verifying the archive and treating a non-zero exit as a bootstrap failure.
- A visual or in-panel editor for building setup bundles; archives are authored outside Sisyphus and
  uploaded.
- Automatic discovery or rotation of the credentials a setup bundle installs.
