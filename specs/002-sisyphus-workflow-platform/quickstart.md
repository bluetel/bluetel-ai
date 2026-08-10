# Quickstart: Validating Sisyphus

**Feature**: `specs/002-sisyphus-workflow-platform` | **Date**: 2026-08-05

Runnable scenarios that prove each slice works end to end. Details live in [data-model.md](./data-model.md) and
[contracts/](./contracts/) — this is the run-and-verify guide, not a design document.

Scenarios are ordered by the plan's [phase sequencing](./plan.md#phase-sequencing). Each states what it proves,
how to run it, and what to check.

---

## Prerequisites

**Workspace**

```bash
nvm use                      # v24.15.0 from .nvmrc
pnpm install --frozen-lockfile
```

**Per-developer AWS** — a personal stage in the shared account. The identity provider is created **once** by the
production bootstrap; every other stage looks it up (R12), so if a bootstrap fails with a message naming the
bootstrap step, that is the cause.

```bash
pnpm nx run sisyphus-admin:bootstrap --configuration=staging   # once per account

# `migrate` takes no configuration: it reads exactly one variable, so pointing it at the wrong
# database is a deliberate act rather than a mistyped flag (FR-010).
SISYPHUS_DATABASE_URL='postgres://…' pnpm nx run sisyphus-api:migrate
```

**The panel's domain.** The two deploy stages are served from the `bluetel.co.uk` hosted zone this account already
holds:

| Stage        | Origin                                   |
| ------------ | ---------------------------------------- |
| `production` | `https://sisyphus.bluetel.co.uk`         |
| `staging`    | `https://staging.sisyphus.bluetel.co.uk` |

No DNS setup is needed — `createPanelDomain` resolves the zone and creates the panel's alias and ACM's validation
records on deploy. The one manual step is **Google OAuth**: add each origin's `/api/auth/callback/google` to the
client's authorised redirect URIs, or sign-in fails on the new domain while the site itself serves fine.

That zone also carries the company's main site and others, which is why the records are created under three
constraints rather than by handing the deployment tool a domain and trusting it:

- **The zone id is pinned.** Given none, the tool's Route 53 adapter searches upwards from the domain for a zone
  containing it. It lands here anyway; pinning makes the target a decision rather than a search result.
- **Only names under `sisyphus.bluetel.co.uk`.** `assertPanelDnsZone` refuses anything else before a record is
  declared. Without it a stage domain typed as `www.bluetel.co.uk` is a valid record in a valid zone, aimed at the
  front page.
- **Create, never replace.** `override` is off, so a name that already exists fails the deploy instead of being
  taken over. The zone is looked up and never declared as a resource, so no stack holds it in state and no
  teardown can remove it or a record this repository did not create.

A deploy stage's origin is **derived from the stage**, not read from the stage configuration: `getPanelUrl` sets
both `NEXT_PUBLIC_SITE_URL` and `SISYPHUS_PANEL_URL`, so the certificate, the DNS record, the Auth.js callback
origin and the Slack link target cannot disagree. Whatever those two keys hold in `/sisyphus/<stage>/admin/env`
is ignored on `staging` and `production`. A personal stage has no domain and still reads both from the parameter.

**The first admin.** Set `SISYPHUS_BOOTSTRAP_ADMIN_EMAILS` to your own address before the first deploy. Without
it there is no admin, and since every route to `admin` requires an existing admin, no configuration can be
performed at all — scenario 1 cannot start (FR-174). Verify a `role_changes` row exists with a `system` actor.

**Local loop**

```bash
pnpm nx run sisyphus-admin:dev          # http://localhost:3003
```

The panel is the only thing with a local dev server, and deliberately so. The control plane has **no inbound
network surface** (FR-035): it is a single handler that EventBridge Scheduler invokes directly, so there is
nothing for a `dev` target to serve. Exercise it through its tests — `pnpm nx run sisyphus-control-plane:test`
— or by deploying it to your own stage.

**A local Postgres, for the database-backed suites.** About a third of the assertions in this feature are
properties of the database rather than of application code — the exactly-once unique index, the branch-lock
advisory lock, the iteration `CHECK`, profile-scoped spend, the skill-digest readback — and they only execute
when `SISYPHUS_TEST_DATABASE_URL` is set. Without it they skip, which is correct on a laptop and a lie in CI, so
CI sets it and the harness **fails** rather than skips when `CI` is set and the variable is not (FR-204,
SC-064). Match CI's engine major, which matches the deployed instance's:

```bash
docker run -d --name sisyphus-pg -p 5432:5432 \
  -e POSTGRES_USER=sisyphus -e POSTGRES_PASSWORD=sisyphus -e POSTGRES_DB=sisyphus \
  postgres:17

export SISYPHUS_TEST_DATABASE_URL='postgres://sisyphus:sisyphus@localhost:5432/sisyphus'
SISYPHUS_DATABASE_URL="$SISYPHUS_TEST_DATABASE_URL" pnpm nx run sisyphus-api:migrate
```

