# Tasks: Fast Lint Feedback Without Losing Coverage

**Input**: Design documents from `/specs/005-oxlint-lint-performance/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md)

**Tests**: Included and **not optional**. The spec's first condition of satisfaction (FR-005 / SC-006)
is "no lint coverage is lost", and the only honest way to demonstrate that is an executable check that
every previously-enforced rule still fires. A green lint run proves nothing on its own — a rule that
silently stopped running looks exactly like clean code.

**Organization**: Grouped by phase, mapped to the user stories in `spec.md`. Each phase is
independently landable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel — different files, no dependency on a sibling
- **[Story]**: the `spec.md` user story served (US1–US5)
- Exact file paths given throughout

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

- [ ] **T001** Record the "before" numbers into `specs/005-oxlint-lint-performance/measurements.md`
      using the exact commands in `research.md` §1: single-file ESLint (`/usr/bin/time -f "%e s %M KB"`),
      `pnpm lint:check --skip-nx-cache`, `pnpm typecheck --skip-nx-cache`, and the full `.husky/pre-commit`
      run on a one-file staged diff. This file is the evidence base for every SC.
- [ ] **T002** In `tooling/eslint-config-internal/index.mjs`, move the `@cspell/spellchecker` config
      block behind a named export (e.g. `nxAndSlowChecks`) that is **not** part of `base`, so the rule
      is no longer in the config `lint-staged` resolves. Keep the rule, its severity and its options
      byte-identical — this is a relocation, not a change.
- [ ] **T003** Add `@cspell/spellchecker` to the project-level lint path only: consume the new export
      from each project's `eslint.config.mjs` alongside `withTypeChecking(...)`. Verify with
      `node ./node_modules/.bin/eslint --print-config <a .ts file>` that the rule is present for the
      project run and absent for the staged-file invocation.
- [ ] **T004** Plant a misspelling in a scratch file, confirm `pnpm nx run env-validation-errors:lint`
      still errors on it, then confirm the `lint-staged` command on that same file does not. Delete the
      scratch file.
- [ ] **T005** Re-time the single-file `lint-staged` command and append to `measurements.md`. Expected:
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

- [ ] **T006** Add `scripts/extract-lint-rules.mjs`: runs
      `eslint --print-config <file>` for a representative `.ts`, `.tsx`, `.mjs` and `.cjs` file, unions
      the enabled rules, and emits JSON — rule name, source plugin, severity, options,
      `requiresTypeChecking` (read from the plugin's own `meta.docs`). Deterministic output so it diffs
      cleanly.
- [ ] **T007** [P] Colocated `scripts/extract-lint-rules.test.mjs`: asserts the extractor finds the
      expected rule count for a fixture config and correctly classifies a known type-aware rule
      (`no-floating-promises`) and a known syntactic one (`consistent-type-imports`).
- [ ] **T008** Generate `specs/005-oxlint-lint-performance/rule-inventory.md` from T006's output. One
      row per rule: name, plugin, severity, options, **Owner** (`oxlint-native` / `oxlint-js-plugin` /
      `eslint-type-aware` / `other`), **Status** (`covered` / `relocated` / `dropped`), notes. At this
      point every Owner is `eslint` — the column gets filled in during Phase 4. Assert the row count is
      **129** for `.ts`; if it differs, reconcile against `research.md` §2 before proceeding.
- [ ] **T009** Create `tooling/lint-coverage/` — a workspace member holding the parity harness, with
      `package.json`, `project.json`, `vitest.config.ts`, and an `index.ts` barrel per Constitution
      principle II.
- [ ] **T010** Add `tooling/lint-coverage/fixtures/` — one minimal file per previously-enforced rule
      that violates exactly that rule. Fixtures MUST sit outside the linted source tree (add to
      `ignorePatterns` / `.prettierignore` as needed) so they do not fail the repo's own gates. Start
      with the 11 non-`recommended` rules the repo configures by hand plus the 41 type-aware rules —
      these carry the real regression risk. Cover the `recommended` presets by preset assertion rather
      than 88 hand-written fixtures.
- [ ] **T011** Add `tooling/lint-coverage/src/parity.ts` + colocated `parity.test.ts`: for each fixture,
      run the owning layer and assert the expected rule ID appears in the diagnostics. Assert on **rule
      ID**, not just non-zero exit code — a different rule firing is not coverage.
- [ ] **T012** Run the suite against the current setup. It MUST pass. Fix the harness until it does, and
      commit it green.

**Checkpoint**: a test that fails loudly the moment any rule stops being enforced.

---

## Phase 3: Spike — resolve research gaps G1–G5 (US2)

**Goal**: Replace every "should work" in `research.md` with a measured yes or no. Throwaway code; the
deliverable is the recorded answers.

**Independent Test**: `research.md` §5 has no unresolved rows, and `measurements.md` has JS-plugin cost
numbers.

**Do not skip on the basis that the docs say it works.** The JS plugin API is alpha; G1–G5 exist
because documentation cannot answer them for this specific rule set.

- [ ] **T013** [P] **G1**: `npx oxlint@latest --rules` → save to
      `specs/005-oxlint-lint-performance/oxlint-rules.txt`. Diff against T006's 129-rule extraction and
      record, per rule, whether oxlint implements it natively. Every unmatched rule is assigned
      `eslint-type-aware` or `oxlint-js-plugin` in `rule-inventory.md` — never left blank.
- [ ] **T014** [P] **G2**: in a scratch `.oxlintrc.json`, load `eslint-plugin-import-x`,
      `eslint-plugin-check-file` and `eslint-plugin-prefer-arrow-functions` via `jsPlugins`. Run against
      the repo and diff diagnostics against ESLint's for the same rules. Record which load cleanly and
      which diverge.
- [ ] **T015** [P] **G3**: plant an unused import, run oxlint's `no-unused-vars` with `--fix` (try
      `fixKind=dangerous-fix` if the plain fix does not remove it) and record whether the import is
      removed the way `unused-imports/no-unused-imports` removes it today. This decides whether US1
      acceptance scenario 2 holds.
- [ ] **T016** [P] **G4**: compare oxlint's React Compiler rule against
      `eslint-plugin-react-compiler@19.1.0-rc.2` on a file with a known violation. Record parity, and
      note that oxlint's is experimental and opt-in.
- [ ] **T017** **G5**: time the staged-file oxlint pass with (a) no JS plugins and (b) every JS plugin
      G2 validated. Append both to `measurements.md`. **This is the go/no-go for SC-001** — if (b)
      exceeds 1 s, record which plugin dominates and plan to leave its rules with ESLint.
- [ ] **T018** Write the answers back into `research.md` §5, replacing each "how to resolve" row with
      the result. Where an answer is bad, apply the stated fallback and say so — a rule moving back to
      the ESLint layer is a success of the process, not a failure.

**Checkpoint**: the exact rule-to-owner assignment is known and measured. **Decision gate**: if T017
shows SC-001 is unreachable even with plugins trimmed, stop here. Phase 1 stands alone; record the
outcome in the PR and close the feature honestly rather than shipping a slower, more complex setup.

---

## Phase 4: The migration (US1, US2, US3, US5)

**Goal**: Split the layers for real. The Phase 2 harness must stay green throughout.

**Independent Test**: `pnpm nx run-many -t lint lint-types` exits zero across the workspace, the parity
suite passes, and the staged-file pass is under 1 s.

### Dependencies

- [ ] **T019** Add `oxlint` as a root devDependency, **pinned exactly** (no `^`). Honour
      `pnpm-workspace.yaml` `minimumReleaseAge: 1 week` — pick a version at least a week old. Commit the
      updated `pnpm-lock.yaml`.
- [ ] **T020** Add `eslint-plugin-oxlint` as a devDependency of `tooling/eslint-config-internal` (the
      package that consumes it), per the Constitution's dependency standard.

### Shared oxlint config package

- [ ] **T021** Create `tooling/oxlint-config/` — `package.json` (`@bluetel-ai/oxlint-config`, private,
      `type: module`), `project.json`, `vitest.config.ts`, and an `index.mjs` barrel.
- [ ] **T022** Seed `tooling/oxlint-config/oxlintrc.base.json` with
      `npx @oxlint/migrate eslint.config.mjs`, then hand-reconcile against `rule-inventory.md`. Every
      rule the inventory assigns to oxlint must be present at the **same severity with equivalent
      options**; every rule assigned to ESLint must be absent. Do not accept the generated file
      unreviewed — the docs warn that local custom plugins need manual configuration.
- [ ] **T023** **Do not enable oxlint rule categories wholesale.** Enable only the rules in the
      inventory. If a category is enabled for convenience it will light up existing code and breach
      FR-013 / US4. Any newly-available rule that looks worth having goes in a follow-up issue, not
      this change.
- [ ] **T024** Port `tooling/eslint-config-base/rules/enforce-safe-env.mjs` to
      `tooling/oxlint-config/plugins/enforce-safe-env.mjs` as an oxlint JS plugin. Move
      `enforce-safe-env.test.mjs` with it (principle III) and adapt the harness to oxlint's rule-tester
      equivalent. Remove the rule and its ESLint wiring from `tooling/eslint-config-base/index.mjs`.
      Add `plugins/index.mjs` as the barrel.
- [ ] **T025** Add root `.oxlintrc.json` extending `tooling/oxlint-config/oxlintrc.base.json`, and
      declare the JS plugins via `jsPlugins` for every rule G2 validated. Port the `ignores` entries
      currently in `eslint-config-internal` (`**/image-sources.ts`, `**/importMap.js`) to
      `ignorePatterns`.

### Reduce the ESLint layer

- [ ] **T026** Reduce `tooling/eslint-config-internal/index.mjs` to the type-aware layer: keep
      `withTypeChecking` (`strictTypeChecked` + the 12 explicit rule overrides), `@nx/enforce-module-boundaries`,
      `@cspell/spellchecker` (from Phase 1), and `eslint-config-prettier`. Remove the rule blocks that
      moved to oxlint. Drop the now-unused plugin dependencies from its `package.json`
      (`eslint-plugin-check-file`, `eslint-plugin-import-x`, `eslint-plugin-prefer-arrow-functions`,
      `eslint-plugin-unused-imports`, and `eslint-plugin-react-compiler` if T016 confirmed native
      parity). Run `pnpm knip` to confirm nothing is left orphaned.
- [ ] **T027** Apply `eslint-plugin-oxlint` **last** in the flat config, after `prettierConfig`, to
      disable every ESLint rule oxlint now owns. Then verify SC-008: run both layers over the workspace
      and assert no diagnostic appears twice.

### Wire up Nx and the hook

- [ ] **T028** In `nx.json`: change the `@nx/eslint/plugin` `targetName` from `lint` to `lint-types`;
      add a `lint` entry to `targetDefaults` running oxlint with `cache: true` and a `fix`
      configuration mirroring the existing ESLint one; add the oxlint config paths
      (`{workspaceRoot}/.oxlintrc.json`, `{workspaceRoot}/tooling/oxlint-config/**/*`) to
      `namedInputs.sharedGlobals` so a rule change invalidates the cache (**gap G9**).
- [ ] **T029** Add an explicit `lint` target to all 7 `project.json` files, following the existing
      `typecheck`/`test` shape (`nx:run-commands` + `cwd`). Verify `pnpm nx show project <name>` lists
      both `lint` and `lint-types`.
- [ ] **T030** Verify **gap G9** empirically: change one rule's severity in the oxlint config, re-run
      `pnpm lint:check`, and confirm a cache **miss**. A cache hit here means a rule change silently
      does nothing — fix the inputs before continuing.
- [ ] **T031** Verify **gap G7**: plant a module-boundary violation and confirm
      `pnpm nx run <project>:lint-types` reports `@nx/enforce-module-boundaries`. This closes the
      pre-existing silent-skip gap found in `research.md` §1.
- [ ] **T032** Update `package.json`: replace the `lint-staged` ESLint entry with
      `oxlint --fix` (keeping `prettier --write` last so Prettier owns formatting, FR-017), and **drop
      `node --max-old-space-size=8192`** — it exists only to survive ESLint's memory profile (SC-004).
      Point `lint` / `lint:check` at both targets.
- [ ] **T033** Update `.husky/pre-commit`: keep `npx lint-staged` first, and insert
      `pnpm nx affected -t lint-types` after `pnpm typecheck` and before `pnpm qlty:diff`. Make the
      oxlint step **fail closed** if the binary is missing, matching the existing `qlty` treatment
      (FR-018). Confirm a staged-deletion-only commit still succeeds (FR-019).
- [ ] **T034** Update `.github/workflows/ci.yml` to run `lint-types` alongside the existing targets:
      `pnpm exec nx affected -t lint lint-types test typecheck design-lint --parallel=$(nproc)`. Without
      this, CI stops enforcing 42 rules — an FR-011 violation and the worst possible outcome of this
      feature. **Note**: the GitHub App cannot modify `.github/workflows/`, so this task must be applied
      by a human or in a separate human-authored commit.
- [ ] **T035** Convert the two existing inline suppressions (**gap G8**):
      `packages/env-validation-errors/src/index.ts:3` disables `@bluetel-ai/enforce-safe-env`, which now
      lives in oxlint, so it needs the `oxlint-disable-next-line` form;
      `packages/env-validation-errors/src/index.test.ts:253` disables a type-aware rule and stays as it
      is. Confirm both still suppress, and that neither file reports an error.

**Checkpoint**: both layers enforce the full 129 rules, the parity suite is green, no duplicate
diagnostics.

---

## Phase 5: Prove it and document it (US1, US3, US4)

**Goal**: Turn each success criterion into a recorded measurement, and make the new commands
discoverable.

**Independent Test**: `measurements.md` has a before/after row for SC-001 to SC-004, and
`rule-inventory.md` accounts for all 129 rules.

- [ ] **T036** **SC-001 / SC-004**: re-run the single-file timing with
      `/usr/bin/time -f "%e s %M KB"`. Record wall time (target < 1 s, from 5.68 s) and peak RSS (target
      far below 798 648 KB). If SC-001 is missed, apply the T017 fallback and re-measure before
      declaring done.
- [ ] **T037** **SC-002**: time the full `.husky/pre-commit` run on the same one-file staged diff used
      in T001. Target ≥ 40 % reduction. Note that step 4 is Nx-cached, so record both a warm and a cold
      figure — quoting only the warm one would overstate the result.
- [ ] **T038** **SC-003**: `time pnpm lint:check --skip-nx-cache` and the `lint-types` equivalent.
      Target ≤ 15 s combined, from 30.7 s.
- [ ] **T039** **SC-005**: complete `rule-inventory.md` — every one of the 129 rows has an Owner and a
      Status. Any `dropped` row needs a reason, a compensating check, and explicit sign-off in the PR
      body. Ideally there are none.
- [ ] **T040** **SC-006**: full parity suite run. Every previously-enforced rule fires on its planted
      violation.
- [ ] **T041** **SC-007**: `pnpm nx run-many -t lint lint-types` exits zero across the workspace, and
      `git diff origin/main` contains no `eslint-disable`/`oxlint-disable` added to a pre-existing file
      (the two conversions in T035 are edits to existing comments, not new suppressions).
- [ ] **T042** [P] Update `AGENTS.md` and `.claude/rules/typescript-conventions.md` (FR-020): the two
      lint layers, when each runs, the fast standalone command agents should use mid-edit (US3), and how
      to add a rule to the right layer (US5). Must not contradict the Constitution.
- [ ] **T043** [P] Amend `.specify/memory/constitution.md` — principle IV names "ESLint (with `--fix`)
      … via lint-staged" and the Development Workflow section lists the pre-commit step order. Both are
      now inaccurate. Per the Governance section, a tool/document disagreement is a defect that must be
      fixed in the same change that discovers it. PATCH or MINOR bump with a Sync Impact Report.
- [ ] **T044** Run `/speckit-analyze` across `spec.md`, `plan.md` and `tasks.md` to catch drift, then
      run the full gate set: `pnpm nx affected -t lint lint-types test typecheck`, `pnpm knip`,
      `pnpm qlty:diff`.
- [ ] **T045** Open follow-up issues for the deliberately-deferred items, so they are not lost:
      (a) TypeScript 7 upgrade → `oxlint --type-aware` collapses the hybrid into one linter;
      (b) `cspell` CLI as its own Nx target (`research.md` §3.5 option B), if SC-003 came in tight;
      (c) collapsing `eslint-config-base` into `eslint-config-internal` now that `enforce-safe-env` has
      moved; (d) widening `BRANCH_PATTERN` in `tooling/commit-conventions/src/validate.ts` to admit
      `claude/*`, or having the workflow create `feature/*` branches (plan.md **C2**).

---

## Dependencies

```text
Phase 1 (cspell)      ── independent, ship first
Phase 2 (harness)     ── independent of Phase 1; MUST precede Phase 4
Phase 3 (spike)       ── needs Phase 2's rule extraction (T006)
Phase 4 (migration)   ── needs Phase 2 green + Phase 3 answers
Phase 5 (verify)      ── needs Phase 4
```

Within Phase 3, T013–T016 are `[P]` — separate scratch configs, no shared state. T017 needs T014.
Within Phase 4: T019–T020 → T021–T025 → T026–T027 → T028–T035, in order.

## Parallel execution notes

- **T013, T014, T015, T016** — four independent spikes, different scratch configs.
- **T007** runs alongside T006's implementation.
- **T042, T043** — different files, no overlap.
- Everything in Phase 4 touches shared config files and must be **sequential**. Parallelising it is how
  a rule goes missing between two half-applied edits.

## Implementation strategy

**Land Phase 1 on its own.** It is ~1.5 s of the win for none of the risk, and it makes the rest
optional rather than all-or-nothing.

**Do not start Phase 4 until Phase 2 is green.** The whole feature turns on a claim — no coverage lost
— that only the harness can substantiate. Written afterwards, it would be shaped by the migration it is
supposed to be auditing.

**Treat Phase 3's decision gate as real.** If oxlint plus the needed JS plugins cannot beat 1 s, the
correct outcome is Phase 1 plus a written record of why, not a migration that adds a Rust binary, three
dependencies and a second config language for a 20 % gain.

**Every fallback moves rules toward ESLint, never out of enforcement.** Coverage is the invariant;
speed is the goal. When they conflict, coverage wins and the phase gets re-scoped.
