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

**Per-developer AWS** — a personal stage in the shared account. Bootstrap is **once per stage**, not once per
account: it creates that stage's configuration parameter and its deploy role. What is once per account is the
**identity provider** inside it, and only the **production** bootstrap creates one — every other stage,
personal ones included, looks it up (R12, `createOidcProvider`). So if a bootstrap fails with a message naming
the bootstrap step, the cause is that nobody has run the production one yet.

```bash
# Once per account, and only this configuration creates the identity provider. It deploys the
# `production-bootstrap` stage, which is protected exactly as `production` is.
pnpm nx run sisyphus-admin:bootstrap --configuration=production

# Per deploy stage. `bootstrap` and `deploy` offer `staging` and `production` and nothing else —
# without a configuration both refuse by design rather than picking one.
pnpm nx run sisyphus-admin:bootstrap --configuration=staging
```

A **personal** stage has no nx configuration and is not meant to: the targets above name the two stages CI
deploys, and a third entry per developer is a project file nobody could keep true. Drive `sst` directly from
the deployable, once for the stage's prerequisites and once for the stack. On a stage's very first bootstrap
the configuration parameter does not exist yet, so `SISYPHUS_GITHUB_REPO` has to come from the shell for that
one run; afterwards it is read from the parameter.

```bash
cd apps/sisyphus-admin
SISYPHUS_GITHUB_REPO='<org>/<repo>' pnpm exec sst deploy --stage "$USER-bootstrap" --config sst-bootstrap.config.ts
pnpm exec sst deploy --stage "$USER" --config sst.config.ts
```

The `-bootstrap` suffix is load-bearing rather than a convention: `sst-bootstrap.config.ts` refuses any stage
without it, and its sibling refuses any stage with it, so neither half of the pair can be reached by getting a
stage string wrong (FR-199).