Most suites create and drop a private scratch database of their own, so the URL must point at a server the role
may `create database` on. The migrate step is still needed: the panel's sign-in and log-stream suites assert SQL
against the configured database directly.

**Test scratch repositories** — two, both writable by the platform's repository-host credential:

| Repo                 | Contents                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `sisyphus-scratch-a` | A trivial project, plus `sisyphus-dev`, `sisyphus-review`, `sisyphus-integration` skills |
| `sisyphus-scratch-b` | A second trivial project, for multi-entry workspace tests                                |

---

## Gate 0 — the spikes

None of the three is a test of Sisyphus; each gated code that could not be written until it closed (research.md
S1, S2, S3). All three are **closed**, and each left behind a harness that is a colocated vitest suite plus a
`SPIKE-FINDINGS.md` next to it — not a one-off script that has since rotted. Re-run them the way any other suite
is re-run, by passing the path to the project's `test` target:

| Spike | Harness                                                      | Findings                                                   |
| ----- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| S1    | `apps/sisyphus-executor/src/agent/spike-stdin.ts`            | `apps/sisyphus-executor/src/agent/SPIKE-FINDINGS.md`       |
| S2    | `apps/sisyphus-executor/src/session/spike-restore.ts`        | `apps/sisyphus-executor/src/session/SPIKE-FINDINGS.md`     |
| S3    | `apps/sisyphus-admin/src/app/api/stream/spike-log-stream.ts` | `apps/sisyphus-admin/src/app/api/stream/SPIKE-FINDINGS.md` |

### S1 — NDJSON turn injection

```bash
pnpm nx run sisyphus-executor:test src/agent/spike-stdin
```

**Passes when:** a candidate user-turn frame written to stdin mid-request changes agent behaviour **before** the
current request completes, and the frame shape is documented.

