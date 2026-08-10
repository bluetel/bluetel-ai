---
description: 'Independent gap analysis of spec 002 — what is not done, and what of it actually blocks the workflow'
date: 2026-08-09
base: analysis/spec2-gap @ 467e088 (branched from feature/sisyphus-4)
---

# Spec 002 — Gap Analysis

**Subject**: `specs/002-sisyphus-workflow-platform` (Sisyphus — Supervised & Autonomous Agentic Delivery Platform)

**Method**: every claim below was checked against the tree in this worktree, not read off the checkboxes.
Where `tasks.md` and the source disagree, the source wins and the disagreement is called out. No source file
was modified.

> **Companions, in order**:
> [SPEC-003-004-IMPACT-2026-08-09.md](./SPEC-003-004-IMPACT-2026-08-09.md) assesses how specs 003 and 004
> change this list and revises the ordering. It **corrects the A6 ranking below**.
> [PR-19-IMPACT-2026-08-10.md](./PR-19-IMPACT-2026-08-10.md) re-runs that assessment against spec 003 **as
> delivered** in PR #19: **T210 is done and can be ticked**, T231 is half done and needs re-scoping, and the
> other 32 remain. Read the newest for current status; this document remains the underlying survey.

**Scoreboard**: 232 tasks. **198 checked, 34 open.** The requirements checklist
(`checklists/requirements.md`) has zero open items and the spec carries no `NEEDS CLARIFICATION` markers, so
the open set below is the whole of the tracked work.

---

## 1. The one-sentence answer

The platform's *administration* half is complete and shippable; its *execution* half runs exactly one of three
workflow types, and only after a manual operator step that no task owns. Of the 34 open tasks, **six are real
code gaps that block a working system**, **fourteen are the recorded end-to-end runs that are the only evidence
any story works**, and the remaining **fourteen are hygiene**.

---

## 2. What genuinely works today

Stated first so the gap is read in proportion. Verified present and wired:

- Sign-in, the application shell, all thirteen screens, roles, profile-scoped access, bundles, workspaces,
  execution profiles, integration configuration, users, audit, notification preferences.
- Both entry points exist and compose their modules — `apps/sisyphus-control-plane/src/main.ts` builds its
  context and dispatches; `apps/sisyphus-executor/src/main.ts` reads env, assembles the run and dispatches.
- The **delegated** workflow type has real ports at the end of every wire:
  `run/assemble.ts:128` (`agentWorkflowPorts`) supplies `developer`, `entries`, `pullRequestLedger` from
  `agent/developer-port.ts` and `delivery/forge-http`. T194/T195/T229/T230 are honestly closed.
- CI is a real gate, not a decorative one: `.github/workflows/ci.yml` runs a Postgres 17 service, sets
  `SISYPHUS_TEST_DATABASE_URL`, runs `nx affected -t lint test typecheck design-lint`, and runs
  `pnpm knip:orphans` outside the affected set. T190 and T192 landed as described.

---

## 3. Tier A — Blocking. The system does not work without these.

Ranked by how much they cost if left open.

### A1. T231 — known-secret redaction never runs on a real workflow (security)

**Status: open. Verified, and worse than "incomplete" — it is a live hole.**

`assembleRun`'s returned `options` object (`run/assemble.ts:247-268`) has **no `secrets` key**. `runExecutor`
therefore takes `const secrets = options.secrets ?? []` (`run/execute.ts:272`) and every downstream redaction
site — the segment writer, the summary sanitiser, the park report — receives an empty known-value list.

Consequence: **only the pattern matcher in `output/secret-patterns.ts` stands between a client's
bundle-installed credential and the log the panel streams.** Known-value redaction is precisely the mechanism
FR-045 and FR-072 specify for the credential whose format nothing anticipated — which is exactly the case a
client-supplied setup bundle presents. The two-stage redaction T059 built is running on one stage.

The fix is structural, not a one-liner: `secrets` is snapshotted at step 1, before bootstrap, and
bundle-installed credentials arrive at phase 5. It must become `() => readonly KnownSecret[]` resolved at each
redaction site.

