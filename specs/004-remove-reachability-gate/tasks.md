---
description: 'Task list for removing the repository-reachability half of the profile enable gate'
---

# Tasks: Remove the repository-reachability half of the profile enable gate

**Input**: Design documents from `/specs/004-remove-reachability-gate/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/profile-enable.md](./contracts/profile-enable.md)

**Tests**: Test tasks are **included and mandatory** here — not as TDD, but because Constitution III requires
colocated tests and [research.md](./research.md) R9 established that deleting the reachability cases without
restating what they incidentally covered would silently reduce coverage of the checks being kept. Test edits
travel in the same task as the module they cover wherever the two must stay in step.

**Organization**: Grouped by user story. Note the shape of this feature: it is a **removal**, and the server
deletion is atomic (a closed `as const` set and the types feeding it cannot be half-removed and still compile).
That atomic block is Phase 2, which is why it is larger than a typical foundational phase.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- Exact file paths are given in every task

## Path Conventions

Nx + pnpm monorepo. Two workspace members are touched:

- `packages/sisyphus-api/` — the gate and its tests
- `apps/sisyphus-admin/` — the panel that renders the refusal

Plus three peripheral files: two doc comments and `knip.json`. All commands run via `pnpm nx` from the
repository root (Constitution I).

---

## Phase 1: Setup & Baseline

**Purpose**: Establish that the defect is real, and that the suites which will prove it fixed are actually
executing. Skipping this phase risks "fixing" against a test run that silently asserts nothing.

- [x] T001 Reproduce the defect and record the exact refusal. Drive
      `packages/sisyphus-api/src/server/admin/profiles.ts` `setEnabled(true)` — via the panel, or via the
      existing caller harness in `packages/sisyphus-api/src/server/admin/profiles.test.ts` — against a profile
      with an enabled bundle and ≥1 workspace entry, and confirm it fails with `CONFLICT` carrying
      `no repository reachability checker configured`, one line per entry. The refusal originates at
      `packages/sisyphus-api/src/server/admin/reachability.ts` `createRefusingReachabilityProbe`. Paste the
      message into the PR description as the before-state.
- [x] T002 [P] Attach a database and confirm the enable suites are **not** skipping:
      `export DATABASE_URL=…`, `pnpm nx run sisyphus-api:migrate`, then
      `pnpm nx test sisyphus-api -- profiles --reporter=verbose` and verify the profile enable tests report as
      run rather than skipped. See [quickstart.md](./quickstart.md) — these suites skip rather than fail
      without a database, so a green run without one proves nothing.
- [x] T003 [P] Capture the pre-change reference sweep for comparison at T025:
      `grep -rni "reachability\|workspace_entry\|createProfilesRouter\|ProfilesRouterOptions" --include="*.ts" --include="*.tsx" apps packages knip.json | tee /tmp/before-sweep.txt`

**Checkpoint**: The bug is reproduced, and the tests that will prove it fixed are known to execute.

---

## Phase 2: Foundational — remove the seam (Blocking Prerequisites)

**Purpose**: Delete the probe and every reference to it, so the workspace compiles again.

**⚠️ CRITICAL**: This phase is **atomic**. `PROFILE_ENABLE_ELEMENTS` is a closed `as const` set feeding an
exhaustive `Record`, and `ProfilesRouterOptions` carries the probe type — so T004–T010 cannot be landed
individually and still typecheck. Complete the whole phase, then gate on T011. No user story work can begin
until T011 passes.

- [x] T004 [P] Delete the seam and its test:
      `packages/sisyphus-api/src/server/admin/reachability.ts` and
      `packages/sisyphus-api/src/server/admin/reachability.test.ts` (module and colocated test together,
      never one without the other — Constitution III).
- [x] T005 [P] Delete the recording fake and its test:
      `packages/sisyphus-api/src/server/admin/reachability-fake.ts` and
      `packages/sisyphus-api/src/server/admin/reachability-fake.test.ts`.
- [x] T006 Strip the probe from `packages/sisyphus-api/src/server/admin/profile-gate.ts`: remove the
      `probe` parameter, the `probeTargets` call and the per-entry failure loop; remove `workspace_entry` from
      `PROFILE_ENABLE_ELEMENTS`; drop the now-unused `describeWorkspaceEntry` and reachability imports; change
      `checkProfileCanBeEnabled` from `(subject, probe) => Promise<ProfileEnableCheck>` to
      `(subject) => ProfileEnableCheck` (R3). Rewrite the module header: it currently opens by describing the
      two-half check and the outbound seam. Keep the "why it refuses by name" and "why it is a pure function"
      reasoning — both are now more true, not less.
- [x] T007 Collapse the router in `packages/sisyphus-api/src/server/admin/profiles.ts`: delete
      `ProfilesRouterOptions` and `createProfilesRouter`, exporting `profilesRouter` directly as the other
      sub-routers are; in `setEnabled`, replace
      `ctx.dependencies.repositoryReachability ?? options.reachability` with nothing and drop the `probe`
      argument from `runEnableGate`; keep `runEnableGate` `async` (it still awaits two reads) but stop
      awaiting its final expression. Remove the doc block explaining the refusing default (R4).
- [x] T008 Remove `repositoryReachability` from `SisyphusDependencies` in
      `packages/sisyphus-api/src/server/context.ts`, along with its import. **Rewrite the `notifier` field's
      doc comment**, which explains itself by contrast with this field — a dangling `{@link}` to a deleted
      member is both a lint failure and a lost explanation (R5).
- [x] T009 Drop the five dead exports from `packages/sisyphus-api/src/server/admin/index.ts`:
      `createRefusingReachabilityProbe`, `probeTargets`, the `RepositoryReachabilityProbe` type,
      `createProfilesRouter`, and the `ProfilesRouterOptions` type. Leave `profilesRouter` and the
      `ProfilesRouter` type exported.
- [x] T010 Update the third caller of the deleted factory:
      `packages/sisyphus-api/src/server/workflow/launch-configuration.test.ts` — import `profilesRouter` from
      `../admin/profiles` and pass it to `createCallerFactory` directly, deleting the
      `createFakeReachabilityProbe` import and the options object.
- [x] T011 **Gate**: `pnpm typecheck` passes across the workspace. Any surviving reference to
      `workspace_entry`, `RepositoryReachabilityProbe` or the deleted factory is a compile error here, which is
      the point — do not proceed to Phase 3 until this is clean.

**Checkpoint**: The seam is gone and the workspace compiles. Tests are expected to be **red** at this point;
Phases 3 and 4 fix them.

---

## Phase 3: User Story 1 — An administrator enables an execution profile (Priority: P1) 🎯 MVP

**Goal**: `setEnabled(true)` succeeds for a correctly configured profile. This is the entire feature —
currently 0% of profiles can be enabled in any deployment.

**Independent Test**: Create a profile against an enabled bundle and a workspace with at least one repository,
enable it, confirm it reports enabled and becomes selectable on the launch form.

### Implementation for User Story 1

- [x] T012 [US1] Rebuild the caller in `packages/sisyphus-api/src/server/admin/profiles.test.ts`: replace
      `createCallerFactory(createProfilesRouter({ reachability: probe }))` with
      `createCallerFactory(profilesRouter)`, and delete the `FakeReachabilityProbe` import, the `probe`
      binding and every `probe.setOutcome(…)` call. Update the suite's header comment, which currently
      explains that it substitutes a reachability fake for a network.
- [x] T013 [US1] Replace the two entry-unreachable enable tests in
      `packages/sisyphus-api/src/server/admin/profiles.test.ts` with the assertions US1 actually needs: a
      profile pinning an enabled bundle and a non-empty workspace **enables** and records one configuration
      change against the validated version; a profile whose workspace names a **nonexistent repository also
      enables** (the platform makes no attempt to verify it — spec Acceptance Scenario 2); enabling an
      already-enabled profile succeeds and records **no** second audit entry.
- [ ] T014 [US1] Confirm in the running panel: `pnpm nx dev sisyphus-admin`, sign in as an admin, open
      **Admin → Profiles**, enable a multi-repository profile. It turns on, and the per-entry
      `E_PROFILE_ENABLE_WORKSPACE_ENTRY` list from T001 does not appear. This closes the loop on the reported
      failure; the unit tests cannot prove the panel path end to end.
      **Not performed** — requires a browser and admin credentials, which the implementing session did not
      have. The router the panel calls is now the one the database-backed tests exercise (the substituted
      test router is gone), and `E_PROFILE_ENABLE_WORKSPACE_ENTRY` can no longer be constructed anywhere in
      the workspace, so the remaining risk is panel wiring rather than gate behaviour. **This is the one task
      an operator must still do before the fix is called confirmed.**

**Checkpoint**: US1 is complete and independently demonstrable — profiles can be enabled. This is a shippable
MVP even if Phases 4–6 are deferred.

---

## Phase 4: User Story 2 — The retained checks still stop what they should (Priority: P2)

**Goal**: The five local checks still refuse, still name the failing element, and still report together; the
panel still renders each refusal with a code and a next action.

**Independent Test**: For each retained check, construct a profile that violates it, attempt to enable, and
confirm the refusal names the failing element and states a next action.

**⚠️ Coverage note (R9)**: Do not merely delete the reachability cases. Several retained behaviours are today
asserted only as the incidental passing half of a reachability test — multi-failure collection is covered
_solely_ by `"reports a disabled bundle and an unreachable entry together"`. Each retained refusal must end up
with its own assertion built from a **known failure**, per the `specs/002` plan's rule that a gate is only
trusted once tested against one.

### Implementation for User Story 2

- [x] T015 [US2] Rewrite `packages/sisyphus-api/src/server/admin/profile-gate.test.ts` around the six retained
      refusals, one known failure each: no published version → `profile_version`; unreadable pinned rows →
      `profile_version`; bundle disabled → `setup_bundle`; bundle archived → `setup_bundle` **and not also the
      disabled reason**; workspace archived → `workspace_version`; workspace version with zero entries →
      `workspace_version`. Add the multi-failure case (disabled bundle **and** empty workspace reported
      together) that currently rides on the reachability test. Delete the probe imports and every
      `createFakeReachabilityProbe` / `createRefusingReachabilityProbe` use; assertions become synchronous
      alongside T006's signature change.
- [x] T016 [US2] In `packages/sisyphus-api/src/server/admin/profiles.test.ts`, add the database-backed refusal
      cases so the router path is covered, not only the pure function: `setEnabled(true)` on a profile with a
      disabled bundle, and on one whose workspace version holds no repositories, each refused with `CONFLICT`
      naming the element and leaving the profile unchanged. Assert `setEnabled(false)` still succeeds on a
      profile that cannot currently be enabled (FR-009).
- [x] T017 [P] [US2] Remove `workspace_entry` from
      `apps/sisyphus-admin/src/components/admin/profiles/enable-refusal.ts`: drop it from
      `ENABLE_FAILURE_ELEMENTS`, drop its `ACTIONS` entry, and drop its branch from `classifyEnableFailure`.
      Update the module header, whose worked example quotes an unreachable-entry line. Leave `unclassified`,
      `enableFailureCode` and the fallback behaviour untouched — they are what keep FR-010 satisfied.
- [x] T018 [P] [US2] Update `apps/sisyphus-admin/src/components/admin/profiles/enable-refusal.test.ts`: delete
      the `workspace_entry` classification and multi-element cases, and **add** an explicit assertion that a
      line matching no known phrasing still renders as `unclassified` with its verbatim text, a code and an
      action. That fallback is now the only thing standing between an unrecognised server wording and a
      dropped line.
- [x] T019 [P] [US2] Restate the `element: 'workspace_entry'` fixture in
      `apps/sisyphus-admin/src/components/admin/profiles/profile-card.test.tsx` on a retained element
      (`setup_bundle` is the closest analogue — a named element with a concrete next action).

**Checkpoint**: US1 and US2 both hold — profiles enable, and the checks that remain still bite and still
render.

---

## Phase 5: User Story 3 — The safety net is real (Priority: P3)

**Goal**: Confirm the failure mode this change deliberately accepts is handled well at checkout. **No code
changes** — this story is verification that the premise holds.

**Independent Test**: A run whose workspace names an unreadable repository fails at checkout naming the entry,
and leaves no partial workspace behind.

- [x] T020 [US3] Run `pnpm nx test sisyphus-executor -- workspace` and confirm three guarantees are intact and
      untouched by this feature: a failing clone produces an `entry_checkout` failure naming the entry id, the
      repository and the branch alongside git's own message; the agent cannot start because
      `startAgentPhase` requires a `ReadyWorkspace` that only a complete checkout constructs; and a second
      entry failing after a first succeeded unwinds the first, with a removal that itself fails reported
      rather than swallowed. If any has regressed, **this feature's premise has failed and the change must not
      ship** — the accepted cost of removing the gate is precisely that this path stays good.

**Checkpoint**: All three stories hold.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Stale references, configuration, and the gates that catch a half-finished removal.

- [x] T021 [P] Rewrite the doc comment in `packages/sisyphus-api/src/server/notify/emitter.ts` that cites
      `admin/reachability.ts` as the precedent for its own default. Carry the distinction that was missed
      (R7): refusing closed is right where the refusal is survivable — an unwired notifier withholds a message
      and breaks nothing — whereas the profile gate sat on the primary launch path, where "safe default" and
      "product inoperable" were the same state.
- [x] T022 [P] Rewrite the same stale precedent in
      `apps/sisyphus-control-plane/src/jobs/prompt-redact.ts`, which cites
      `createRefusingReachabilityProbe` by name.
- [x] T023 Delete the `"!src/server/admin/reachability-fake.ts!"` production-only exclusion from the
      `packages/sisyphus-api` block of `knip.json` (R8). The constitution requires configuration and code to
      be corrected in the same change; an exclusion naming a deleted file is stale config on the one gate
      whose credibility depends on describing reality.
- [x] T024 Confirm nothing was over-deleted: run `pnpm knip` and verify `describeWorkspaceEntry` in
      `packages/sisyphus-api/src/server/admin/workspace-entries.ts` is **not** reported as unused. It loses
      its `profile-gate.ts` caller in T006 but keeps three callers inside its own module, so it must survive.
- [x] T025 Run the reference sweep and diff it against T003's baseline:
      `grep -rni "reachability\|workspace_entry\|createProfilesRouter\|ProfilesRouterOptions" --include="*.ts" --include="*.tsx" apps packages knip.json`
      — expect **no output**. Also `grep -rn "reachability" knip.json` — expect no output.
- [x] T026 Run the full blocking gate as CI does: `pnpm typecheck`, `pnpm lint:check`, `pnpm knip:orphans`,
      `pnpm nx affected -t lint test typecheck` (with `DATABASE_URL` set), and `pnpm qlty:diff`. `qlty:diff`
      must pass with **no** `QLTY_*` override — a change that is overwhelmingly deletion should clear both
      thresholds comfortably, and needing an override would mean something was rewritten rather than removed
      (Constitution IV).
      **`qlty:diff` not run**: the `qlty` binary is not installed in the implementing environment
      (`spawnSync qlty ENOENT`). No `QLTY_*` override was used or added. Every other gate ran. Two gates fail
      **identically at `HEAD`** and are unrelated to this change — confirmed by stashing the work and
      re-running: `pnpm knip` (4 unused files, 4 unused deps, 10 unused devDeps, 27 unused exports, all
      pre-existing) and `pnpm knip:orphans` (4 `db/migrations/*` files). `sisyphus-infra:lint` likewise fails
      at `HEAD` on unused imports in `policies.test.ts`.
- [x] T027 Work through [quickstart.md](./quickstart.md) scenarios 1–5 end to end and confirm each expectation,
      then mark FR-124's amendment verified in
      `specs/002-sisyphus-workflow-platform/spec.md` if any wording drifted during implementation.
      FR-124's amended text matches what shipped exactly — five checks, every failing element named, all
      reported together — so no wording needed correcting. Two defects **in the quickstart itself** were
      found and fixed while working through it: it named `DATABASE_URL`, which neither the migration CLI
      (`SISYPHUS_DATABASE_URL`) nor the suites (`SISYPHUS_TEST_DATABASE_URL`) read, so following it literally
      would have produced the silent all-skip it was written to prevent; and its reference sweep demanded
      "no output" while four families of legitimate match exist, which would have read as a failed removal.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Phase 1. **Atomic and blocking** — T004–T010 land together, gated by
  T011. No story work begins before T011 is green.
- **US1 (Phase 3)**: Depends on T011.
- **US2 (Phase 4)**: Depends on T011. Independent of US1 — its server tasks (T015, T016) touch the same two
  test files as US1's, so sequence those; its panel tasks (T017–T019) are fully independent of US1.
- **US3 (Phase 5)**: Depends on nothing in this feature — it changes no code and could be run first as a
  premise check. Placed at P3 because it verifies existing behaviour rather than delivering new value.
- **Polish (Phase 6)**: T021–T023 depend only on T011. T024–T027 depend on all desired stories being complete.

### User Story Dependencies

- **US1 (P1)**: Independent after T011. Delivers the whole user-visible fix.
- **US2 (P2)**: Independent after T011. Shares `profiles.test.ts` with US1 (T013 before T016).
- **US3 (P3)**: Fully independent — verification only, no shared files.

### File-Level Conflicts (do not parallelise these)

| File                                               | Tasks              |
| -------------------------------------------------- | ------------------ |
| `packages/sisyphus-api/.../admin/profiles.test.ts` | T012 → T013 → T016 |
| `packages/sisyphus-api/.../admin/profile-gate.ts`  | T006 only          |
| `packages/sisyphus-api/.../admin/profiles.ts`      | T007 only          |

### Parallel Opportunities

- **Phase 1**: T002 and T003 in parallel after T001.
- **Phase 2**: T004 and T005 in parallel (different files). T006–T010 touch distinct files and may be worked
  concurrently, but they must **land together** — the intermediate states do not compile.
- **Phase 4**: T017, T018 and T019 are all panel-side and independent of the server tasks T015/T016. A second
  person can take the whole panel slice.
- **Phase 6**: T021 and T022 in parallel (different apps).

---

## Parallel Example: Phase 4

```bash
# Server slice (sequential — shared test files):
Task: "T015 Rewrite profile-gate.test.ts around the six retained refusals"
Task: "T016 Add database-backed refusal cases to profiles.test.ts"

# Panel slice (parallel with the above, and internally parallel):
Task: "T017 Remove workspace_entry from enable-refusal.ts"
Task: "T018 Update enable-refusal.test.ts, adding the unclassified fallback assertion"
Task: "T019 Restate the workspace_entry fixture in profile-card.test.tsx"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 — reproduce the defect, confirm the suites execute.
2. Phase 2 — the atomic removal, gated on `pnpm typecheck`.
3. Phase 3 — US1.
4. **STOP and VALIDATE**: profiles enable, in tests and in the panel.
5. Shippable here. The remaining phases restore coverage and tidy references; they do not change behaviour.

### Incremental Delivery

1. Setup + Foundational → the workspace compiles without the seam.
2. US1 → **the reported bug is fixed** → demo.
3. US2 → coverage of the retained checks is restored and the panel is clean.
4. US3 → the accepted failure mode is confirmed good.
5. Polish → stale precedents, `knip.json`, full gates.

### Suggested Commit Boundaries

Constitution V requires `feature/sisyphus: ` prefixed subjects. Four commits map naturally:

1. Phase 2 whole (atomic — cannot be split and still compile).
2. Phase 3 (US1).
3. Phase 4 (US2), optionally split server / panel.
4. Phases 5–6.

---

## Notes

- `[P]` = different files, no dependencies.
- The pre-commit hook runs lint-staged, the affected Vitest suites, `pnpm typecheck` and `pnpm qlty:diff`.
  Committing with `--no-verify` is prohibited (Constitution III).
- **Delete modules and their colocated tests in the same task**, never one without the other.
- Watch for the skip trap: `sisyphus-api` enable suites skip without `DATABASE_URL`, so a green local run can
  mean nothing was asserted. T002 exists to rule that out before anything is trusted.