```bash
# `migrate` has three configurations — `local`, `staging`, `production` — and the bare invocation is
# the local one: it runs the migration CLI, which reads exactly one variable, so pointing it at the
# wrong database is a deliberate act rather than a mistyped flag (FR-010). The two deploy
# configurations run a different entry point under a pinned `SISYPHUS_STAGE` and take no URL from
# you at all.
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

**A seat in the agent-credential pool, and a group attached to the profile under test.** This is spec 003's
prerequisite and it is the one most likely to stop a scenario before it starts. Every run performs its work as
an **agent credential** — a seat — leased from a pool the platform manages. A workflow holds exactly one for
its entire lifetime and never changes it (`003/FR-015`, `003/FR-023`), and the lease is reserved at admission
**before any compute is provisioned** (`003/FR-016`), so a run that cannot reach a seat never becomes an
instance. Setup bundles no longer carry the agent's credential at all; that responsibility is now the pool's
(`003/FR-048`, superseding FR-043 and FR-075).

Three things have to exist before any scenario below that launches a run:

1. **A registered credential whose login has succeeded.** Register it at `/admin/credentials` and drive its
   login there. The flow runs inside a short-lived, isolated environment the platform provisions and destroys,
   and the material is captured server-side into the secret store — never displayed, downloaded or pasted
   (`003/FR-069`, `003/FR-070`, `003/FR-071`). A credential is **not selectable until a login has been proven
   successful** (`003/FR-008`), so a registered-but-unlogged-in seat is not capacity.
2. **A credential group holding it.** Every credential belongs to exactly one group, assigned at registration
   (`003/FR-061`). Groups are managed at `/admin/credentials/groups`.
3. **That group attached to the execution profile the scenario launches from**, in preference order
   (`003/FR-062`).

The third is a **configuration-time gate, not a launch-time one**, and that is why it belongs in the
prerequisites rather than in a failure mode. `runEnableGate`
(`packages/sisyphus-api/src/server/admin/profiles.ts:231`) runs `credentialGroupAttachmentCheck` **first and
unconditionally** — before it has even looked for a published version — so a profile with no attachment, or
one attached only to disabled or archived groups, is refused at enable naming the missing element
(`003/FR-065`). A profile that cannot be enabled cannot be launched from, so the whole guide below stops at
Scenario 1 without this. The two refusals are worded differently on purpose: one administrator needs to attach
a group, the other needs to re-enable the one already attached.

**Size the pool for the scenario, not for the run.** A seat is held from admission until the workflow is
terminal, and pausing, parking and the destruction of an instance all leave it held (`003/FR-019`,
`003/FR-073`). So a scenario that leaves runs paused, parked or waiting needs more seats than it has
simultaneous runs — two profiles running concurrently in 1f need two seats, and the fifty tickets in 8.7 are
bounded by the pool as well as by the per-tick ceiling. Watch which is which at `/admin/credentials/pool`,
where waiting runs are broken down **by group**, so an under-sized group is distinguishable from an
under-sized pool (`003/FR-054`).

**Two things that do not need a seat, and one that needs one and cannot get it.** A **bundle validation run**
holds no credential, deliberately, so proving a bundle never consumes pool capacity (`003/FR-052`) — that
covers 1b's third step and Scenario 11's second. Scenarios 14 and 16 launch nothing and need no pool at all.

> **The ad hoc launch path is the one that cannot get one.** `start-ad-hoc.ts:171` writes
> `executionProfileId: null`, credential selection reaches candidates only by joining out through that column
> (`credentials/allocate/select.ts`), and the grant path joins through the same attachments — so an ad hoc run
> can reach no group, is admitted **without** a seat as a recorded configuration fault rather than made to
> wait (`credentials/allocate/wait-reason.ts`, `NO_EXECUTION_PROFILE`), and then meets
> `installAgentCredential`, which is a straight-line `await` in the executor's only boot path with no branch
> to escape through (`003/FR-050`, `apps/sisyphus-executor/src/run/bootstrap.ts:210`). The machine surface
> answers `PRECONDITION_FAILED` for a workflow with no live lease, and `003/FR-051` fails the workflow naming
> `credential_install`. **Launch every scenario below from an enabled, attached execution profile**, including
> the ones whose text still describes the Phase 4 ad hoc route.

**Local loop**

```bash
pnpm nx run sisyphus-admin:dev          # http://localhost:3003
```

The panel is the only thing with a dev server worth pointing a browser at. The executor has a `dev` target too
— `tsx src/main.ts`, which runs a job envelope rather than serving anything — but the **control plane** has
none, and deliberately: it has **no inbound network surface** (FR-035), being a single handler that EventBridge
Scheduler invokes directly, so there is nothing for a `dev` target to serve. Exercise it through its tests —
`pnpm nx run sisyphus-control-plane:test` — or by deploying it to your own stage.

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

**Pool setup.** 1a – 1e need **no seat**: the registration steps write configuration, and 1b's validation run
is exempt by requirement (`003/FR-052`). **1f and 1g launch**, and 1f launches on two profiles at once — so
before it, register **two** logged-in credentials, put them in a group each (or one group with two members),
and attach a group to `client-a` and to `client-b`. One seat between them turns 1f's concurrency into a queue
and the leak test into a test of the queue. 1g's deactivated user must own a **running** workflow, so its seat
has to still be held when you deactivate them.

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

**Pool setup.** One logged-in credential, in a group, attached to the profile you launch from. 2d needs no
second seat — the concurrency ceiling is checked **before** a seat is reserved (`admit-workflow.ts`), so the
second run is refused at the ceiling and stays `queued` rather than reserving anything. 2e's duplicate launch
resolves to one workflow and therefore one lease. 2f pauses, which **retains** the seat (`003/FR-040`).

Launch a delegated workflow against `sisyphus-scratch-a` with the prompt "add a CHANGELOG entry for an
unreleased version", **from an enabled execution profile**. The scenario was originally written against the
Phase 4 **admin-only ad hoc path** (T064a), and that route no longer reaches a terminal outcome: an ad hoc run
carries no execution profile, so it can reach no credential group, is admitted without a seat, and fails at the
`credential_install` bootstrap phase — see the pool prerequisite above. Profiles, and with them the non-admin
launch route, arrive in Phase 5 (Scenario 3); this scenario now depends on that phase rather than preceding it.

**Check:**

| Expectation                                                                                                   | Requirement                |
| ------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Bootstrap phases appear individually with their own timings — never an opaque "provisioning"                  | FR-145, SC-037             |
| A distinct, individually timed `credential_install` phase appears between `setup_script` and `entry_checkout` | `003/FR-049`               |
| No credential material appears in the phase report, the log or the job envelope                               | `003/FR-012`, `003/SC-014` |
| Live output appears in the panel within 5s of production                                                      | FR-046, SC-002             |
| Output contains no ANSI escapes, spinner frames or cursor movement                                            | FR-045, SC-013             |
| A **draft** PR exists on a new branch                                                                         | FR-060, SC-009             |
| No ticket transition was attempted                                                                            | FR-060, SC-009             |
| A reviewer summary exists, stating decisions, assumptions, omissions and uncertainties                        | FR-153, SC-040             |
| Turns and spend are recorded against both caps                                                                | FR-055                     |
| The instance is gone within 10 minutes of terminal                                                            | FR-038, SC-007             |
| The full log is readable **after** the instance is gone                                                       | FR-046, SC-012             |
| The workflow reached exactly one terminal outcome                                                             | FR-064, SC-006             |

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

**Pool setup.** One logged-in credential in a group, and that group attached to each profile this scenario
creates — the profile carries the attachment, so every profile below needs its own. Step 5 exercises the gate
directly, so keep one group **disabled** and one **unattached** to have subjects for it.

1. Create a profile carrying workspace, model, instance type, purchase mode, caps and bundle, and attach at
   least one credential group to it in preference order (`003/FR-062`).
2. Launch supplying **only a prompt**.

**Check:** the run used every profile value, and the workflow records profile + version (FR-122, FR-126,
SC-027). Time the interaction: under 30 seconds (SC-027).

3. Override the model on a second run.

**Check:** both the override and the originating profile are recorded (FR-123, SC-030).

4. Mark `model` locked; attempt to override.

**Check:** refused with the reason shown — not silently ignored (FR-123).

5. Attempt to enable a profile whose bundle is disabled, then one whose workspace version holds no
   repositories, then one with **no attached credential group**, then one attached only to a **disabled or
   archived** group.

**Check:** all four refused **naming the failing element** (FR-124, SC-029, `003/FR-065`). The two credential
cases are refused with **different** sentences, because the remedies differ — one administrator must attach a
group, the other must re-enable the one already attached. Attempt a profile with two failures at once (no
attachment _and_ a disabled bundle): the gate reports **both** in one attempt, so the attachment check runs
first and unconditionally rather than short-circuiting. Confirm too that a profile with no published version at
all still reports its missing attachment: attachments hang off the mutable profile row rather than off a
version, so the question is answerable before there is a version to validate. Then enable a profile naming a
repository that does not exist: it **succeeds**. Reachability is not checked at enable time
(`specs/004-remove-reachability-gate`); a bad repository fails at `entry_checkout` instead, naming the entry.

6. As a non-admin, attempt an ad hoc launch.

**Check:** refused — ad hoc is admin-only, because it would otherwise bypass profile scoping (FR-187).

---

## Scenario 4 — Notifications and ownership (US11)

**Proves:** SC-034 – SC-036, SC-042.

**Pool setup.** One logged-in credential in a group attached to the profile you launch from. One seat is
enough: the runs here are sequential. Note that waiting for a credential and cooling off **raise no
notification to the owner** at all — they are reported in the workflow view only (`003/FR-079`) — so a run
that stalls in `awaiting_credential` will produce silence rather than a Slack message, and that silence is
correct rather than a failure of step 1.

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

**Proves:** SC-003, SC-004, `003/FR-039` – `003/FR-042`. **Requires S1.**

**What a pause now is.** FR-049's pause clause is superseded by `003/FR-039`, and the change is at the end of
the sequence rather than the beginning. Suspending the relay at a turn boundary and capturing a snapshot
_before_ the pause is acknowledged are unchanged and are still what makes "paused" true. What changed is what
happens after the acknowledgement: the **agent is ended**, and the **instance is stopped with its disk
retained**, so compute billing ends while the working tree and the conversation stay exactly where they are.
Holding the process alive made a pause cost the same as running, which is why pauses were something to avoid
using. The executor's order is fixed and asserted (`session/suspend.ts`): quiesce → flush any credential
rotation → snapshot → register → **acknowledge** → mark suspended → end the agent → the control plane stops the
instance from outside, because an instance may never stop itself.

**Pool setup.** One logged-in credential in a group attached to the profile. The pause **retains** it
(`003/FR-040`) and so does the park in step 7 (`003/FR-073`), so this scenario holds one seat from launch until
the run is terminal and never releases one in between. Nothing on any path in `pause-instance.ts` or
`snapshot-recovery.ts` writes to `credential_leases`; assert that rather than assume it.

**Run this scenario twice, once per purchase mode, and record two sets of figures.** The mode decides which of
two paths a pause takes, and `003/SC-007` requires the two to be _"measured and reported as separate figures,
because a single blended number would misrepresent both"_.

| Purchase mode                        | What the pause does                                                                                                                                 | Recorded path       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `spot` — **`DEFAULT_PURCHASE_MODE`** | Snapshot, then **terminate**: a one-time spot instance cannot be stopped by its owner at all, so the pause degrades to 002's snapshot-and-terminate | `snapshot_recovery` |
| `on_demand` — the opt-in             | Snapshot, then `StopInstances`; the disk stays attached                                                                                             | `stopped`           |

Run the **spot** case first. It is the default a profile gets when nobody chooses (`enums/purchase-mode.ts`),
so it is the path the overwhelming majority of pauses take, and a guide that led with the other one would be
documenting the exception. The degradation is not a second implementation: the spot branch calls the same
`giveUpEnvironment` the FR-043 recovery calls, with a different cause, so a spot pause and a failed on-demand
start converge by construction — which is also what keeps the rare path exercised.

1. Launch a long-running prompt from a `spot` profile.
2. Pause mid-execution.

**Check, on both modes:** paused within 10 seconds (SC-003 — and the ten seconds are divided into terms by
`supervision/budget.ts`, each passed to the operation it bounds rather than merely declared beside it); **no
further agent output**; a snapshot exists with **both** state flags, and it was registered **before** the pause
was acknowledged (FR-049's surviving half). Compute billing **ends** and storage billing does not, and the
difference is visible to the owner (`003/FR-042`, `003/SC-008`). The agent process is **ended** — the check
that it is still alive is 002's and no longer applies.

**Check, on `spot`:** the compute lease is released with a `spot_cannot_stop` reason recording that the
instance was released and the run stands on its durable snapshot; the queue drains, because a slot really was
freed. **Check, on `on_demand`:** the instance is `stopped`, the compute lease is **not** released — its
`provider_instance_id` is how the resume finds the instance again — the volumes are read back **from EC2 after
the stop** rather than asserted, and nothing drains, because no slot was freed.

**Check, on both:** the run's newest `paused` timeline row now carries the path it took, **merged into the
existing row rather than appended as a second one**. That is load-bearing: the reconciler reads the latest
`paused` event's `created_at` as the instant the pause began — there is no `workflows.paused_at` column — so a
second row would restart the clock and a run could never reach the idle limit in step 7. Two `paused` rows for
one pause is a defect, not tidiness.

**Check the refusal, on both:** deny the run a resumable snapshot (delete the current one, or leave it with
only one state flag) and pause again. The pause is **refused** and _nothing is touched_ — the instance is left
running, and left billing — because an unresumable pause is indistinguishable from lost work. The refusal is
stated once above the branch precisely so neither purchase mode can acquire an exception to it.

Confirm the **delivery path**, not just the outcome: a `supervision_commands` row moves `pending` →
`acknowledged`, and the panel shows "paused" only after the executor acknowledged — not on mutation return. Submit
a `pause` and a `stop` in quick succession before either is collected: the `pause` comes back `superseded` and is
never applied.

3. On an `on_demand` run, deny the platform permission to stop the instance, then pause.

**Check:** the pause does **not** fail and does not leave the instance running. `StopInstances` refusing is
routed to the same recovery the spot pause takes, under an `instance_would_not_stop` cause — the instance is
given up and the run stands on its snapshot. Giving it up is worse for the resume and better for the bill, and
it is emphatically not a third behaviour invented for this case.

4. Submit a correction; resume.

**Check:** subsequent output reflects the correction and the prior conversation history is intact — SC-004's
claim is that the **conversation** was not restarted, which is what a resumed session against the same session
id preserves; it was never a claim about the process, and the process is now ended on every pause (FR-044,
SC-004).

5. Submit two corrections in quick succession.

**Check:** delivered in `sequence` order, neither dropped (FR-049).

6. Submit a correction to a completed workflow.

**Check:** rejected with an already-finished response, recorded as `rejected` — not accepted and lost (FR-081).

7. Pause and leave idle past the ceiling — 30 minutes (`PAUSE_IDLE_CEILING_MS`).

**Check:** the run is **parked**: instance _and_ disk released, work preserved durably, moved to
`parked_resumable` and reported as parked rather than failed — the two words mean opposite things to the person
who left it (`003/FR-044`). A `parked` row is written as a **second** timeline event, unlike the pause path's
merge, because it is a new event rather than a fact learned about the old one. The park frees a compute slot
and **no seat at all**: the run keeps its agent credential (`003/FR-073`), so the drain it triggers may admit a
run waiting under the concurrency ceiling and can never admit one waiting for a credential. Confirm at
`/admin/credentials/pool` that the holder shows as **parked** rather than running — a parked holder consumes
capacity indefinitely while showing no activity, which is the likeliest cause of unexplained exhaustion
(`003/FR-074`). Then repeat with an unresumable snapshot: the park is **refused** and the instance is left
running and billing, because an unresumable park is indistinguishable from having deleted somebody's work
(`003/FR-045`). The cost priority inverts here knowingly.

8. From two sessions, pause and resume the same workflow concurrently.

**Check:** transitions serialise; the panel shows the actual state (FR-049, FR-081).

---

## Scenario 6 — Resume and successors (US3)

**Proves:** SC-005, SC-008, SC-019, SC-039, `003/FR-041`, `003/FR-043`, `003/SC-007`. **Requires S2.**

**Resume and recovery are now two different things, and the split is the point of this scenario.** Under 002
every resume was a restore: the instance was gone, a fresh one was provisioned, and the snapshot was replayed
onto it. `003/FR-041` gives the ordinary case a much shorter path — _"Resuming a paused workflow MUST start its
existing instance and continue the same session against the same working tree, without re-provisioning,
re-cloning or restoring from snapshot"_ — and leaves the restore to `003/FR-043`, for the case that instance
cannot be started again. **Snapshots stop being the pause-resume path and remain the durability and recovery
path.** The requirement is written as three prohibitions and the implementation is those absences: resume calls
`StartInstances` on the instance id already on the run's live compute lease and stops. No launch, so no
envelope and no scoped credential; no checkout, so the working tree is the one the pause left; no restore,
because the snapshot is a fallback rather than a source.

**Pool setup.** The run holds the seat it was granted at admission, throughout — the pause did not release it,
the park did not release it, and no path here re-acquires one. Steps 1 and 2 below are the two places that
claim matters most, so read the seat back from `credential_leases` and compare it against the id recorded at
launch rather than trusting that it looks right.

1. Pause an `on_demand` run, then resume it.

**Check:** the **same** instance is started — same instance id, same compute lease row, same `ready_at`;
nothing new was recorded because nothing new exists. No new scoped credential was minted, no bundle was
downloaded, no entry was re-cloned, and the snapshot was **not** read. The working tree is the one the pause
left, uncommitted work included, and the agent continues the same session. Time it against a cold start of an
equivalent workflow: `003/SC-007` asks for at least **5×** faster to first agent turn, and the margin comes
from the absences — a cold start pays for a launch, a bundle download, a `setup.sh` and a clone of every entry,
and this pays for a boot.

**Check the one thing that is _not_ skipped:** `credential_install` runs on this boot as it does on every other
(`003/FR-050`). There is no "already installed, skip it" branch anywhere in the bootstrap sequence, and there
must not be: the seat's material can rotate while the instance is stopped, so the file the previous boot wrote
may be stale, and a resume that trusted it would bring the run back up authenticated as nobody. Confirm the
phase appears, individually timed, on the resumed boot's timeline.

2. Make that stopped instance unable to start again — terminate it out of band, or ask for a family the
   availability zone has no capacity of — and resume.

**Check:** the run is **recovered** rather than failed. `StartInstances` refusing routes to the same
`giveUpEnvironment` the spot pause calls, under an `instance_would_not_start` cause; a fresh instance is
provisioned from the durable snapshot; the agent continues the **same** conversation; the working tree contains
the pre-interruption uncommitted work; before/after output reads as one continuous ordered log (FR-046,
SC-019). The substitution is **recorded** — a `resumed` timeline row naming the replaced instance and the new
one, not a second `provisioned` row, because the fact is about the run's continuity rather than about a launch.

**Check the credential, explicitly:** the fresh instance holds **the same** agent credential as before
(`003/FR-043`). This needs no code and that is the design working rather than an omission — the run never
released its seat, so provisioning reads the same live lease it read before the pause — but it is exactly the
claim worth falsifying, because a recovery that re-acquired a credential would produce one workflow performed
end to end by two agents, which `003/FR-023` forbids outright and `003/SC-018` is the measure of.

3. Resume a **spot** run that was paused.

**Check:** it arrives at the same recovery by a different door. There is no instance to start — the pause could
not stop one and terminated it instead — so the lease names none, the cause recorded is `spot_cannot_stop`, and
the run rebuilds from its snapshot onto a fresh instance holding the same seat. Time this one separately and
report it as its own figure: `003/SC-007` holds spot resumes to 002's resume performance rather than to the 5×,
and _"a single blended number would misrepresent both"_.

4. Resume a **parked** run, and then a parked run whose snapshot has passed the retention period.

**Check:** the first provisions a fresh instance — a park released the instance _and_ the disk, so the snapshot
is the only way back — and does so **without waiting for or reserving a credential**, because it never released
the one it holds (`003/FR-046`). Nothing on this path may re-admit the run or write `awaiting_credential`; a
parked run is `parked_resumable`, which is a terminal outcome, and a resume written as "re-admit it, it has
been terminal" would put it back in the queue behind runs that hold nothing and hand it whichever seat came
free. The second is **refused in those words**: its seat was handed back when its snapshot passed retention
(`003/FR-073`), and resuming it would mean running it under a different identity.

5. Run on spot capacity and trigger a reclamation notice.

**Check:** the same `suspend()` path runs as for a manual pause; marked resumable, not failed (FR-054, SC-008).
That is FR-054's whole purpose — routing the user-facing pause button through the interruption code is what
keeps the interruption code exercised — and under 003 the two now converge further still, since a spot pause
and a spot reclamation both end with the instance gone and the run standing on its snapshot.

6. Take a `capped` run and continue it with a raised cap.

**Check:** a **successor** workflow is created inheriting the snapshot; the predecessor stays terminal and
unmodified; the chain is traversable both ways; consumption sums across it (FR-149 – FR-152, SC-039).

7. Attempt a successor from an expired snapshot.

**Check:** refused with the retention limit stated.

---

## Scenario 7 — Multi-repository workspace (US10)

**Proves:** SC-031 – SC-033.

**Pool setup.** Two logged-in credentials in an attached group. Step 4 starts a second workflow while the first
is still running, and the branch-lock refusal it is testing has to be the thing that refuses it — with one seat
the second run sits in `awaiting_credential` and never reaches the lock at all, which would look like a pass
and prove nothing.

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

5. Pause and resume a multi-entry run **twice**: once on `on_demand`, where the resume starts the same
   instance, and once on `spot`, where it rebuilds on a fresh one.

**Check:** on `on_demand` every entry's working tree is simply still there, uncommitted work included, because
nothing was restored and nothing was re-cloned — that is `003/FR-041` observed on the case with the most to
lose. On `spot` every entry's working tree is **restored**, uncommitted work included, because the snapshot
covers the whole pinned root rather than a single repository. Both must hold; only the second is a test of the
snapshot.

---

## Scenario 8 — Jira integration (US8)

**Proves:** SC-023 – SC-026, SC-036, SC-041, SC-043 – SC-045.

**Pool setup.** Every profile an integration mapping names needs its own credential-group attachment. The
attachment is a property of the profile rather than of the integration, and the integration's own enable gate
does not look at it — that gate checks the default owner, the prompt intro and the mapping count and nothing
else (`enableRefusals`). An unattached profile therefore cannot be enabled, and the tick skips its tickets with
`the mapped execution profile is disabled` recorded and commented on the ticket, which is a correct answer to
the wrong question if you have not read this paragraph. Attach before configuring. Size the pool for step 7 in
particular: fifty labelled tickets are bounded by the per-tick and rolling ceilings **and** now by the number
of seats their profiles' groups can reach, and the two limits look identical from the ticket's side. Read them
apart at `/admin/credentials/pool`, which reports the waiting queue broken down by group (`003/FR-054`); a
run held back by the pool sits in `awaiting_credential` with a stated reason, and a run held back by a ceiling
does not.

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

**Pool setup.** One logged-in credential in a group attached to the profile. One seat covers the whole
scenario, including the three develop→review iterations: a workflow holds **one** credential from admission to
terminal and never changes it (`003/FR-015`, `003/FR-023`), so an iteration is not a new lease. If the seat
enters cooling off mid-run — a provider usage or rate limit — the run **waits for it to clear** rather than
failing or switching, and the wait is shown to the owner as a provider limit rather than as a stall
(`003/FR-077`); do not read that as a hung iteration.

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

**Pool setup.** This scenario launches nothing of its own; it reads the fleet the scenarios above left behind,
so its prerequisite is that they ran with seats attached. Several profiles across several groups is the useful
shape, because step 3's spend view now has a second axis.

With workflows across several profiles, users and states:

1. As an admin, filter by each dimension and compose filters.

**Check:** correct narrowing; any workflow locatable without paging through unrelated runs (FR-013, SC-017).

2. Open a workflow whose instance was released weeks ago.

**Check:** complete archived log, timeline including pauses and corrections, artifacts and outcome all readable
(FR-014, SC-012).

3. Open the spend view.

**Check:** default aggregation is by client/workspace/profile, **not** a per-person ranking; per-user totals are
visible to that user and to admins (FR-156). Every workflow's cost is individually attributable, with nothing
unattributed (SC-011). Consumption and spend are additionally attributable **per agent credential**
(`003/FR-055`), and every workflow's record names the single credential it used (`003/FR-059`) — check both,
because a seat is now a cost centre as well as an identity.

4. Open the credential pool view.

**Check:** it groups credentials by credential group and shows, per credential, state, health, current holder
and hold duration, last-used and last-exercised times, and time to expiry where known (`003/FR-053`). Holders
are distinguished as **running**, **paused** and **parked** (`003/FR-074`) — leave one of Scenario 5's parked
runs in place before opening it, since a parked holder showing no activity while consuming capacity is the
whole reason that distinction exists. Determine, in this one view and under 30 seconds, which group is
under-sized (`003/SC-011`).

---

## Scenario 11 — Onboard a client with zero redeploys (SC-020)

**Proves:** SC-020 — the platform's headline claim, and previously untested.

**Pool setup.** None in advance — establishing the client's seat is now **part of the scenario**, and it is the
step most likely to need a deploy if the feature were built wrong. Start with the pool holding nothing this
client can reach.

1. Starting from a deployed stage, register a **new** setup bundle for a client whose credentials and tooling the
   platform has never seen. The bundle installs the agent CLI and the client's **non-agent** credentials only —
   it is no longer permitted to carry the agent's own (`003/FR-048`).
2. Run a validation run against it (no ticket, no workspace, no prompt — FR-147). It consumes **no** pool
   capacity, so proving a bundle never costs a seat (`003/FR-052`).
3. Register a new agent credential for the client and drive its login to success; create a credential group and
   put the credential in it.
4. Create a workspace and an execution profile referencing it; attach the new group to the profile; enable the
   profile.
5. Grant one engineer access; have them launch a workflow.

**Check:** every step happened through the panel and the database. **No deploy, no code change, no migration** was
required at any point (SC-020, FR-083, FR-121) — including step 3, where the credential material was captured
server-side straight into the secret store without ever being displayed, downloaded or pasted, and without any
bundle being produced or uploaded (`003/FR-070`, `003/SC-001`). Confirm from CI that no pipeline ran between
steps 1 and 5 — the claim is about redeploys, so the absence of a deploy is the actual assertion. Time step 3
on its own: `003/SC-001` asks for nothing-to-usable in a single session of under five minutes.

---

## Scenario 12 — Explaining a past run after conventions change (SC-016)

**Pool setup.** One logged-in credential in a group attached to the profile; the two runs are sequential, so
one seat is enough. Each run's record names the credential it used (`003/FR-059`), which is a second axis of
the same explicability this scenario is about — a past run is explicable against the convention it followed
_and_ the identity it followed it as.

1. Run an autonomous workflow against `sisyphus-scratch-a`.
2. Edit `sisyphus-dev` in that repository — change the branch prefix.
3. Run a second workflow.

**Check:** each workflow's `skill_references` rows record the skill path and a **content digest**, and the two
digests differ (FR-059). The first run remains explicable against the convention it actually followed, not the
current one (SC-016). Delete a skill and launch again: the run halts naming the skill and the step, with no guessed
branch action, and the absence is recorded (FR-058).

---

## Scenario 13 — Versioned profiles and workspaces (FR-125)

**Pool setup.** One logged-in credential in a group attached to the profile, and a **second** group with a
credential of its own, for step 3.

1. Launch a long-running workflow from a profile.
2. While it runs, edit the profile's model and add an entry to its workspace.

**Check:** the running workflow is unaffected and still resolves its original `execution_profile_version_id` and
`workspace_version_id` — including the original entry set, not the grown one (FR-125, FR-149). Its recorded
version reconstructs the **exact** launch configuration, bundle version and workspace version included (FR-065,
SC-021). A new launch picks up the new version.

3. While it still runs, change the profile's **credential-group attachments** — add the second group, reorder
   the preference, then detach the first.

**Check:** the running workflow is unaffected in a **different** way from steps 1 and 2, and the difference is
the point. Attachments hang off the mutable `execution_profiles` row rather than off a version, so there is no
`execution_profile_version_id` pinning them and this edit is not version-shielded; what protects the run is
that its seat was leased once at admission and cannot be changed for any reason (`003/FR-015`, `003/FR-023`).
Confirm the run keeps the credential it started with even after the group that supplied it has been detached,
and that a **new** launch from the same profile draws on the new attachment order (`003/FR-064`). This is a
deliberate deviation from 002's versioning pattern rather than an oversight in it — see `data-model.md`.

---

## Scenario 14 — Entry, shell and navigation (FR-193..FR-197, FR-201)

_Added 2026-08-06._

**Pool setup.** None. This scenario launches nothing and needs no seat — but it does now have three more
screens to walk, because spec 003 added them.

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
Admin group at all** — not a disabled one, no fleet-oversight link, and **not one of the three credential
screens**, since all of those are admin-gated and FR-190 forbids advertising a surface that will answer
`NOT_FOUND` (FR-193 as amended). The credential surfaces are gated more strictly than the rest of the Admin
group: 003's access scoping is narrower than 002's profile-scoped model, because a credential is platform
infrastructure and its state reveals nothing an engineer can act on. The one credential fact an engineer sees
is on their own workflow — that it is waiting for a seat, and for how long (`003/SC-006`) — and it is reached
through the existing workflow scoping rather than through any of these screens. In (4) the Admin group is
present with all **nine** surfaces — Setup bundles, Workspaces, Execution profiles, Integrations, **Credential
pool**, **Agent credentials**, **Credential groups**, Users, Audit — plus fleet oversight. The three credential
entries are three sidebar items rather than one screen with tabs, because they answer three different
questions and only the pool view is asked routinely; a folded-together version would put the daily question
behind a tab, so an implementation that "tidied" them into one is a regression against this check. Every screen
the role can open is reachable in ≤3 clicks from any other (SC-056). The current section is marked by something
other than colour alone (FR-201). In (5) the session ends and the browser returns to sign-in (FR-194, SC-058). In (6) the
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

**Pool setup.** One logged-in credential in a group attached to the profile A's workflow launches from. Note
before step 2 that **waiting for a credential, cooling off and parking raise no notification to the owner at
all** — they are reported in the workflow view only (`003/FR-079`) — so if the seat is contended, the events
this scenario is counting will not fire and the silence will look like a preferences bug. Administrator
alerting is separate and unaffected.

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

**Pool setup.** None. This scenario touches no database and launches nothing.

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
`OidcProviderConfig`; the one line in `index.ts` that re-exports them; and the one line of prose in
`panel-dns.ts` that mentions `createOidcProvider` by name while explaining why it awaits its lookup. That is an
AWS resource type and a comment about it, not an injected seam. Anything else — an interface the package declares so a caller can pass an implementation in
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

### Falsify the gate before you trust it

**A gate is not verified by passing. It is verified by being made to fail on purpose.** This is now this
feature's standard practice, and it is adopted rather than invented: spec 003 applied it to its own gates and
found four defects that reading the code did not.

- A race suite that went on **passing** with the exclusivity index dropped — it was testing the application
  code, not the constraint it was written to prove.
- A cooling-off sweep that would have returned to selection a credential still **held** by a live workflow.
- A streaming redactor that emitted a secret in **halves across a buffer boundary**, each half unmatched and
  neither redacted.
- A reconcile sweep that would have terminated **every** correctly paused instance five minutes after it
  paused.

The last one is worth dwelling on, because it is what this document's Scenario 5 change costs if nobody looks:
silence from a paused run used to be evidence it had died, and once a pause **stops the instance** that
evidence became a lie — every correctly paused run would have been declared dead `HEARTBEAT_LAPSE_MS` after it
was paused, and reaped. The fix is `silenceIsEvidenceFor` exempting `paused` from the two silence checks and
from those only; the instance-existence checks are untouched. None of the four is the kind of thing review
finds. Each was convincingly green while measuring the wrong thing, and the only technique that surfaced any of
them was deliberately breaking the subject and checking that the gate noticed. That is the fourth of the rules
this feature's work is cut by, working — and it is the argument for pointing it at the three gates in this
document that have **never** been falsified:

- **The assembly gate** (SC-063, `pnpm knip:orphans`). Plant a module with a colocated test and no production
  caller and confirm it is reported; separately, remove the only production caller of a real module while
  leaving its barrel export and its tests intact, and confirm that is reported too. Revert both. The specific
  failure this guards against is the one already found and described above: `knip --production` honours only
  entry patterns carrying a trailing `!`, and without one it analyses zero files and exits clean.
- **The database gate** (FR-204, SC-064). With `CI` set and `SISYPHUS_TEST_DATABASE_URL` unset, the guarded
  suites must **fail** rather than skip; with neither set, they must skip. Record the passing and skipped
  counts both ways — the figures that matter are `sisyphus-api`'s 1,519/0 with a database against 951/568
  without. A gate whose only evidence is a green pipeline cannot tell those two apart.
- **The latency gates** (FR-205, SC-003). Inflate each measured operation past its bound and confirm red, then
  revert. This is the whole difference between a test that measures and the constant-arithmetic tests it
  replaced — and measuring alone already found three defects those could not see: a notification window whose
  real figure was 50 seconds where 80 had been assumed, a snapshot budget that admitted 10.5 seconds against
  SC-003's 10-second ceiling, and `QUIESCE_BUDGET_MS` being passed to an adapter rather than enforced at the
  operation it bounds.

Record each falsification's output here as it is done, so the next reader inherits evidence rather than a
claim. Until then, treat all three as unverified: the gates in this section are currently asserted, not proven.

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
