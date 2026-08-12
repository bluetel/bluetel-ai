# Tasks: Fast Lint Feedback Without Losing Coverage

**Input**: Design documents from `/specs/005-oxlint-lint-performance/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md)

**Tests**: Included and **not optional**. The spec's first condition of satisfaction (FR-005 / SC-006)
is "no lint coverage is lost", and the only honest way to demonstrate that is an executable check that
every previously-enforced rule still fires. A green lint run proves nothing on its own — a rule that
silently stopped running looks exactly like clean code.

**Organization**: Grouped by phase, mapped to the user stories in `spec.md`. Each phase is
independently landable.

**Revision 2026-08-11 — scope expanded to include the TypeScript upgrade.** Two phases were added
(**Phase 0**, one tsconfig line, and **Phase 6**, TypeScript 7.0.2), and the migration phase now moves
the 41 type-aware rules to oxlint rather than leaving them with ESLint — see `research.md` §7 for the
measurements that forced that change. **Task IDs T001–T045 keep their original numbers** so review
comments and the `plan.md` SC map stay valid; new tasks are T046 onward regardless of where they sit in
the running order. The order to execute in is the phase order, not the ID order.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel — different files, no dependency on a sibling
- **[Story]**: the `spec.md` user story served (US1–US5)
- Exact file paths given throughout

---

## Phase 0: One tsconfig line, ahead of everything (US6)

**Goal**: Set `"types": ["node"]` so TypeScript 7 can resolve Node globals, and so the type-aware lint
layer is not blamed for 108 diagnostics that are really one missing type package.

**Independent Test**: All four typechecked projects pass `tsc --noEmit` under the currently-installed
TypeScript 5.9.2 with the option set. Nothing else changes.

**Why first**: It is one line, it is a no-op for the current compiler, and it is a prerequisite for both
Phase 4's type-aware layer and Phase 6's bump. Landing it separately means that if it _does_ break
something, the breakage is unambiguous.

- [x] **T046** Add `"types": ["node"]` to `compilerOptions` in `tsconfig.base.json`. Before committing,
      check gap **G14**: confirm no project relies on ambient types from another `@types` package (Vitest
      globals in particular — this repo imports `describe`/`it`/`expect` explicitly, so it should be
      clear, but verify rather than assume). If any project's needs differ, set `types` per project
      instead of in the base config and record why.
- [x] **T047** Verify and record: `pnpm typecheck --skip-nx-cache` passes, and per-project
      `tsc --noEmit` passes for `packages/env-validation-errors`, `tooling/commit-conventions`,
      `tooling/qlty-diff` and `tooling/skills`. Append the 5.9.2 per-project timings to
      `measurements.md` — these are the SC-010 / SC-011 baseline, and they must be taken **with** this
      option set so the Phase 6 comparison is like-for-like.

**Checkpoint**: no behaviour change today, two later phases de-risked.

---

## Phase 1: Take the free win — cspell off the per-file path (US1)

**Goal**: Remove the single most expensive rule (1555 ms, 61.7 % of rule time) from the staged-file
path without adding a single dependency.

**Independent Test**: `/usr/bin/time` the existing `lint-staged` ESLint command on one file and confirm
a ~1.5 s drop, with `@cspell/spellchecker` still reporting a planted misspelling via
`pnpm nx run <project>:lint`.

**Why first**: It is the cheapest, highest-yield change available, it is reversible in one commit, and
it validates the two-layer premise before any new tool is adopted. If everything after this phase were
abandoned, this would still be worth having.

- [x] **T001** Record the "before" numbers into `specs/005-oxlint-lint-performance/measurements.md`
      using the exact commands in `research.md` §1: single-file ESLint (`/usr/bin/time -f "%e s %M KB"`),
      `pnpm lint:check --skip-nx-cache`, `pnpm typecheck --skip-nx-cache`, and the full `.husky/pre-commit`
      run on a one-file staged diff. This file is the evidence base for every SC.
- [x] **T002** In `tooling/eslint-config-internal/index.mjs`, move the `@cspell/spellchecker` config
      block behind a named export (e.g. `workspaceChecks` — the same export that will hold
      `@nx/enforce-module-boundaries` after Phase 4) that is **not** part of `base`, so the rule is no
      longer in the config `lint-staged` resolves. Keep the rule, its severity and its options
      byte-identical — this is a relocation, not a change.
- [x] **T003** Add `@cspell/spellchecker` to the project-level lint path only: consume the new export
      from each project's `eslint.config.mjs` alongside `withTypeChecking(...)`. Verify with
      `node ./node_modules/.bin/eslint --print-config <a .ts file>` that the rule is present for the
      project run and absent for the staged-file invocation.
- [x] **T004** Plant a misspelling in a scratch file, confirm `pnpm nx run env-validation-errors:lint`
      still errors on it, then confirm the `lint-staged` command on that same file does not. Delete the
      scratch file.
- [x] **T005** Re-time the single-file `lint-staged` command and append to `measurements.md`. Expected:
      ~5.7 s → ~4.2 s. If the drop is materially smaller, the `TIMING` attribution was misleading —
      stop and re-measure before continuing to Phase 2.

**Checkpoint**: staged-file lint is ~1.5 s faster, zero dependencies added, zero rules changed.

---

## Phase 2: Build the safety net before touching anything (US2)

**Goal**: Make "no coverage lost" falsifiable _before_ the migration, so later phases are proved rather
than asserted.

**Independent Test**: The fixture suite passes against the **current, unmigrated** setup. If it does
not, the harness is wrong, not the config.

**⚠️ CRITICAL**: Phase 4 must not begin until this phase is complete and green. A harness written after
a migration tends to agree with whatever the migration did.

- [x] **T006** Add `scripts/extract-lint-rules.mjs`: runs
      `eslint --print-config <file>` for a representative `.ts`, `.tsx`, `.mjs` and `.cjs` file, unions
      the enabled rules, and emits JSON — rule name, source plugin, severity, options,
      `requiresTypeChecking` (read from the plugin's own `meta.docs`). Deterministic output so it diffs
      cleanly.
- [x] **T007** [P] Colocated `scripts/extract-lint-rules.test.mjs`: asserts the extractor finds the
      expected rule count for a fixture config and correctly classifies a known type-aware rule
      (`no-floating-promises`) and a known syntactic one (`consistent-type-imports`).
- [x] **T008** Generate `specs/005-oxlint-lint-performance/rule-inventory.md` from T006's output. One
      row per rule: name, plugin, severity, options, **Owner** (`oxlint-native` / `oxlint-js-plugin` /
      `oxlint-type-aware` / `eslint-workspace` / `other`), **Status** (`covered` / `relocated` /
      `dropped`), notes. At this
      point every Owner is `eslint` — the column gets filled in during Phase 4. Assert the row count is
      **129** for `.ts`; if it differs, reconcile against `research.md` §2 before proceeding.
- [x] **T009** Create `tooling/lint-coverage/` — a workspace member holding the parity harness, with
      `package.json`, `project.json`, `vitest.config.ts`, and an `index.ts` barrel per Constitution
      principle II.
- [x] **T010** Add `tooling/lint-coverage/fixtures/` — one minimal file per previously-enforced rule
      that violates exactly that rule. Fixtures MUST sit outside the linted source tree (add to
      `ignorePatterns` / `.prettierignore` as needed) so they do not fail the repo's own gates. Start
      with the 11 non-`recommended` rules the repo configures by hand plus the 41 type-aware rules —
      these carry the real regression risk. Cover the `recommended` presets by preset assertion rather
      than 88 hand-written fixtures.
- [x] **T011** Add `tooling/lint-coverage/src/parity.ts` + colocated `parity.test.ts`: for each fixture,
      run the owning layer and assert the expected rule ID appears in the diagnostics. Assert on **rule
      ID**, not just non-zero exit code — a different rule firing is not coverage.
- [x] **T012** Run the suite against the current setup. It MUST pass. Fix the harness until it does, and
      commit it green.

**Checkpoint**: a test that fails loudly the moment any rule stops being enforced.

---

## Phase 3: Spike — resolve research gaps G1–G5 and G10 (US2)

**Goal**: Replace every "should work" in `research.md` with a measured yes or no. Throwaway code; the
deliverable is the recorded answers.

**Independent Test**: `research.md` §5 has no unresolved rows, and `measurements.md` has JS-plugin cost
numbers and the type-aware layer's fix-parity table.

**Do not skip on the basis that the docs say it works.** The JS plugin API is alpha; G1–G5 exist
because documentation cannot answer them for this specific rule set.

- [x] **T013** [P] **G1**: `npx oxlint@1.78.0 --rules` → save to
      `specs/005-oxlint-lint-performance/oxlint-rules.txt`. **Note**: `--rules` produced no output on
      1.78.0 in this environment, so if it is still empty, cross-check against the docs' rule index and
      say in the file which source was used. Diff against T006's 129-rule extraction and
      record, per rule, whether oxlint implements it natively. Every unmatched rule is assigned
      `eslint-type-aware` or `oxlint-js-plugin` in `rule-inventory.md` — never left blank.
- [x] **T014** [P] **G2**: in a scratch `.oxlintrc.json`, load `eslint-plugin-import-x`,
      `eslint-plugin-check-file` and `eslint-plugin-prefer-arrow-functions` via `jsPlugins`. Run against
      the repo and diff diagnostics against ESLint's for the same rules. Record which load cleanly and
      which diverge.
- [x] **T015** [P] **G3**: plant an unused import, run oxlint's `no-unused-vars` with `--fix` (try
      `fixKind=dangerous-fix` if the plain fix does not remove it) and record whether the import is
      removed the way `unused-imports/no-unused-imports` removes it today. This decides whether US1
      acceptance scenario 2 holds.
- [x] **T016** [P] **G4**: compare oxlint's React Compiler rule against
      `eslint-plugin-react-compiler@19.1.0-rc.2` on a file with a known violation. Record parity, and
      note that oxlint's is experimental and opt-in.
- [x] **T017** **G5**: time the staged-file oxlint pass with (a) no JS plugins and (b) every JS plugin
      G2 validated. Append both to `measurements.md`. **This is the go/no-go for SC-001** — if (b)
      exceeds 1 s, record which plugin dominates and plan to leave its rules with ESLint.
- [x] **T048** **The type-aware layer, validated before it is relied on.** Install `oxlint-tsgolint`
      into a scratch project and, for each of the 41 `requiresTypeChecking` rules: (a) confirm the rule
      name is accepted — oxlint fails config parsing on an unknown rule, so a parsing config already
      proves all 41 exist; (b) plant a violation and confirm the rule fires; (c) record whether the rule
      **auto-fixes**, and compare against typescript-eslint's `meta.fixable` for the same rule. Any rule
      that reports but no longer fixes is a change to US1 acceptance scenario 2 and must be listed in the
      inventory notes, not discovered later. Also settle **G10**: read the 5
      `no-unnecessary-type-assertion` sites in `packages/env-validation-errors/src/index.test.ts`
      (lines 53, 85, 89, 129, 133) and decide whether oxlint is right and the assertions go, or oxlint is
      wrong and that one rule stays with ESLint pending an upstream fix. And settle the `.mjs` scoping:
      reproduce ESLint's file scoping in the oxlint config so the 34 `.mjs` diagnostics in
      `research.md` §7.5 do not land as surprise debt.
- [x] **T018** Write the answers back into `research.md` §5, replacing each "how to resolve" row with
      the result. Where an answer is bad, apply the stated fallback and say so — a rule moving back to
      the ESLint layer is a success of the process, not a failure.

**Checkpoint**: the exact rule-to-owner assignment is known and measured. **Decision gate**: if T017
shows SC-001 is unreachable even with plugins trimmed, stop here. Phase 1 stands alone; record the
outcome in the PR and close the feature honestly rather than shipping a slower, more complex setup.

---

## Phase 4: The migration (US1, US2, US3, US5)

**Goal**: Split the layers for real. The Phase 2 harness must stay green throughout.

**Independent Test**: `pnpm nx run-many -t lint lint-workspace` exits zero across the workspace, the
parity suite passes, and the staged-file pass is under 1 s.

### Dependencies

- [x] **T019** Add `oxlint` as a root devDependency, **pinned exactly** (no `^`). Honour
      `pnpm-workspace.yaml` `minimumReleaseAge: 1 week` — pick a version at least a week old. Commit the
      updated `pnpm-lock.yaml`.
- [x] **T020** Add `eslint-plugin-oxlint` as a devDependency of `tooling/eslint-config-internal` (the
      package that consumes it), per the Constitution's dependency standard.
- [x] **T049** Add `oxlint-tsgolint` as a root devDependency, **pinned exactly**, at the version whose
      major.minor matches the `oxlint` pin from T019 (`7.0.2001` alongside `oxlint` 1.78.0 — the tsgolint
      version tracks the TypeScript semantics it implements, not oxlint's version). Enable type-aware
      linting in `tooling/oxlint-config/oxlintrc.base.json` via `"options": { "typeAware": true }` rather
      than relying on a CLI flag, so every invocation path gets it and none can silently omit it. Confirm
      a missing binary is a hard failure (`Failed to find tsgolint executable`) and not a skip.

### Shared oxlint config package

- [x] **T021** Create `tooling/oxlint-config/` — `package.json` (`@bluetel-ai/oxlint-config`, private,
      `type: module`), `project.json`, `vitest.config.ts`, and an `index.mjs` barrel.
- [x] **T022** Seed `tooling/oxlint-config/oxlintrc.base.json` with
      `npx @oxlint/migrate eslint.config.mjs`, then hand-reconcile against `rule-inventory.md`. Every
      rule the inventory assigns to oxlint must be present at the **same severity with equivalent
      options**; every rule assigned to ESLint must be absent. Do not accept the generated file
      unreviewed — the docs warn that local custom plugins need manual configuration.
- [x] **T023** **Do not enable oxlint rule categories wholesale.** Enable only the rules in the
      inventory. If a category is enabled for convenience it will light up existing code and breach
      FR-013 / US4. Any newly-available rule that looks worth having goes in a follow-up issue, not
      this change.
- [x] **T024** Port `tooling/eslint-config-base/rules/enforce-safe-env.mjs` to
      `tooling/oxlint-config/plugins/enforce-safe-env.mjs` as an oxlint JS plugin. Move
      `enforce-safe-env.test.mjs` with it (principle III) and adapt the harness to oxlint's rule-tester
      equivalent. Remove the rule and its ESLint wiring from `tooling/eslint-config-base/index.mjs`.
      Add `plugins/index.mjs` as the barrel.
- [x] **T025** Add root `.oxlintrc.json` extending `tooling/oxlint-config/oxlintrc.base.json`, and
      declare the JS plugins via `jsPlugins` for every rule G2 validated. Port the `ignores` entries
      currently in `eslint-config-internal` (`**/image-sources.ts`, `**/importMap.js`) to
      `ignorePatterns`.

### Reduce the ESLint layer

- [x] **T026** Reduce `tooling/eslint-config-internal/index.mjs` to **two rules**:
      `@nx/enforce-module-boundaries` and `@cspell/spellchecker` (from Phase 1), plus
      `eslint-config-prettier`. Remove `withTypeChecking` and the whole `strictTypeChecked` block — those
      41 rules now belong to oxlint (T049), and leaving them here would keep the lint gate bound to the
      TypeScript compiler API, breaching **FR-021** and re-blocking Phase 6. Drop the now-unused plugin
      dependencies from its `package.json` (`typescript-eslint` and the `@typescript-eslint/*` packages,
      `eslint-plugin-check-file`, `eslint-plugin-import-x`, `eslint-plugin-prefer-arrow-functions`,
      `eslint-plugin-unused-imports`, and `eslint-plugin-react-compiler` if T016 confirmed native
      parity). Run `pnpm knip` to confirm nothing is left orphaned. **Do not** expect `typescript` itself
      to leave the tree: `@nx/eslint` hard-depends on `~5.9.2` (plan **C4**).
- [x] **T027** Apply `eslint-plugin-oxlint` **last** in the flat config, after `prettierConfig`, to
      disable every ESLint rule oxlint now owns. Then verify SC-008: run both layers over the workspace
      and assert no diagnostic appears twice.

### Wire up Nx and the hook

- [x] **T028** In `nx.json`: change the `@nx/eslint/plugin` `targetName` from `lint` to `lint-workspace`;
      add a `lint` entry to `targetDefaults` running oxlint (type-aware enabled via config, per T049)
      with `cache: true` and a `fix` configuration mirroring the existing ESLint one; add the oxlint config paths
      (`{workspaceRoot}/.oxlintrc.json`, `{workspaceRoot}/tooling/oxlint-config/**/*`) to
      `namedInputs.sharedGlobals` so a rule change invalidates the cache (**gap G9**). Because the
      type-aware layer reads `tsconfig`s, confirm `tsconfig.base.json` is already in `sharedGlobals` — it
      is — so a `types` change also invalidates `lint`, not just `typecheck`.
- [x] **T029** Add an explicit `lint` target to all 7 `project.json` files, following the existing
      `typecheck`/`test` shape (`nx:run-commands` + `cwd`). Verify `pnpm nx show project <name>` lists
      both `lint` and `lint-workspace`.
- [x] **T030** Verify **gap G9** empirically: change one rule's severity in the oxlint config, re-run
      `pnpm lint:check`, and confirm a cache **miss**. A cache hit here means a rule change silently
      does nothing — fix the inputs before continuing.
- [x] **T031** Verify **gap G7**: plant a module-boundary violation and confirm
      `pnpm nx run <project>:lint-workspace` reports `@nx/enforce-module-boundaries`. This closes the
      pre-existing silent-skip gap found in `research.md` §1.
- [x] **T032** Update `package.json`: replace the `lint-staged` ESLint entry with
      `oxlint --fix` (type-aware comes from the config, not a flag — T049; `prettier --write` stays last
      so Prettier owns formatting, FR-017), and **drop `node --max-old-space-size=8192`** — it exists only to survive ESLint's memory profile (SC-004).
      Point `lint` / `lint:check` at both targets.
- [x] **T033** Update `.husky/pre-commit`: keep `npx lint-staged` first, and insert
      `pnpm nx affected -t lint-workspace` after `pnpm typecheck` and before `pnpm qlty:diff`. Make the
      oxlint step **fail closed** if either `oxlint` or `oxlint-tsgolint` is missing, matching the
      existing `qlty` treatment (FR-018). Confirm a staged-deletion-only commit still succeeds (FR-019).
- [x] **T034** Update `.github/workflows/ci.yml` to run `lint-workspace` alongside the existing targets:
      `pnpm exec nx affected -t lint lint-workspace test typecheck design-lint --parallel=$(nproc)`.
      Without this, CI stops enforcing the 4 workspace-scoped rules — `@nx/enforce-module-boundaries`,
      `@cspell/spellchecker`, `no-octal`, `no-dupe-args` — an FR-011 violation and the worst possible
      outcome of this feature. **Note**: the GitHub App cannot modify `.github/workflows/`, so this task
      must be applied by a human or in a separate human-authored commit. Until it is, the only place those
      4 rules run is the pre-commit hook, which `--no-verify` skips — so this is the one open task that
      decides whether the migration's coverage claim holds in CI.
- [x] **T035** Convert the two existing inline suppressions (**gap G8**):
      `packages/env-validation-errors/src/index.ts:3` disables `@bluetel-ai/enforce-safe-env`, which now
      lives in oxlint, so it needs the `oxlint-disable-next-line` form;
      `packages/env-validation-errors/src/index.test.ts:253` disables
      `@typescript-eslint/no-unnecessary-type-assertion`, which **also moves to oxlint** under the revised
      design, so it needs converting too — the original plan wrongly assumed it stayed with ESLint.
      Confirm both still suppress, and that neither file reports an error.

**Checkpoint**: oxlint enforces 142 of the 146 rules including all 41 type-aware ones, ESLint enforces
the remaining 4, the parity suite is green, no duplicate diagnostics, and **nothing on the lint path loads
the TypeScript compiler API any more** — which is the precondition Phase 6 needs.

---

## Phase 5: Prove it and document it (US1, US3, US4)

**Goal**: Turn each success criterion into a recorded measurement, and make the new commands
discoverable.

**Independent Test**: `measurements.md` has a before/after row for SC-001 to SC-004, and
`rule-inventory.md` accounts for all 129 rules.

- [x] **T036** **SC-001 / SC-004**: re-run the single-file timing with
      `/usr/bin/time -f "%e s %M KB"`. Record wall time (target < 1 s, from 5.68 s) and peak RSS (target
      far below 798 648 KB). If SC-001 is missed, apply the T017 fallback and re-measure before
      declaring done.
- [x] **T037** **SC-002**: time the full `.husky/pre-commit` run on the same one-file staged diff used
      in T001. Target ≥ 40 % reduction. Note that step 4 is Nx-cached, so record both a warm and a cold
      figure — quoting only the warm one would overstate the result.
- [x] **T038** **SC-003**: `time pnpm lint:check --skip-nx-cache` and the `lint-workspace` equivalent.
      Target ≤ 15 s combined, from 30.7 s.
- [x] **T039** **SC-005**: complete `rule-inventory.md` — every one of the 129 rows has an Owner and a
      Status. Any `dropped` row needs a reason, a compensating check, and explicit sign-off in the PR
      body. Ideally there are none.
- [x] **T040** **SC-006**: full parity suite run. Every previously-enforced rule fires on its planted
      violation.
- [x] **T041** **SC-007**: `pnpm nx run-many -t lint lint-workspace` exits zero across the workspace, and
      `git diff origin/main` contains no `eslint-disable`/`oxlint-disable` added to a pre-existing file
      (the two conversions in T035 are edits to existing comments, not new suppressions).
- [x] **T042** [P] Update `AGENTS.md` and `.claude/rules/typescript-conventions.md` (FR-020): the two
      lint layers, when each runs, the fast standalone command agents should use mid-edit (US3), and how
      to add a rule to the right layer (US5). Must not contradict the Constitution.
- [x] **T043** [P] Amend `.specify/memory/constitution.md` — principle IV names "ESLint (with `--fix`)
      … via lint-staged" and the Development Workflow section lists the pre-commit step order. Both are
      now inaccurate. Per the Governance section, a tool/document disagreement is a defect that must be
      fixed in the same change that discovers it. PATCH or MINOR bump with a Sync Impact Report.
- [x] **T044** Run `/speckit-analyze` across `spec.md`, `plan.md` and `tasks.md` to catch drift, then
      run the full gate set: `pnpm nx affected -t lint lint-workspace test typecheck`, `pnpm knip`,
      `pnpm qlty:diff`.
- [ ] **T045** Open follow-up issues for the deliberately-deferred items, so they are not lost:
      (a) ~~TypeScript 7 upgrade~~ — **now in scope as Phase 6**, no follow-up needed;
      (b) `cspell` CLI as its own Nx target (`research.md` §3.5 option B), if SC-003 came in tight;
      (c) collapsing `eslint-config-base` into `eslint-config-internal` now that `enforce-safe-env` has
      moved; (d) widening `BRANCH_PATTERN` in `tooling/commit-conventions/src/validate.ts` to admit
      `claude/*`, or having the workflow create `feature/*` branches (plan.md **C2**); (e) revisiting
      plan.md **C4** once `@nx/eslint` stops hard-depending on `typescript ~5.9.2`, so the workspace can
      hold exactly one TypeScript copy.

---

## Phase 6: TypeScript 7.0.2 (US6)

**Goal**: Take `tsc` from 5.09 s to ~0.87 s across the four typechecked projects, and put the compiler on
the same TypeScript semantics the type-aware linter already applies.

**Independent Test**: `pnpm nx run-many -t typecheck test build lint lint-workspace` exits zero,
`pnpm knip` and `pnpm qlty:diff` pass, and `measurements.md` records the before/after `tsc` numbers plus
the resolved `typescript` version.

**⚠️ Blocked on Phase 4.** `typescript@7` ships no JavaScript compiler API, and typescript-eslint's TS 7
support issue is closed as _not planned_ (`research.md` §7.2). Landing this before oxlint owns the 41
type-aware rules would take those rules out of enforcement — an FR-005 and FR-022 violation. **Do not
start this phase until T041 is green.**

**This phase is revertible on its own.** If any step below fails, the correct outcome is TypeScript
**6.0.3** — still inside typescript-eslint's peer range, so it is safe even if Phase 4 were also reverted
— with the blocker written down (FR-026). It is not a partial upgrade, and it is never a dropped rule.

- [x] **T050** **Compatibility matrix first (FR-025, gap G13).** On a scratch branch with
      `typescript@7.0.2` installed, exercise every tool that consumes TypeScript and record the result in
      `specs/005-oxlint-lint-performance/typescript-upgrade.md`: `tsc --noEmit` per project;
      `pnpm nx show projects` and `pnpm nx show project <name>` (does `@nx/js/typescript` still infer
      `typecheck` and `build` targets?); `pnpm nx run-many -t build test`; `pnpm knip`; `pnpm qlty:diff`;
      and the editor story (TypeScript 7 ships `tsc` only — 6.0.3 also shipped a `tsserver` bin — so note
      what contributors' editors will need). **A tool that skips work rather than failing is a blocker,
      not a pass**; check output, not just exit codes.
- [x] **T051** Bump the pins: `typescript` to `7.0.2` in `packages/env-validation-errors/package.json` and
      anywhere else it is declared, and add an explicit root `typescript` devDependency so resolution is
      deliberate rather than hoisting-dependent (**FR-024**, plan **C4**). Then assert both of these agree
      and record them: `node ./node_modules/.bin/tsc --version` and
      `node -e "console.log(require('typescript/package.json').version)"`. Note `@nx/eslint` still
      hard-depends on `~5.9.2`, so a second copy will remain in the tree — record it and its consumer
      rather than trying to remove it.
- [x] **T052** **SC-010 / SC-011**: re-run the T047 measurements with
      `/usr/bin/time -f "%e s %M KB"` — per-project `tsc --noEmit` and
      `pnpm typecheck --skip-nx-cache`. Targets: ≥ 50 % wall-clock reduction (baseline 5.09 s summed) and
      ≥ 50 % peak-RSS reduction (baseline 286 872 KB on the largest project). Append to
      `measurements.md`. No `tsconfig` option may be relaxed to get there (**FR-023**) — no widened
      `skipLibCheck`, no reduced `strict`, no new `@ts-expect-error`.
- [x] **T053** **SC-012 / SC-013**: re-run the Phase 2 parity suite and re-check `rule-inventory.md` — all
      129 rules still accounted for, still zero dropped. Then re-run the type-aware layer and diff its
      diagnostics against the pre-bump run: any change is a **semantics** change from moving the compiler
      onto TypeScript 7, and each difference must be explained in `typescript-upgrade.md`, not merely
      accepted because the run is green. Update `AGENTS.md` and the Constitution's tooling references if
      they name a TypeScript version.

**Checkpoint**: `tsc` is ~6× faster, all 129 rules still enforced, and the linter and the compiler are on
the same TypeScript.

---

## Phase 7: Review remediation

**Goal**: Close the gaps the PR #27 review found in the landed work. Not new scope — each item is a place
the implementation and its own stated contract had come apart.

**Independent Test**: the parity suite fails if any rule on the ESLint layer loses both its fixture and
its excuse, and every rule count in the repo agrees with generated `rule-inventory.md`.

- [x] **T054** **Close the fixture hole (FR-005 / SC-006).** `no-octal` and `no-dupe-args` were in
      `ESLINT_WORKSPACE_RULES` with neither a fixture nor an `EXCUSED_RULES` entry, so two of the four
      rules ESLint still owns had no silent-failure detection at all — in the layer where a silent rule is
      hardest to spot, since it cannot be caught by diffing the oxlint config either. Both now plant as
      `.cjs`: a legacy octal literal and a duplicate parameter are strict-mode **syntax errors**, so a
      `.ts` or `.mjs` fixture reports `Parsing error` with a null rule ID and the rule never runs.
- [x] **T055** **Make the contract self-enforcing.** New case in `parity.test.ts`: every key of
      `ESLINT_WORKSPACE_RULES` must be fixture-covered or excused. Two separate mutations, because an
      assertion nobody has seen fail is the same shape of problem as the rule it was written to catch —
      and because the first one does **not** exercise the new case: switching `no-octal` off in the ESLint
      config reddens `no-octal still fires` (proving the new fixture has teeth), while it takes _deleting_
      the fixture to redden the accounting case, since `ESLINT_WORKSPACE_RULES` is a literal that no
      config change touches. Both were run. `fixtures.ts`'s docstring, which claimed the suite asserted
      this for _every_ enabled rule, now states what is actually covered.
- [x] **T056** **Reconcile the rule counts.** `tooling/eslint-config-internal/index.mjs` said "three
      rules" over a block enforcing four; `.husky/pre-commit` said "143 of the 147"; T034 and the Phase 4
      checkpoint said 2 and 127. All now read 142 of 146 with 4 on ESLint, and name generated
      `rule-inventory.md` as the source of truth rather than restating it. Also `.prettierignore`:
      Prettier aligns markdown tables and the inventory generator does not, so formatting the generated
      file made every regeneration look like drift and every format look like an edit.

- [x] **T057** **A disabled rule must not render as `error` (FR-006).** `cli.ts` coerced
      `severityOf(entry) === 'off' ? 'error'` and counted every key in `.oxlintrc.json` regardless of
      severity, so the inventory was structurally incapable of showing a switched-off rule — in the file
      that is the _only_ accounting for the 89 enforced rules with no fixture. Setting `no-debugger` to
      `off` used to leave the inventory byte-identical with all tests green. Disabled entries are now
      dropped and the severity is reported as written: the same mutation gives
      `Wrote 145 rules … Total is 145, not the 146 expected` with exit 1, drift in the committed file, and
      a red `lists no rule that either layer has since switched off`.
- [x] **T058** **Tie the fixture corpus to the config (SC-006).** Every parity case was generated from
      `ALL_FIXTURES`, so deleting a fixture deleted its own test: removing the
      `@typescript-eslint/no-floating-promises` fixture left the suite green at 111 passed with zero
      inventory drift. Now the 41 type-aware rules are read from `.oxlintrc.json`'s type-aware override and
      each must have a fixture, and the corpus sizes (57 / 16 / 41) are pinned. The same deletion now
      reddens two cases. Also added: the committed inventory must list exactly the rules the configs enable,
      in both directions, so the byte-for-byte check can no longer pass over a rule that has gone quiet.
- [x] **T059** **Stop excusing rules to a test that does not exist.** Two `EXCUSED_RULES` entries claimed
      coverage by a "preset assertion in `parity.test.ts`"; there was none, and the only check on the field
      was `coveredBy.length > 0`, so any string passed. The assertion now exists — both rules must be
      enabled in `.oxlintrc.json` with their exact options — and the entries say plainly that it is weaker
      than a planted violation. `react-compiler` additionally records that T016's comparison result appears
      nowhere in `measurements.md`, so it is enabled-but-unproven rather than quietly assumed good.
- [x] **T060** **Fix the coverage overclaim and a flaky gate.** `AGENTS.md` and
      `.claude/rules/typescript-conventions.md` told agents that _every_ enforced rule has a fixture — 57 of
      146 do, and the disclaimer T054 added to `fixtures.ts` contradicted them. Both now state the corpus
      and what covers the rest. Separately, `enforce-safe-env.test.mjs`'s `identifierArb` generated JS
      reserved words, so fast-check eventually built `import { createEnv as in } from …` — a syntax error
      the rule never sees, failing the property ~1 run in 7. Reserved words are now filtered; 10 consecutive
      runs green. Two stale docstrings (`parity.ts`'s "outside the repository", `fixtures.ts`'s
      "gitignored") described the opposite of what the code does and are corrected, and `plan.md:11`'s
      "127 of the 129" — a fifth stale count T056 had missed — now reads 142 of 146.

**Checkpoint**: `pnpm lint:check`, `pnpm typecheck` and `pnpm test` green from a clean install;
`pnpm lint-inventory` reproduces the committed inventory byte-for-byte; every gate added here has been
shown to fail when the thing it guards is broken. **T034 has since landed** (Phase 8) — CI now
enforces all 146 rules unconditionally.

---

## Phase 8: Amendment — take `lint-workspace` out of the pre-commit hot path

**Goal**: PR #27 feedback: `nx affected -t lint-workspace` in `.husky/pre-commit` (Phase 4, T033) was
the realized version of the Risks table's "slower than the ESLint call it replaced, on a cold cache" —
a 4-rule ESLint layer costing a full `nx affected` graph resolution on every local commit, next to an
oxlint pass that runs in under a second. T034 had already made CI enforce those 4 rules
unconditionally, so the pre-commit step was re-doing work CI was about to do anyway. This phase removes
it and reconciles every document that described it as running there.

- [x] **T061** Remove `pnpm nx --no-tui affected -t lint-workspace` from `.husky/pre-commit` (was step
      4 of 5, inserted by T033). The four rules it ran — `@nx/enforce-module-boundaries`,
      `@cspell/spellchecker`, `no-octal`, `no-dupe-args` — are now enforced only by CI's
      `nx affected -t lint lint-workspace test typecheck design-lint` (T034), not by the hook.
- [x] **T062** Amend Constitution Principle IV (v1.1.0 → v2.0.0, MAJOR — the previous "MUST NOT be
      weakened" pre-commit guarantee for `lint-workspace` is redefined to a CI-only guarantee) and the
      Development Workflow & Quality Gates "Local loop" paragraph, which had named `lint-workspace` as
      a pre-commit step.
- [x] **T063** Amend `spec.md` FR-011 to exempt the `lint-workspace` layer from the "pre-commit MUST
      match CI" requirement, and `plan.md`'s Nx targets table, pre-commit hook order table, and the one
      Risks table row this decision realizes.
- [x] **T064** Fix `AGENTS.md`'s lint table, which still said `lint-workspace` ran "pre-commit via
      `nx affected` (not CI — see T034)" — stale on both counts: T034 had landed, and pre-commit no
      longer runs it at all.

**Checkpoint**: `pnpm lint:check`, `pnpm typecheck` and `pnpm test` still green; `.husky/pre-commit` has
4 steps, not 5; `.github/workflows/ci.yml` is untouched and still runs `lint-workspace` unconditionally.

---

## Dependencies

```text
Phase 0 (tsconfig)    ── independent, ship first; prerequisite for Phase 4 and Phase 6
Phase 1 (cspell)      ── independent, ship second
Phase 2 (harness)     ── independent of Phases 0-1; MUST precede Phase 4
Phase 3 (spike)       ── needs Phase 2's rule extraction (T006); T048 needs Phase 0
Phase 4 (migration)   ── needs Phase 2 green + Phase 3 answers
Phase 5 (verify)      ── needs Phase 4
Phase 6 (TypeScript)  ── HARD-BLOCKED on Phase 4 (FR-022); revertible on its own
```

Within Phase 3, T013–T016 are `[P]` — separate scratch configs, no shared state. T017 needs T014. T048
needs Phase 0 landed, or it will re-report the 108 `@types/node` diagnostics as if they were oxlint's.
Within Phase 4: T019–T020, T049 → T021–T025 → T026–T027 → T028–T035, in order.
Within Phase 6: T050 → T051 → T052 → T053, strictly sequential — T050 is the go/no-go.

## Parallel execution notes

- **T013, T014, T015, T016** — four independent spikes, different scratch configs. **T048** can run
  alongside them; it needs only a scratch `oxlint-tsgolint` install.
- **T007** runs alongside T006's implementation.
- **T042, T043** — different files, no overlap.
- Everything in Phase 4 touches shared config files and must be **sequential**. Parallelising it is how
  a rule goes missing between two half-applied edits.

## Implementation strategy

**Land Phases 0 and 1 on their own.** One tsconfig line and ~1.5 s of the win, for none of the risk, and
they make the rest optional rather than all-or-nothing.

**Do not start Phase 4 until Phase 2 is green.** The whole feature turns on a claim — no coverage lost
— that only the harness can substantiate. Written afterwards, it would be shaped by the migration it is
supposed to be auditing.

**Treat Phase 3's decision gate as real.** If oxlint plus the needed JS plugins cannot beat 1 s, the
correct outcome is Phase 1 plus a written record of why, not a migration that adds a Rust binary, three
dependencies and a second config language for a 20 % gain.

**Every fallback moves rules toward ESLint, never out of enforcement.** Coverage is the invariant;
speed is the goal. When they conflict, coverage wins and the phase gets re-scoped. The one exception the
revised design introduces: a rule may not fall back to ESLint **and** need type information, because that
re-binds the lint gate to the TypeScript compiler API and re-blocks Phase 6 (FR-021). If that case
arises, the rule stays with ESLint and Phase 6 is deferred — deliberately, in writing — rather than the
rule being dropped.

**Phase 6 is last for a reason, and the reason is not caution.** TypeScript 7 and an ESLint-owned
type-aware layer cannot coexist: the compiler API those rules need no longer ships. So the lint migration
is not merely a nice prerequisite for the upgrade, it is the only path to it (`research.md` §7.6). Doing
them in the other order, or doing only the upgrade, means 41 rules stop being enforced on the day it
lands.
