<!-- cspell:ignore taskstoissues -->

# Tasks: AI Skill Installer

**Input**: Design documents from `/specs/001-ai-skill-installer/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/cli.md](./contracts/cli.md), [contracts/catalog.schema.md](./contracts/catalog.schema.md), [quickstart.md](./quickstart.md)

**Tests**: INCLUDED — the design explicitly requests them (research R9, quickstart B, cli.md "Contract test expectations"). The installer is POSIX shell; `vitest` shells out to `lib/skills.sh` against temp targets in the source repo / CI only. No target-side Node.

**Organization**: Tasks grouped by user story. Deterministic-core work shared by all stories lives in Foundational; each story then adds its own subcommand + tests.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: `[US1]`–`[US4]` maps to a spec user story; Setup/Foundational/Polish carry no story label

## Path Conventions

New package rooted at `tooling/skills/` (an existing pnpm/Nx workspace glob), mirroring `tooling/qlty-diff`. Shell files run on targets; TypeScript exists only for CI tests. Test files are split per concern (colocated in `lib/`) so they parallelize and stay small.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Stand up the `@bluetel-ai/skills` package skeleton so shell + tests have a home.

- [x] T001 Create the package directory tree in `tooling/skills/`: `catalog/`, `bootstrap/`, `skill/`, `lib/` (empty `.gitkeep` where needed) per [plan.md](./plan.md) Project Structure.
- [x] T002 Create `tooling/skills/package.json` — name `@bluetel-ai/skills`, `"type": "module"`, private, `devDependencies` matching `tooling/qlty-diff` (vitest, typescript, `@bluetel-ai/eslint-config-internal`, `@bluetel-ai/prettier-config`); no runtime deps (installer is shell-only).
- [x] T003 [P] Create `tooling/skills/project.json` with `typecheck` (`tsc --noEmit`, cwd `tooling/skills`) and `test` (`vitest run`, cwd `tooling/skills`) targets, copied from `tooling/qlty-diff/project.json`.
- [x] T004 [P] Create `tooling/skills/tsconfig.json`, `tooling/skills/vitest.config.ts`, and `tooling/skills/eslint.config.mjs` mirroring `tooling/qlty-diff` (strict TS, ESM, extend `@bluetel-ai/eslint-config-internal`).
- [x] T005 [P] Create `tooling/skills/README.md` describing the package purpose (single distribution source; `catalog/`, `bootstrap/`, `skill/`, `lib/` layout) and that the installer is Claude + `git`/`curl`/POSIX shell with no target-side Node.

**Checkpoint**: `pnpm install` resolves the new package; `pnpm nx typecheck skills` and `pnpm nx test skills` run (no tests yet, exit 0).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The deterministic core in `tooling/skills/lib/skills.sh` shared by every story — hashing, catalog scan, semver compare, state derivation, atomic writes, stub generation, CLI dispatch. Per [contracts/cli.md](./contracts/cli.md) + [contracts/catalog.schema.md](./contracts/catalog.schema.md) + [data-model.md](./data-model.md).

**⚠️ CRITICAL**: No user-story subcommand (`list`/`status`/`install`/`update`) can be built until this phase is complete. All work below is in the single file `tooling/skills/lib/skills.sh` unless noted, so these tasks are sequential (not `[P]`).

- [x] T006 Scaffold `tooling/skills/lib/skills.sh`: `#!/bin/sh`, `set -eu`, usage/help text, arg parser for `<command> [name...] [--force] [--target <dir>] [--catalog <dir>]` (`--target` defaults `$PWD`, `--catalog` defaults to snapshot `catalog/` resolved relative to the script), and a command dispatch stub with the stable exit-code table (0–5) from [contracts/cli.md](./contracts/cli.md).
- [x] T007 Implement `_sha256` tool probe (`sha256sum` → `shasum -a 256` fallback; exit `5` with guidance if neither) and `skill_hash <dir>` exactly per [contracts/catalog.schema.md](./contracts/catalog.schema.md) (`find … ! -name skill.meta ! -name .skill | LC_ALL=C sort`, NUL-separated path + raw bytes) in `tooling/skills/lib/skills.sh`.
- [x] T008 Implement `skill.meta` parsing + catalog scan (`while IFS='=' read -r key val`, skip `#`/blank, ignore unknown keys) with validation (kebab `name` == dir name, semver `version`, single-line `description`, `SKILL.md` present, `requires` resolve); malformed ⇒ exit `2` in `tooling/skills/lib/skills.sh`.
- [x] T009 Implement `semver_gt a b` numeric comparison via `awk` (MAJOR.MINOR.PATCH split; no `sort -V`) in `tooling/skills/lib/skills.sh`.
- [x] T010 Implement installed-record I/O (`.skill` KEY=value read/write incl. `installed_at` via `date -u +%Y-%m-%dT%H:%M:%SZ`) and `SkillState` derivation (`not-installed | up-to-date | outdated | locally-modified | inconsistent | unknown`) from catalog version + on-disk hash + record, per the [data-model.md](./data-model.md) table, in `tooling/skills/lib/skills.sh`.
- [x] T011 Implement the atomic staged-write engine: stage into `<target>/.agents/skills/.staging-<name>/`, `mv` content → `.agents/skills/<name>/`, stub → `.claude/skills/<name>/`, record → `.agents/skills/<name>/.skill`; create missing `.agents/skills`/`.claude/skills` without disturbing siblings; on any error `rm -rf` staging and roll back every skill written this invocation, exit `4`, in `tooling/skills/lib/skills.sh`.
- [x] T012 Implement `generate_stub` — emit `.claude/skills/<name>/SKILL.md` frontmatter (`name`, `description`, optional `argument-hint` omitted when empty; `'`→`''` escaping) + the standard pointer line, per [contracts/catalog.schema.md](./contracts/catalog.schema.md), in `tooling/skills/lib/skills.sh`.
- [x] T013 [P] Create a test fixture builder `tooling/skills/lib/test-helpers.ts` (named exports): make a temp catalog dir with N `catalog/<name>/{SKILL.md,skill.meta}` entries and a temp target dir; helper to run `sh lib/skills.sh …` capturing stdout/stderr/exit code. Used by all story test files.