**If it fails:** adopt the Agent SDK behind the same `AgentAdapter` boundary
([executor-protocol.md](./contracts/executor-protocol.md#agent-adapter-boundary)). That is a decision point, not
a rewrite — which is the whole reason the boundary exists.

### S3 — live-log transport under pooling

```bash
# The pure transport assertions run anywhere. The live scenarios need a real Postgres, and the
# pooled ones a PgBouncer in `pool_mode = transaction` in front of it; each half skips cleanly when
# its URL is absent, so the bare command is green on a machine with neither.
SPIKE_S3_DIRECT_URL='postgres://…' \
SPIKE_S3_POOLED_URL='postgres://…:6432/…' \
  pnpm nx run sisyphus-admin:test src/app/api/stream/spike-log-stream
```

**Passes when:** ≥95% of segments from a ~10/second emitter are visible within 5 seconds, no notifications are
dropped over a 10-minute stream, and a runtime recycle mid-stream reconnects and resumes from the last `sequence`
without a gap (research.md S3, SC-002).

**If it fails:** take one of R6's two fallbacks. The SSE contract and sequence reconciliation are unchanged either
way. This is what happened: `LISTEN` delivers nothing through a transaction-mode pooler, so the first fallback —
in-handler polling of `log_segments` — is what shipped.

### S2 — cross-instance restore

```bash
pnpm nx run sisyphus-executor:test src/session/spike-restore
```

**Passes when:** a snapshot from instance A restores on instance B, `--resume` finds the session, the agent can
answer "what did you change and why", uncommitted work is present, and a deliberately truncated final log line is
discarded with `truncationRepaired` set.

Instance identity is simulated by directory and the pinned root is destroyed in between, so this needs no cloud
resource of any kind — see the findings file for exactly what was and was not simulated.

---

## Scenario 1 — Roles, scoped access, bundle registration (US7 + US12 + US13)

**Proves:** SC-046 – SC-050, SC-029, SC-038, and that FR-190 does not leak.

**Runnable in two parts.** 1a, 1a-bis, 1b's grant and registration steps, 1c and 1e run as soon as Phase 3
lands. **1b's validation run, 1d, 1f and 1g require Phase 4** — a validation run provisions and tears down a
real instance, and the leak and deactivation tests need workflows to exist. Those four are release gates of the
MVP (Phase 4's checkpoint), not deferred requirements: with an empty `workflows` table there is nothing for
FR-190 to disclose.

### 1a. Auto-provisioning and the admin gate

1. Sign in as a permitted-domain user who has never signed in.
2. Attempt to register a setup bundle.

**Check:** a `users` row exists with `role = 'engineer'`, created without any invitation step (FR-170).
Registration is **refused with the reason stated**, and the attempt appears in `configuration_audit` (FR-167,
SC-046).

### 1a-bis. The bootstrap admin exists

Deploy a fresh stage with `SISYPHUS_BOOTSTRAP_ADMIN_EMAILS` set to an address that has **never signed in**.

**Check:** that user can perform admin actions on first sign-in; the promotion is recorded in `role_changes` with a
`system` actor (FR-174, FR-177). Re-deploy and confirm the reconcile is idempotent — no duplicate rows. Remove the
address, redeploy, and confirm the user is **not** demoted: revocation stays explicit.

### 1b. Grant admin, register, validate

1. As an admin, grant the engineer `admin`.
2. Register a bundle whose `setup.sh` writes `/workspace/.marker` and exports a credential.
3. Run a **validation run** against it.

**Check:** the grant appears in `role_changes` with actor, subject and time (FR-177). The bundle is stored
encrypted and privately, with a content digest and version (FR-084, FR-085). The validation run reports
per-phase results and **no agent started** (FR-147). The panel shows the bundle's latest validation result
(FR-148, SC-038).

### 1c. Bundle failure modes

Register three deliberately broken bundles: digest mismatch, no `setup.sh` at root, `setup.sh` exiting 1.

**Check:** each fails at the **named phase** with a bundle-setup failure and the agent never starts (FR-088).
Compare against [setup-bundle.md](./contracts/setup-bundle.md#archive-format).

### 1d. Redaction of setup output

Register a bundle whose `setup.sh` echoes its credential.

**Check:** the stored output contains no credential (FR-089, SC-022).

### 1e. Never-zero-admins

As the only active admin, attempt to revoke your own admin role, then to deactivate yourself.

**Check:** both refused (FR-173, SC-048). Attempt them concurrently from two sessions — the transaction re-counts
inside the lock, so **both** cannot succeed.

### 1f. Profile-scoped access — the leak test

1. Create two execution profiles, `client-a` and `client-b`.
2. Grant an engineer only `client-a`.
3. Run workflows on both.
4. As that engineer: list, filter by every dimension, search, and open the spend summary.

**Check:** only `client-a` runs appear. **No count, aggregate spend figure, filter result or search result
reveals that a `client-b` workflow exists** (FR-190, SC-051). Requesting a `client-b` workflow by id returns
`NOT_FOUND`, not `FORBIDDEN` — `FORBIDDEN` confirms existence
([api-surface.md](./contracts/api-surface.md#error-mapping)).

5. Attempt to launch against `client-b`.

**Check:** refused and recorded (FR-180, SC-052).

6. Assign that engineer **ownership** of a `client-b` workflow.

**Check:** they can now see and supervise **that one workflow** without gaining `client-b` access (FR-189,
SC-054).

### 1g. Deactivation

Deactivate a user who owns a running workflow.

**Check:** denied at their **next request**, not at next sign-in (FR-175, SC-050). The workflow is flagged
`needs_reassignment` (FR-176). Their history stays attributed to them.

---

## Scenario 2 — Delegated run, end to end (US1)

**Proves:** SC-001, SC-002, SC-007, SC-009, SC-037, SC-040.

**Run it by hand, from the panel on your own stage.** There is no `e2e` target and deliberately none: this
scenario provisions a real instance, pushes a real branch and opens a real draft pull request, so it cannot run
without stage credentials, and a target that fails for everyone who has not deployed is worse than no target.
The scripted parts of it are the control plane's own suites (`pnpm nx run sisyphus-control-plane:test`), which
cover admission, provisioning and teardown against a real database; what is left below is the part only a
deployed stage can prove.

Launch a delegated workflow against `sisyphus-scratch-a` with the prompt "add a CHANGELOG entry for an
unreleased version". In Phase 4 that launch is the **admin-only ad hoc path** (T064a) — execution profiles, and
with them the non-admin launch route, arrive in Phase 5 (Scenario 3).

**Check:**

| Expectation                                                                                  | Requirement    |
| -------------------------------------------------------------------------------------------- | -------------- |
| Bootstrap phases appear individually with their own timings — never an opaque "provisioning" | FR-145, SC-037 |
| Live output appears in the panel within 5s of production                                     | FR-046, SC-002 |
| Output contains no ANSI escapes, spinner frames or cursor movement                           | FR-045, SC-013 |
| A **draft** PR exists on a new branch                                                        | FR-060, SC-009 |
| No ticket transition was attempted                                                           | FR-060, SC-009 |
| A reviewer summary exists, stating decisions, assumptions, omissions and uncertainties       | FR-153, SC-040 |
| Turns and spend are recorded against both caps                                               | FR-055         |
| The instance is gone within 10 minutes of terminal                                           | FR-038, SC-007 |
| The full log is readable **after** the instance is gone                                      | FR-046, SC-012 |
| The workflow reached exactly one terminal outcome                                            | FR-064, SC-006 |

### 2a. Provisioning failure

Launch with an instance type unavailable in the region.

**Check:** the constraint is reported, no instance is left running, and no substitution was made silently
(FR-036, FR-149).

### 2b. Leak sweep — both directions

1. Terminate an instance out-of-band while its workflow is running.
2. Separately, create a tagged instance with no live workflow.

**Check:** the reconciler moves the orphaned **workflow** to resumable or failed with the reason recorded, and
terminates the orphaned **instance** (FR-039, SC-005).

### 2c. Cap enforcement

Launch with `turnCap = 2` and a task needing more.

**Check:** stops at the next safe boundary, `capped`, work preserved, consumption reported (FR-055,
SC-010).

### 2d. Admission under the concurrency ceiling

Set the ceiling to 1. Launch two workflows.

**Check:** the second stays `queued` with a queue position rather than provisioning; it is **not** failed; it
admits automatically when the first releases its lease (FR-040).

### 2e. Duplicate launch

Submit `start` twice concurrently for the same workflow.

**Check:** exactly one compute lease exists and one instance is provisioned; the second call returns the same
workflow rather than an error (FR-078).

### 2f. Snapshot boundary with storage unreachable

Deny the instance's access to the snapshot bucket, then pause.

**Check:** the run **parks and retries** — the agent holds at its turn boundary, no further turns are consumed,
the panel says it is waiting on storage rather than showing a stalled pause, and the heartbeat continues. On
retry-budget exhaustion it fails naming the boundary it could not persist — never silently continuing
unsnapshotted (FR-082).

---

## Scenario 3 — Execution profiles (US9)

**Proves:** SC-027 – SC-030.

1. Create a profile carrying workspace, model, instance type, purchase mode, caps and bundle.
2. Launch supplying **only a prompt**.

**Check:** the run used every profile value, and the workflow records profile + version (FR-122, FR-126,
SC-027). Time the interaction: under 30 seconds (SC-027).

3. Override the model on a second run.

**Check:** both the override and the originating profile are recorded (FR-123, SC-030).

4. Mark `model` locked; attempt to override.

**Check:** refused with the reason shown — not silently ignored (FR-123).

5. Attempt to enable a profile whose bundle is disabled, then one whose workspace version holds no repositories.

**Check:** both refused **naming the failing element** (FR-124, SC-029). Then enable a profile naming a
repository that does not exist: it **succeeds**. Reachability is not checked at enable time
(`specs/004-remove-reachability-gate`); a bad repository fails at `entry_checkout` instead, naming the entry.

6. As a non-admin, attempt an ad hoc launch.

**Check:** refused — ad hoc is admin-only, because it would otherwise bypass profile scoping (FR-187).

---

## Scenario 4 — Notifications and ownership (US11)

**Proves:** SC-034 – SC-036, SC-042.

1. Launch a run, **close the panel**.

**Check:** a Slack DM arrives within 2 minutes of terminal, stating workflow, ticket, workspace, state, reason
and consumption, and linking to the detail view (FR-137, SC-034).

2. Force a run into `needs_attention`.

**Check:** the owner is notified and it appears in their needs-attention view (FR-135).

3. Point the Slack lookup at an address with no Slack identity.

**Check:** the workflow **proceeds and reaches its outcome normally**; the failure is recorded and the
unnotifiable user surfaced (FR-140, FR-141, SC-042). This is the one that must not break the run.

4. Trigger several rapid transitions on one workflow.

**Check:** notifications are coalesced, not one per transition (FR-139).

5. Disable one event in preferences; have a second user watch a workflow they do not own but can see.

**Check:** the disabled event does not deliver while others still do; a user with no preference row still receives
everything (absence means enabled, not silence); the watcher receives the same events filtered by their own
preferences. Attempting to watch a workflow outside the watcher's scope returns `NOT_FOUND`, and revoking their
grant removes the watch rather than quietly continuing to deliver (FR-138, FR-188, FR-190).

---

## Scenario 5 — Pause and correct (US2)

**Proves:** SC-003, SC-004. **Requires S1.**

1. Launch a long-running prompt.
2. Pause mid-execution.

**Check:** paused within 10 seconds; **no further agent output**; the process is alive (not terminated); a
snapshot exists with **both** state flags — and the snapshot was registered **before** the pause was
acknowledged (FR-049, SC-003).

Confirm the **delivery path**, not just the outcome: a `supervision_commands` row moves `pending` →
`acknowledged`, and the panel shows "paused" only after the executor acknowledged — not on mutation return. Submit
a `pause` and a `stop` in quick succession before either is collected: the `pause` comes back `superseded` and is
never applied.

3. Submit a correction; resume.

**Check:** subsequent output reflects the correction; prior conversation history is intact; the process was never
restarted (FR-044, SC-004).

4. Submit two corrections in quick succession.

**Check:** delivered in `sequence` order, neither dropped (FR-049).

5. Submit a correction to a completed workflow.

**Check:** rejected with an already-finished response, recorded as `rejected` — not accepted and lost (FR-081).

6. Pause and leave idle past the ceiling.

**Check:** snapshotted, compute released, marked **`parked_resumable`** — not failed (FR-050, US2 §4).

7. From two sessions, pause and resume the same workflow concurrently.

**Check:** transitions serialise; the panel shows the actual state (FR-049, FR-081).

---

## Scenario 6 — Resume and successors (US3)

**Proves:** SC-005, SC-008, SC-019, SC-039. **Requires S2.**

1. Run to a snapshot, force-terminate the instance, resume.

**Check:** a fresh instance restores the snapshot; the agent continues the **same** conversation; the working
tree contains the pre-interruption uncommitted work; before/after output reads as one continuous ordered log
(FR-046, SC-019).

2. Run on spot capacity and trigger a reclamation notice.

**Check:** the same `suspend()` path runs as for a manual pause; marked resumable, not failed (FR-054, SC-008).

3. Take a `capped` run and continue it with a raised cap.

**Check:** a **successor** workflow is created inheriting the snapshot; the predecessor stays terminal and
unmodified; the chain is traversable both ways; consumption sums across it (FR-149 – FR-152, SC-039).

4. Attempt a successor from an expired snapshot.

**Check:** refused with the retention limit stated.

---

## Scenario 7 — Multi-repository workspace (US10)

**Proves:** SC-031 – SC-033.

Define a workspace with `sisyphus-scratch-a` (primary) and `sisyphus-scratch-b`, then run a prompt requiring a
change in **both**.

**Check:**

| Expectation                                                                                                          | Requirement    |
| -------------------------------------------------------------------------------------------------------------------- | -------------- |
| Both repos checked out at declared branches into declared subdirectories under `/workspace`, before the agent starts | FR-112         |
| Agent cwd is the workspace root; it read across both in one session                                                  | FR-113         |
| One PR per **changed** entry, none for unchanged                                                                     | FR-115, SC-031 |
| PRs share the branch name and cross-reference each other                                                             | FR-116, SC-031 |
| Each entry's resolved commit and result recorded                                                                     | FR-114         |

Then:

1. Make one entry's branch nonexistent.

**Check:** fails at checkout **naming that entry**; agent never starts; no partial workspace (FR-112).

2. Simulate one entry landing and another failing to push.

**Check:** per-entry results recorded and the terminal outcome states the **partial** state — not success
(FR-118, SC-032).

3. Configure colliding subdirectories, then one escaping the root.

**Check:** both rejected at validation naming the offending entries (FR-111).

4. Start a second workflow whose workspace includes a repo+branch a running workflow holds.

**Check:** refused or serialised, naming the holding workflow (FR-120).

5. Pause and resume a multi-entry run on a fresh instance.

**Check:** every entry's working tree restored, including uncommitted work — the snapshot covers the whole root.

---

## Scenario 8 — Jira integration (US8)

**Proves:** SC-023 – SC-026, SC-036, SC-041, SC-043 – SC-045.

1. Configure an integration: URL, credential, project prefix, label, prompt intro, ordered mappings, default
   owner, timezone, short cron.

**Check:** validation includes a real connectivity check before enable; the credential is never rendered back
(FR-097, FR-098). The schedule's next five fire times are visible **before** saving (FR-154, SC-041).

2. Preview the assembled prompt for a sample ticket.

**Check:** the interface states which ticket fields are appended, and the preview shows preamble → intro → title
→ URL → body → comments in that order (FR-157, FR-158, FR-159, FR-160, SC-045).

3. Label an in-scope ticket with an assignee; wait one tick.

**Check:** exactly one workflow starts with the mapped profile's workspace, bundle, model and caps (FR-101). The
**assignee** owns it (FR-132). The ticket receives a pickup comment (FR-142, SC-036). The assembled prompt is
stored **as sent** (FR-162, SC-043).

4. Wait for further ticks.

**Check:** no duplicate workflow, and no duplicate comment (FR-102, SC-023).

5. Restart the control plane mid-tick and let it run again.

**Check:** still exactly one workflow — the unique index, not application logic, is what holds here (FR-102).

6. Label a ticket matching no mapping. Then one with empty title **and** body.

**Check:** both skipped with the reason recorded **and commented on the ticket** (FR-143, FR-164, SC-036).

7. Bulk-label 50 tickets.

**Check:** no more start than the per-tick and rolling ceilings permit; the remainder are picked up on later
ticks, none permanently dropped (FR-107, SC-024).

8. Configure two integrations whose filters both match one ticket.

**Check:** exactly one workflow starts; the winner is deterministic and independent of tick timing; the ambiguity
is recorded (FR-104).

9. Add a comment authored by the Sisyphus service account; trigger a new run on that ticket.

**Check:** the platform's own comment is **excluded** from the assembled prompt (FR-161, SC-044).

10. Break the credential.

**Check:** runs recorded as failed with the reason; no partial workflows; auto-disables after the configured
consecutive-failure threshold (FR-106, FR-108, SC-026).

11. Disable, then re-enable, then delete the integration.

**Check:** the registered schedule is created, removed and re-created to match — stored config and registered
schedules never diverge (FR-100, SC-025).

12. Set a 09:00 schedule in `Europe/London` and cross a daylight-saving boundary.

**Check:** it stays at 09:00 wall-clock (FR-155, SC-041).

---

## Scenario 9 — Autonomous loop (US4) and review (US5)

**Proves:** SC-010, SC-016, SC-018.

Point an autonomous workflow at `sisyphus-scratch-a` with a deliberately review-failing ticket.

**Check:**

| Expectation                                                                       | Requirement    |
| --------------------------------------------------------------------------------- | -------------- |
| `sisyphus-dev` governs branch naming and PR creation                              | FR-057         |
| Ticket transitions use the transitions the skills name — never a Sisyphus default | FR-057         |
| Exactly **three** develop→review iterations, no more                              | FR-062, SC-010 |
| Each iteration's verdict and findings recorded                                    | FR-065         |
| On exhaustion: stops, `needs_attention`, PR left open with accumulated feedback   | FR-062         |
| On pass: `sisyphus-integration` steps run                                         | FR-061         |

Then:

1. Remove `sisyphus-review` from the repo and re-run.

**Check:** halts with an explicit missing-skill outcome **naming the skill**; no guessed action on branches or
tickets (FR-058).

2. Trigger a review workflow against a PR with a known defect.

**Check:** verdict `fail`; findings anchored to entry + file + line; comments on the PR; the ticket transition
matches the skill (FR-063, FR-119).

3. Trigger a review against an already-merged PR.

**Check:** exits with a recorded no-op — no comments, no transition (FR-080).

4. Force a retry on an external action (PR open, comment).

**Check:** no duplicate PR or comment; the idempotency index is what guarantees this (FR-077, SC-018).

---

## Scenario 10 — Fleet oversight (US6)

**Proves:** SC-011 – SC-014, SC-026.

With workflows across several profiles, users and states:

1. As an admin, filter by each dimension and compose filters.

**Check:** correct narrowing; any workflow locatable without paging through unrelated runs (FR-013, SC-017).

2. Open a workflow whose instance was released weeks ago.

**Check:** complete archived log, timeline including pauses and corrections, artifacts and outcome all readable
(FR-014, SC-012).

3. Open the spend view.

**Check:** default aggregation is by client/workspace/profile, **not** a per-person ranking; per-user totals are
visible to that user and to admins (FR-156). Every workflow's cost is individually attributable, with nothing
unattributed (SC-011).

---

## Scenario 11 — Onboard a client with zero redeploys (SC-020)

**Proves:** SC-020 — the platform's headline claim, and previously untested.

1. Starting from a deployed stage, register a **new** setup bundle for a client whose credentials and tooling the
   platform has never seen.
2. Run a validation run against it (no ticket, no workspace, no prompt — FR-147).
3. Create a workspace and an execution profile referencing it; enable the profile.
4. Grant one engineer access; have them launch a workflow.

**Check:** every step happened through the panel and the database. **No deploy, no code change, no migration** was
required at any point (SC-020, FR-083, FR-121). Confirm from CI that no pipeline ran between steps 1 and 4 — the
claim is about redeploys, so the absence of a deploy is the actual assertion.

---

## Scenario 12 — Explaining a past run after conventions change (SC-016)

1. Run an autonomous workflow against `sisyphus-scratch-a`.
2. Edit `sisyphus-dev` in that repository — change the branch prefix.
3. Run a second workflow.

**Check:** each workflow's `skill_references` rows record the skill path and a **content digest**, and the two
digests differ (FR-059). The first run remains explicable against the convention it actually followed, not the
current one (SC-016). Delete a skill and launch again: the run halts naming the skill and the step, with no guessed
branch action, and the absence is recorded (FR-058).

---

## Scenario 13 — Versioned profiles and workspaces (FR-125)

1. Launch a long-running workflow from a profile.
2. While it runs, edit the profile's model and add an entry to its workspace.

**Check:** the running workflow is unaffected and still resolves its original `execution_profile_version_id` and
`workspace_version_id` — including the original entry set, not the grown one (FR-125, FR-149). Its recorded
version reconstructs the **exact** launch configuration, bundle version and workspace version included (FR-065,
SC-021). A new launch picks up the new version.

---

## Scenario 14 — Entry, shell and navigation (FR-193..FR-197, FR-201)

_Added 2026-08-06._

1. Signed out, request `/`, then `/workflows`, then `/admin/users`, then a deliberately bad path.
2. Force an authentication failure: sign in with an out-of-domain identity, then with a deactivated account.
3. Signed in as an **engineer**, land on the redirect target and walk the sidebar.
4. Signed in as an **admin**, walk the sidebar again.
5. From a deep screen, sign out.
6. As an engineer, request an admin-only URL directly.
7. Tab through the shell from a cold page load, with the browser at a narrow width.

**Check:** every request in (1) lands on the sign-in screen, not a 404 and not an unstyled framework page
(FR-195, SC-057). Both failures in (2) return to the sign-in screen showing a readable reason. That reason
names **both** possible causes — out-of-domain identity and deactivated account — and states that it will not
say which: they are deliberately indistinguishable, because discriminating them would tell an unauthenticated
caller whether an account exists (FR-195 as amended, FR-190). A generic provider failure remains distinct from
a refusal. In (3) the sidebar shows Workflows, Launch a run, Needs attention and account settings, and **no
Admin group at all** — not a disabled one, and no fleet-oversight link either, since that screen is admin-gated
and FR-190 forbids advertising a surface that will answer `NOT_FOUND` (FR-193 as amended). In (4) the Admin
group is present with all six surfaces, plus fleet oversight. Every screen the role can open is
reachable in ≤3 clicks from any other (SC-056). The current section is marked by something other than colour
alone (FR-201). In (5) the session ends and the browser returns to sign-in (FR-194, SC-058). In (6) the
engineer gets the **styled** not-found boundary inside the shell with a route back, never `FORBIDDEN` and
never the framework default (FR-197, FR-190). In (7) every nav item is reachable by keyboard with a visible
focus ring, and the page body does not scroll horizontally.

**Also check the states, per screen (FR-201):** a list with zero rows renders a stated empty case, not a blank
region; a screen whose query is in flight renders its loading case; a screen whose query fails renders the
reason plus a next action. Walk every screen under the shell route group — this is the criterion the design
audit's "every screen" line was previously missing.

---

## Scenario 15 — Notification preferences and watching (FR-138)

_Added 2026-08-06._

1. As user A, open the notification settings screen from the shell. Turn off one event, leave another on.
2. Run a workflow A owns through both events.
3. As user B — who can see A's workflow through a shared profile grant — open it and click Watch.
4. Run the workflow to a notifying event.
5. As user B, unwatch; run another event.
6. As user C, who holds **no** grant covering that profile and does not own the workflow, request its URL.
7. Sign in as a user with no resolvable Slack identity and open the settings screen.

**Check:** in (2) A is notified for the enabled event and not the disabled one, and both decisions are visible
in the notification records (FR-138, FR-141, SC-059). In (4) B receives the notification alongside A. In (5) B
receives nothing further. In (6) C gets the not-found boundary — watching must not have widened anyone's scope,
and the workflow's existence is still not disclosed (FR-190). In (7) the settings screen states plainly that
no Slack identity resolved and that notifications will not be delivered, rather than silently succeeding
(FR-140).

---

## Scenario 16 — Infrastructure shape and the typecheck gate (FR-066, FR-198..FR-200, FR-202)

_Added 2026-08-06._

A developer's machine almost always has `~/.aws` on it, so `pnpm install` on its own does **not** prove the
credential-free claim — the install would have succeeded either way and the scenario would pass while testing
nothing. Reproduce a clean clone explicitly: delete the generated trees, then run the install configs with
every `AWS_*` variable unset **and** the shared config and credentials files pointed somewhere that does not
exist. That last part is what actually removes the credentials.

```bash
# 1. Clean clone, no credentials. Delete the generated type trees first — a stale `.sst/`
#    makes the typecheck pass on types the install never had to produce.
rm -rf {apps/sisyphus-admin,apps/sisyphus-control-plane,apps/sisyphus-executor,packages/sisyphus-infra}/.sst

#    `pnpm install` runs each of the four `postinstall` hooks. To assert the credential-free part,
#    run the same command the hook runs, under a scrubbed environment:
for p in packages/sisyphus-infra apps/sisyphus-admin apps/sisyphus-control-plane apps/sisyphus-executor; do
  (cd "$p" && env -u AWS_PROFILE -u AWS_REGION -u AWS_DEFAULT_REGION -u AWS_ACCESS_KEY_ID \
      -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
      AWS_CONFIG_FILE=/nonexistent AWS_SHARED_CREDENTIALS_FILE=/nonexistent \
      AWS_EC2_METADATA_DISABLED=true \
      pnpm exec sst install --config sst-install.config.ts --stage install) || echo "FAILED: $p"
done

pnpm nx run-many -t typecheck      # must be clean, with no credentials present
```

1. Inspect `packages/sisyphus-infra/src/` for any `*Provider` / `*Surface` interface, injected constructor, or
   structural redeclaration of the deployment tool's types:
   `grep -rE '\b[A-Za-z]*(Provider|Surface)\b' packages/sisyphus-infra/src`.
2. Diff each deployable's `sst-install.config.ts` provider block against its `sst.config.ts`.
3. Grep every `sst` invocation across `project.json` files and package scripts.
4. Open both loose-check lists in each project that has them.
5. Delete a character from a policy-document helper's action string and run its colocated test.

**Check:** (1) the grep is not silent, and what it returns is the point. The only matches allowed are
`oidc-provider.ts`'s use of AWS's **identity** provider — `aws.iam.OpenIdConnectProvider`,
`getOpenIdConnectProvider`, the local `provider` binding and the exported `createOidcProvider` /
`OidcProviderConfig`, plus the one line in `index.ts` that re-exports them. That is an AWS resource type, not
an injected seam. Anything else — an interface the package declares so a caller can pass an implementation in
— is the shape SC-060 forbids. (2) the provider set and every pinned version match exactly — a mismatch means
the generated types describe something a deploy will not resolve (FR-199). All four files must name the same
single `aws` provider at the same version; the install configs deliberately omit `region`, because a config
that resolves a region has to read the environment, and that is the thing being proved unnecessary. (3) every
command that acts on a stack — deploy, **destroy**, unlock — names its config file; an omission is a defect,
not a shortcut (FR-199). (4) `sisyphus-api`, `sisyphus-integration-jira` and `sisyphus-notify` have no such
files at all; the four that do list exactly one glob, `.sst/**/*.ts`, and every one of the four ignores **no**
error codes — `ignored-error-codes.json` is `[]` in all of them, including `sisyphus-infra`. A non-empty list
anywhere is a regression to argue about on its own merits (FR-198, SC-061). (5) the test fails — if it passes,
the policy content is not actually under test and FR-200 is unmet.

Confirm too that `.sst/**` appears in all three of `tsconfig.json` `include`, the loose-glob list, and
`eslint.config.mjs` `ignores`. Removing it from the first breaks compilation; from the second, the gate fails
on generated code; from the third, lint does.

---

## Quality gates — run before every commit

```bash
pnpm nx affected -t lint typecheck test design-lint --base=main
pnpm qlty:diff
pnpm knip:orphans
```

**Bar:** zero lint or security issues at medium+, ≤10% duplication in changed files, `strict` typecheck clean,
**zero** design-lint errors with every residual warning explained in `DESIGN.md`'s own prose (FR-022, SC-015),
and **zero** orphaned modules. No `QLTY_*` override may be used to pass CI.

`pnpm knip:orphans` is the assembly gate (SC-063). It answers one question the other four cannot: does every
module that ships have a caller reachable from something that runs in production? A module can compile, lint
cleanly and pass its own suite while nothing but that suite ever imports it — which is how a finished-looking
feature reaches a stage doing nothing. The gate runs knip in `--production` mode, so test files and every
non-production entry drop out of the graph and a module's own suite stops counting as a caller.

Two ways to make it lie, both worth knowing:

- **A missing `!`.** Only entry and project patterns suffixed `!` in `knip.json` are production patterns.
  Strip the suffix and knip resolves an empty entry set, analyses nothing, and exits zero in about a second.
  A suspiciously fast pass is the symptom.
- **A barrel promoted to a production entry.** Listing `src/*/index.ts` as a production entry makes every
  module the barrel re-exports reachable by definition, which is precisely the gap the gate exists to find.
  Barrels belong in `entry` without the `!`, so the default `pnpm knip` run still treats them as a surface
  while the gate does not.

When it fails, the finding is a module with no production caller. That is a wiring task, not dead code:
delete it only once you are sure nothing was ever meant to call it.

### Design audits — not covered by the linters

| Audit                                                                            | Bar                     | Requirement    |
| -------------------------------------------------------------------------------- | ----------------------- | -------------- |
| `grep` components for literal hex, px font sizes, px radii                       | Zero                    | FR-021, SC-015 |
| Class composition goes through the shared `cn`                                   | No ad-hoc concatenation | FR-033         |
| No hand-rolled duplicate of an existing primitive                                | Zero                    | FR-033         |
| Both themes usable; all text ≥ 4.5:1; every focusable element shows a focus ring | Pass                    | FR-034, SC-015 |
| `amber`/`verdigris`/`rust` used only for machine state                           | Zero decorative uses    | FR-025         |
| Every screen defines loading, empty and error, not only populated                | All three, all screens  | FR-201         |
| Shell operable by keyboard; current section not signalled by colour alone        | Pass                    | FR-201, SC-056 |