**Why it is first**: every other gap on this list makes something *not happen*. This one makes something
happen that must not — and it is invisible when it does. It is also the only open item that gets worse the
more the system is used before it is fixed.

### A2. `SISYPHUS_FORGE_API_URL` has no home — and **no task owns it**

**Status: not a task at all. Recorded only as prose inside checked task T229.**

`apps/sisyphus-executor/src/env-schemas.ts:51` declares `SISYPHUS_FORGE_API_URL: z.string().url()` —
required, not optional. Nothing in this repository sets it. `jobs/start-workflow.ts:70-76` explicitly declines
to carry it on the envelope ("instance configuration rather than job configuration"), and the executor's
deploy-time config comes from an SSM blob that is deliberately not committed (FR-202).

Consequence: **the first real run fails at boot on env validation, naming the variable.** T229 records this as
"the single manual step between here and T213", but a caveat inside a *checked* task is not a work item —
nothing on the open list will surface it, and T213 will simply fail on its first attempt.

**Recommendation**: this deserves an explicit task (or at minimum a line in the quickstart's deploy section)
so it is discovered before someone burns a stage deploy on it.

### A3. T198 — the prompt redactor is not packaged, so every integration tick refuses

**Status: open. Verified.**

`apps/sisyphus-control-plane/src/context.ts:181` reads
`redactor: options.redactor ?? createRefusingPromptRedactor()`, and `createRefusingPromptRedactor`
(`jobs/prompt-redact.ts:72`) throws on every call. The real implementation lives at
`apps/sisyphus-executor/src/output/redact.ts` and **no package exports it** — an app cannot depend on another
app, so there is no override to pass.

Consequence: **US8 (Jira) is completely dead in production.** Every scheduled tick throws before assembling a
prompt. Refusing by default is the correct design — FR-163 says an unredacted prompt must never be stored —
but it means the whole integration path is off.

Blocks T214 (Scenario 8) and therefore US4's integration-fed premise.

### A4. T196 — the review and autonomous ports have no implementation

**Status: open. Verified.**

`run/assemble.ts:96` defines `noWorkflowPorts` and its doc comment names exactly what is missing:
`ReviewerPort`, `IntegrationPlanner`, `IntegrationPort`, a findings publisher and a ticket connector.
`agentWorkflowPorts` returns a bundle containing **only `delegated`**. `dispatch.ts:113` throws
`missingWorkflowPortsError` for any type whose bundle is absent.

Consequence: **US4 (autonomous loop) and US5 (standalone review) cannot run at all.** Both workflows are
built, tested and dispatched; both halt at their port and report terminal `failed`. Two of the thirteen
stories are non-functional, and they are the two that carry the "autonomous" half of the product's name.

Blocks T214, T220, T221.

### A5. T200 — validation runs cannot authenticate

**Status: open. Verified.**

`scoped_credentials.workflow_id` is `not null`; `workflowIdFromSubject`
(`packages/sisyphus-api/src/server/machine/credential-claims.ts:124`) returns `undefined` for anything that is
not `workflow:<id>`, and `run/assemble.ts:280` throws `validationModeUnsupportedError()` for a validation-mode
envelope.

Consequence: **a setup bundle can be registered but never proven.** FR-147's validation run — quickstart 1b,
and the setup-output redaction check at 1d — is unreachable. Since a bundle is what installs client
credentials onto an instance, "registered but unvalidated" is the state every client bundle is permanently in.

This is more work than it looks: it needs a nullable `workflow_id` plus a rework of the
`scoped_credentials_live_key` partial index, a `validationProcedure` builder, a `VALIDATION_OUTCOMES` tuple
(`validation_outcome` is currently the only pgEnum with no mirroring tuple, breaking that module's own stated
invariant), and a report input schema.

Blocks T226 (Scenario 1).

### A6. T197 — `InstanceMetadataReader` is a fake, so spot reclamation is never detected

**Status: open. Verified — `createQuietMetadataReader` is referenced by `run/execute.ts` and
`session/interruption.ts`, and no IMDS implementation exists.**

`watchForInterruption` is wired end to end and tested against a fake reader that never reports a notice. Spike
S2 recorded the real notice format as *unobserved*.

Consequence: **on interruptible capacity, a reclaimed instance loses its work silently.** The entire
snapshot-and-restore machinery (US3, FR-054) exists and is correct; the trigger that fires it in the one case
it was built for is not connected.

> **Corrected 2026-08-09.** This item originally qualified the severity as depending on whether
> `purchase_mode` would ever be `spot`. That qualification was wrong: spot **is** the default —
> `packages/sisyphus-api/src/enums/purchase-mode.ts:17` sets `DEFAULT_PURCHASE_MODE = 'spot'`, and spec
> 003/FR-039 states it as the platform default. So this is a data-loss bug in the default configuration, not a
> conditional one, and it belongs beside A1 rather than at the bottom of Tier A. See the companion document, §4.

Blocks T219 step 2.

---

## 4. Tier B — Story-blocking, but narrower

### T204 / T205 — panel query-state coverage (FR-201)

Five panels (`UsersPanel`, `ProfilesPanel`, `WorkspacesPanel`, `IntegrationsPanel`, `ProfileAccessPanel`) hold
their own queries and their tests assert only "is a component". T205 is the sharper one: a failed
`adHocWorkspaces` or `bundles` read on `/workflows/new` currently renders **empty selects** — which reads to
an admin as "there are no bundles", not "the query failed". That is the exact defect T155 fixed everywhere
else, still live on the one screen that launches runs. Small fix, user-visible wrongness.

### T209 — pending supervision command invisible to a second operator

`workflow.byId` reports recorded state only, so the window between issuing Pause and the executor
acknowledging it is visible only to the tab that issued it. A second operator watching the same run sees
`RUNNING` where the first sees `PAUSE REQUESTED`. Honest but under-informative; in a supervised-agent product
where two people watch one expensive run, it invites a double-pause. **Nice-to-have with a real operational
edge.**

### T201 / T202 — sanitisation and naming on the machine surface

- T201: `skillReferences.unavailableReason` is unbranded free text that can embed a raw `readFile` error
  message. Every other free-text field on that surface is `SanitisedText`. A path leak, not a credential leak
  — but it is the same class of hole as A1, one field wide.
- T202: an FR-088 bundle failure names an S3 key rather than the bundle an administrator would recognise.
  Diagnosability only.

### T210 — the pause idle ceiling has two homes

`PAUSE_IDLE_CEILING_MS = 30 * 60 * 1000` appears in **both** `apps/sisyphus-executor/src/session/idle-ceiling.ts:54`
and `apps/sisyphus-control-plane/src/jobs/reconcile.ts:140`. Verified. The executor arms the timer, the
control plane backstops it, and they agree only by inspection. If they drift, the backstop either fires early
(parking a legitimately paused run) or never (defeating FR-049). Its shared home is `packages/sisyphus-api`.
Cheap to fix, and the cost of the drift is a class of bug that reproduces once a month.

---

## 5. Tier C — Evidence, not code. The fourteen runs nobody has performed.

This is the largest and most important block of open work, and it is easy to under-weight because none of it
is a feature.

### The eleven assembly tasks (T213, T214, T218–T226)

One per story, each a recorded manual run of a quickstart scenario on a deployed stage. **Not one of the
thirteen user stories has ever been run end to end.** `tasks.md` is candid about this: the eleven prose
checkpoints at lines 230, 339, 367, 393, 431, 462, 490, 540, 563, 581 and 601 each asserted a story worked and
none had a task behind it — which is how Phase 4 stayed "complete" for eleven phases while its checkpoint was
not executable.

Dependency structure (from the phase table):

| Run | Story | Scenario | Needs |
| --- | --- | --- | --- |
| T213 | US1 | 2 | A2 (forge URL) — then nothing else |
| T223 | US9 | 3 | T213's path |
| T225 | US11 | 4 | T213's path |
| T218 | US2 | 5 | T213's path |
| T219 | US3 | 6 | **T197** for step 2 |
| T224 | US10 | 7 | T213's path |
| T214 | US8 | 8 | **T196 + T198** |
| T220 | US4 | 9a | **T196** |
| T221 | US5 | 9b | **T196** |
| T226 | US7/12/13 | 1 | **T200**, plus T213 + T223 for the leak test |
| T222 | US6 | 10 | last — needs accumulated history from the others |

**T213 is the keystone.** It is the only one of the eleven with no code blocker in front of it — the ports it
needs are closed. The single thing between the repository and a first proven end-to-end delegated run is the
operator step in A2.

**Classification**: these are not nice-to-have. They are the only evidence this feature will ever have. But
they are also *not buildable work* — each needs a deployed stage, and several need real external resources (a
Jira project, a Slack workspace, interruptible capacity, two scratch repositories).

### The three gate verifications (T215–T217) — highest value per minute in the entire open set

Each takes minutes. Each plants a deliberate failure and confirms the gate goes red.

- **T215** (assembly gate): guards a failure mode *already observed once* — `knip --production` honours only
  entry patterns carrying a trailing `!`, and without one it analyses zero files and exits clean. The knip
  config currently carries the suffix and `ci.yml:133-142` documents why; nobody has proved it by planting an
  orphan.
- **T216** (database gate): confirm the suites **fail** rather than skip when `CI` is set and
  `SISYPHUS_TEST_DATABASE_URL` is not. The figure that matters is `sisyphus-api`'s 1,519/0 with a database
  against 951/568 without — 568 assertions that used to never run.
- **T217** (latency gates): confirm each measured test goes red when its budget is breached.

**Do these first.** Three of this feature's gates passed convincingly while measuring nothing; that is the
recurring theme of Phases 18 and 19, and these three tasks are the only thing that distinguishes a working
gate from a decorative one. Until they pass, every other green result in this report — including CI — is
uncorroborated.

### T227 — the executor test suite is flaky

`delivery/git.test.ts`, `delivery/staleness.test.ts`, `delivery/pull-request.test.ts` and
`run/bootstrap.test.ts` spawn a real `git` and intermittently exceed vitest's 5,000 ms default. Reproduced
2026-08-07: four files failed on one run, 937/937 passed on the next with no code change, and Nx's own flaky
detector flagged `sisyphus-executor:test`.

**This belongs in Tier A on a bad day.** A gate that intermittently lies means a red CI run cannot be trusted
to mean a real failure — which is the condition under which people start re-running CI until it goes green,
and that is how every other defect in this report survives. Cheap fix (explicit per-test timeouts, not a
suite-wide raise).

### T228 — Constitution III is not mechanised

No check fails when a shipped source file has no colocated `<name>.test.ts`. The pre-commit hook structurally
cannot catch this: it runs the colocated test of every staged file, which does nothing when there is no such
test. That is how T173's `main.ts` shipped untested under the workspace's one NON-NEGOTIABLE principle —
found by cross-artifact analysis, not by any gate. Needs one recorded exemption list (`sisyphus-infra`'s
resource-creating primitives per FR-200) written as named files, never a glob.

---

## 6. Tier D — Hygiene and cleanup

| Task | What | Note |
| --- | --- | --- |
| T140 | Run all 13 quickstart scenarios in one sitting | Superseded in substance by the eleven per-story runs; keep as the full sweep |
| T141 | Design audit — no literal hex/px, WCAG AA both themes, state colours only for machine state | `design-lint` reports 0 errors / 31 pre-existing warnings; this is the human half the linter cannot check |
| T142 | Full gate run `lint typecheck test design-lint --base=main` + `pnpm qlty:diff`, no `QLTY_*` override | Largely evidenced by T193 (5,695 passing across 14 projects), but T193 used `run-many`, not `--base=main`, and did not run `qlty:diff` |
| T143 | Knip and cspell clean | **See the contradiction below** |
| T203 | Wire `deploy.yml` to `getDeployRoleName` | Verified: `deploy.yml` contains no role assumption at all. The single-constant discipline T167 established pays off only once CI uses it |
| T211 | Two stale source comments | `dispatch.ts:28` names `buildControlPlaneTickSpecification`, which no longer exists; `scheduler.ts:7` still lists admin bootstrap among the tick's responsibilities (T172 deliberately excluded it — running it every minute would reinstate a deactivated bootstrap admin within the minute). Both verified. Trivial, but the second one is actively misleading about a security-relevant decision |
| T212 | cspell | Explicitly marked **out of scope for this feature** |

### The T143 / T212 contradiction — worth resolving explicitly

T143 requires "knip and cspell clean". T212 establishes that gating cspell is a workspace-wide change that
must not ride in on this feature, and was reverted after a trial. **As written, T143 cannot be satisfied
inside this feature's scope.** Verified: `package.json` has no `cspell` devDependency and no cspell script;
`ci.yml` contains no cspell step. The knip half is already evidenced (`pnpm knip:orphans` exits 0 per T193).

**Recommendation**: rescope T143 to the knip half and close it, and let T212's findings become a separate
workspace-level ticket.

Two defects T212 found and deliberately left unfixed, which no open task owns:

- `scripts/audit-cspell.mjs:19` calls `JSON.parse` on `cspell.json`, which is JSONC (it carries 3 comment
  lines). **Independently confirmed**: `JSON.parse` throws `Expected double-quoted property name in JSON at
  position 124`. The script has therefore thrown on every invocation since the config gained its first
  comment — a **fourth** check in this repository that looks present and measures nothing.
- The same script's file walk scans `*.tsbuildinfo`, counting words kept alive only by build output as live.

---

## 7. Gaps the task list does not track

1. **The operator step (A2)** — no task, only prose inside a checked one. Highest-impact untracked item.
2. **The infrastructure has never been deployed.** Per FR-200 its constructs are deploy-verified by design and
   carry no unit tests, and Phase 17 rewrote all of them. The first deploy is the first exercise of that code.
   No task owns "first deploy"; T213 will absorb the risk implicitly and its failure will be ambiguous between
   infra and application.
3. **Traceability**: 84 of the spec's 205 `FR-` ids are never named by any task, and 15 of 65 `SC-` ids are
   never named. This is almost certainly a documentation artifact rather than an implementation gap — spot
   checks (FR-013 filtering, FR-030 state chip, FR-121 profiles, FR-171 user management) all resolve to
   implemented, tested code inside a named task's module. Recording it because a reader auditing coverage by
   grep will hit it, and because there is no cheap way to distinguish "covered implicitly" from "forgotten" in
   the remaining set without a per-FR pass.

---

## 8. Suggested order

1. **T215, T216, T217, T227** — hours, not days. Nothing else you learn is trustworthy until the gates are
   proven and the suite stops lying.
2. **A2** (forge URL — write the task, then do it) **→ T213**. This is the first proof the product works at
   all, and it is one operator step away.
3. **T231.** Do not let a second run stream a log before known-value redaction is live.
4. **T198 → T196.** Turning US8, US4 and US5 from dead to alive. T198 first: it is a package move plus a
   one-line override, and it unblocks the integration path that T196's autonomous loop is fed by.
5. **T200**, then **T226** — bundles stop being unprovable.
6. **T197** if and only if `purchase_mode` will ever be `spot`.
7. The remaining eight assembly runs, T222 last.
8. Tier D, with T143 rescoped and T211's second comment corrected.

---

## 9. Assessment of the task list itself

Worth recording, because it changes how much to trust the 198 checked boxes.

`tasks.md` is unusually honest — Phases 18 and 19 exist *because* earlier phases were checked complete while
their subjects had no production caller, and the document says so in its own words rather than quietly
re-scoping. The four rules at the head of Phase 19 (every port names its filling task; nothing is done while
its subject has no production caller; each checkpoint is a task, not a sentence; every gate is verified
against a planted failure) are a direct and correct response to how this feature went wrong twice.

Rules 1–3 are now mechanised (`knip:orphans` in CI, the eleven assembly tasks). **Rule 4 is not** — it is
T215–T217, and all three are open. That is the single loose thread in the corrective machinery, and it is
also the cheapest thing on this list.

Spot-checking found no case where a checked task's subject was absent from the tree. The checked boxes appear
to be accurate about *what was built*; the open ones are accurate about *what was never wired or never run*.