**Checkpoint**: `lib/skills.sh` loads under `sh`, dispatches commands, and the primitives (hash, scan, semver, state, staged write, stub) are callable; `pnpm nx typecheck skills` passes.

---

## Phase 3: User Story 1 - Fresh install of selected skills (Priority: P1) 🎯 MVP

**Goal**: One command → interactive selection → chosen skills materialized into the target's `.agents/skills/<name>/` (content + `.skill` record) and `.claude/skills/<name>/` (stub), with a clear summary. Covers the end-to-end bootstrap → clone → Claude → install path.

**Independent Test**: In a clean target, run `install merging`; confirm `.agents/skills/merging/{SKILL.md,.skill}` + `.claude/skills/merging/SKILL.md` exist, nothing is written outside `.agents`/`.claude`, and a summary is printed (quickstart A.1–A.2, SC-001/SC-002).

### Tests for User Story 1 ⚠️ (write first, ensure they FAIL)

- [x] T014 [P] [US1] `tooling/skills/lib/skills.list.test.ts` — `list` on a clean target reports every fixture-catalog skill as `not-installed`; output is `NAME<TAB>STATE<TAB>CATALOG_VERSION<TAB>INSTALLED_VERSION<TAB>DESCRIPTION`; description read from `skill.meta` (SC-006).
- [x] T015 [P] [US1] `tooling/skills/lib/skills.install.test.ts` — after `install merging`: files land at the three expected paths, `.skill` record has `version`+`installed_hash`, nothing written outside `.agents`/`.claude` (SC-002); re-running `install merging` routes to `skip`, exit `0`, no duplicate (SC-003); `requires` are transitively included and reported.

### Implementation for User Story 1

- [x] T016 [US1] Implement `skills.sh list` in `tooling/skills/lib/skills.sh`: scan catalog, derive each skill's target state, emit the TSV line format from [contracts/cli.md](./contracts/cli.md).
- [x] T017 [US1] Implement `skills.sh install <name...> [--force]` in `tooling/skills/lib/skills.sh`: preconditions (name in catalog; `not-installed` else routed to `update`, never duplicated — FR-009), transitive `requires` expansion, staged atomic write via T011, `NAME<TAB>ACTION<TAB>VERSION` output + indented written-paths list.
- [x] T018 [US1] Create `tooling/skills/bootstrap/install.sh` (the single publishable `curl … | sh` file, POSIX, `set -eu`): verify `claude`, `git` (≥ 2.27), and a hash tool present with actionable guidance + clean exit if missing (FR-013/FR-014); shallow sparse `git clone --depth 1 --filter=blob:none --sparse` + `git sparse-checkout set tooling/skills` at a pinned ref into a temp dir (research R2 / data-model acquisition section); launch `claude` on the snapshot's `skill/SKILL.md`; no Node check.
- [x] T019 [US1] Create `tooling/skills/skill/SKILL.md` — the interactive install procedure: run `lib/skills.sh list`, present name+description selection, confirm, invoke `install`, then print the final human summary of what was installed and where + discoverability confirmation (FR-008/SC-004). Handle "no skills selected → exit, nothing changed" (spec AS-4).
- [x] T020 [US1] Add the non-interactive guard to `tooling/skills/skill/SKILL.md`: when no TTY and no explicit selection, fail clearly rather than hang (research R10); document the scriptable `lib/skills.sh install <name>` path.

**Checkpoint**: MVP — a developer can fresh-install chosen skills end-to-end; T014/T015 pass. Stop and validate quickstart A.1–A.2 + C against a fixture catalog.

---

## Phase 4: User Story 2 - Update already-installed skills (Priority: P2)

**Goal**: Re-running the command detects existing installs, shows current-vs-outdated, updates only selected skills, and refuses to silently clobber local modifications.

**Independent Test**: In a target with `merging` installed, bump the catalog `version` → `status` shows `outdated`; `update merging` refreshes it and leaves other skills untouched; a locally edited skill reports `conflict` (exit `3`) and offers keep / overwrite / resolve, with `resolve` producing an auto-merge or a conflict-marked file (quickstart A.3–A.4, SC-003/SC-008).

### Tests for User Story 2 ⚠️ (write first, ensure they FAIL)

- [x] T021 [P] [US2] `tooling/skills/lib/skills.status.test.ts` — bumping a catalog `skill.meta` `version` flips an installed skill to `outdated` in `status`; `status` lists only skills present in the target.
- [x] T022 [P] [US2] `tooling/skills/lib/skills.update.test.ts` — `update` overwrites `outdated` selected skills and leaves unselected ones byte-for-byte unchanged (FR-010); `--all` targets every installed `outdated` skill; a locally modified skill with no `--on-conflict` → `conflict`, file unchanged, exit `3`; `--on-conflict keep` → `keep`, file byte-for-byte unchanged, exit `0`; `--on-conflict overwrite` and `--force` → `update`, incoming written, exit `0` (FR-012/FR-012a).
- [x] T023 [P] [US2] `tooling/skills/lib/skills.merge.test.ts` — `--on-conflict resolve`: a non-overlapping local edit + bumped version yields `merge` (both changes, no markers, record advanced, exit `0`); an overlapping edit yields `merge-conflict` (file has `<<<<<<<`/`=======`/`>>>>>>>`, record NOT advanced, exit `6`); an unobtainable base (bad `source_ref`) reports merge unavailable, writes a `<file>.incoming` sidecar, and does not corrupt the target (FR-012b/SC-008).

### Implementation for User Story 2

- [x] T024 [US2] Implement `skills.sh status` in `tooling/skills/lib/skills.sh`: like `list` but only entries present in the target (installed/inconsistent/unknown), powering the current-vs-outdated view (FR-011).
- [x] T025 [US2] Implement `skills.sh update <name...>` + `update --all` with the `--on-conflict keep|overwrite|resolve` flag (`--force` = alias for `overwrite`) in `tooling/skills/lib/skills.sh`: `outdated`→overwrite content+stub+record; `up-to-date`→`skip`; unselected never touched (FR-010); conflict states with no mode → `conflict`/exit `3`; `keep`→`keep`; `overwrite`→`update`; atomic + rollback via T011 (FR-012/FR-012a).
- [x] T026 [US2] Implement the `resolve` path in `tooling/skills/lib/skills.sh`: reconstruct the merge base by a shallow sparse checkout of `catalog/<name>` at the record's `source_ref` (reuse the R2 clone mechanism), run per-file three-way `git merge-file`; clean → `ACTION=merge` + advance record; markers → `ACTION=merge-conflict`, leave file marked, do NOT advance record, exit `6`; base unobtainable → report unavailable, write `<file>.incoming` sidecar, fall back to keep/overwrite (research R11, FR-012b).
- [x] T027 [US2] Extend `tooling/skills/skill/SKILL.md` update flow: detect installed skills, present current-vs-outdated, and on a locally-modified skill prompt the three-way choice **keep / overwrite / resolve** before any write; after a `merge-conflict`, show the marked regions and optionally offer Claude-assisted resolution for the user to review (never auto-applied); reuse the single one-line entry point (FR-012a/FR-012b/FR-016).

**Checkpoint**: US1 + US2 both work; T021/T022/T023 pass; quickstart A.3–A.4 (a–e) validated.

---

## Phase 5: User Story 4 - Source repo stores skills in a tooling package (Priority: P2)

**Goal**: Consolidate this repo's canonical skills into `tooling/skills/catalog/` (the single distribution source) and repoint the repo's own `.claude` stubs at it, with zero canonical duplicates left in the repo root — while the source repo's own skills keep resolving (FR-006/FR-017/SC-007).

**Independent Test**: Inspect the repo — canonical content lives only under `tooling/skills/catalog/<name>/` (each with `skill.meta`); repo-root `.claude/skills/*` are stubs pointing at the catalog; invoking a migrated skill (e.g. `merging`) still works (quickstart D).

> ⚠️ Migration is delicate: the `speckit-*` skills are in active use this session. Move content and repoint stubs so they keep resolving. Do one skill first, verify it resolves, then batch the rest.

### Implementation for User Story 4

- [x] T028 [P] [US4] Migrate `merging`: move `.agents/skills/merging/` content → `tooling/skills/catalog/merging/`, author `catalog/merging/skill.meta` (name, `version=1.0.0`, description, `argument_hint` from the existing stub, `requires=`), and repoint `.claude/skills/merging/SKILL.md` at `tooling/skills/catalog/merging/SKILL.md`. Verify the skill still resolves before proceeding.
- [x] T029 [P] [US4] Migrate `pr-creation` and `review` the same way (content → `catalog/<name>/`, author `skill.meta`, repoint/create `.claude` stub; note `review` currently has no `.claude` stub).
- [x] T030 [US4] Migrate all `speckit-*` skills (analyze, checklist, clarify, constitution, converge, implement, plan, specify, tasks, taskstoissues): move each `.agents/skills/speckit-*/` content → `tooling/skills/catalog/speckit-*/`, author each `skill.meta`, repoint each `.claude/skills/speckit-*/SKILL.md` at the catalog. Sequential (touches shared skill-resolution used this session) — verify a `speckit-*` skill still resolves after.
- [x] T031 [US4] Repoint `.agents/skills/README.md` (shared-skill pattern doc) to reflect the new catalog home, and remove the now-empty repo-root `.agents/skills/<name>/` canonical dirs (SC-007: zero canonical duplicates in the root).
- [x] T032 [US4] Point the source-repo installer default `--catalog` resolution + `bootstrap/install.sh` sparse-checkout at `tooling/skills` and confirm `lib/skills.sh list` against the real `tooling/skills/catalog` matches the published set (FR-015/SC-006).

**Checkpoint**: Canonical content only under `tooling/skills/catalog/`; repo's own agents resolve every skill; quickstart D passes.

---

## Phase 6: User Story 3 - Discover and understand available skills (Priority: P3)

**Goal**: Every catalog entry surfaces a name + concise description before selection, and multiple skills are selectable in one run.

**Independent Test**: Run the install skill; confirm each listed skill shows a name and a one-line description, and multiple can be chosen in a single run (quickstart C.3, SC-006).

### Tests for User Story 3 ⚠️

- [x] T033 [P] [US3] `tooling/skills/lib/skills.describe.test.ts` — `list` output includes a non-empty `DESCRIPTION` for every catalog skill, sourced from `skill.meta`; a catalog entry missing `description` is a catalog error (exit `2`), proving the list can't drift from content (FR-015).

### Implementation for User Story 3

- [x] T034 [US3] Ensure `tooling/skills/skill/SKILL.md` renders each option as `name — description` and supports multi-select in one run (spec US3 AS-1/AS-2). Verify every migrated `catalog/<name>/skill.meta` (from US4) carries a meaningful one-line `description`.

**Checkpoint**: All user stories independently functional.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [x] T035 [P] Add atomicity + missing-tool contract tests in `tooling/skills/lib/skills.atomic.test.ts`: a write forced to fail mid-run leaves the target byte-for-byte unchanged and exits `4` (SC-005); `sha256sum`/`shasum` off PATH exits `5` with guidance (FR-013/FR-014).
- [x] T036 [P] Run `pnpm nx lint skills`, `pnpm nx typecheck skills`, `pnpm nx test skills`, and `pnpm knip` — fix findings; confirm named exports, no `.js` import extensions, colocated tests.
- [x] T037 Shell-portability pass on `bootstrap/install.sh` + `lib/skills.sh`: POSIX-only (no bashisms), `set -eu` throughout, `sha256sum`/`shasum` fallback exercised, awk semver (no `sort -V`), `git merge-file` available; run under `sh` and (if available) `dash`.
- [x] T038 Execute quickstart scenarios A (shell core, incl. conflict a–e + merge-base-unavailable), B (vitest), C (E2E with Claude), D (consolidation) from [quickstart.md](./quickstart.md) end-to-end and record results in the PR description; verify the traceability table.
- [x] T039 [P] Finalize `tooling/skills/README.md` + document the published one-liner (`curl … | sh`) and the pinned-ref publish step for maintainers.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Setup — **BLOCKS all user stories** (every subcommand builds on the shared engine in `lib/skills.sh`).
- **US1 (Phase 3, P1)**: depends on Foundational. MVP.
- **US2 (Phase 4, P2)**: depends on Foundational; reuses US1's `bootstrap`/`SKILL.md` and staged-write engine. The `resolve` path (T026) additionally reuses the R2 sparse-clone mechanism to fetch the merge base.
- **US4 (Phase 5, P2)**: depends on Foundational (catalog format + `list`); independent of US1/US2 code (tests use fixtures), but populates the **real** catalog the E2E flow needs.
- **US3 (Phase 6, P3)**: depends on Foundational; `description` content comes from US4's authored `skill.meta` files.
- **Polish (Phase 7)**: depends on all targeted stories.

### Within `lib/skills.sh`

`list`/`status`/`install`/`update` all live in the one shell file — sequential relative to each other and to the Foundational primitives they call, even though they are logically story-independent. Test files (`skills.*.test.ts`) are split per concern → parallelizable.

### Parallel Opportunities

- Setup: T003, T004, T005 in parallel after T002.
- Foundational: T013 (TS test helper) in parallel with the shell primitives.
- All per-story test files (T014, T015, T021, T022, T023, T033, T035) are separate files → `[P]`.
- US4 migrations T028 and T029 in parallel (distinct skill dirs); T030 sequential (touches in-use speckit resolution).

---

## Parallel Example: User Story 1

```bash
# Tests first (separate files, parallel):
Task: "T014 list test in tooling/skills/lib/skills.list.test.ts"
Task: "T015 install test in tooling/skills/lib/skills.install.test.ts"

# Then implementation — T016, T017 sequential (same file lib/skills.sh),
# T018 (bootstrap/install.sh) and T019 (skill/SKILL.md) parallel afterwards.
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational → 3. Phase 3 US1 → **STOP & VALIDATE** quickstart A.1–A.2 + C against a fixture catalog → demo one-command fresh install.

### Incremental Delivery

1. Setup + Foundational → engine ready.
2. US1 → fresh install works (MVP).
3. US2 → safe updates + local-mod protection.
4. US4 → real catalog populated, source repo consolidated (SC-007) — unlocks the true E2E flow.
5. US3 → discovery polish.
6. Polish → atomicity/missing-tool tests, portability, full quickstart run.

> Note: US4 is P2 but is the prerequisite for a _real_ (non-fixture) end-to-end run. If the goal is a shippable dogfooded system rather than a fixture demo, do US4 immediately after US1.
