---
description: 'Task list for the static prompt-quality validator (tooling/prompt-lint)'
---

# Tasks: Static prompt-quality validator for AI-authored artifacts

**Input**: Design documents from `/specs/005-prompt-quality-validator/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/cli.md](./contracts/cli.md),
[contracts/report.schema.md](./contracts/report.schema.md), [contracts/rules.md](./contracts/rules.md),
[quickstart.md](./quickstart.md)

**Tests**: Test tasks are **included and mandatory**, not optional. Two independent reasons, neither of them TDD
dogma: Constitution III requires a colocated `<module>.test.ts` for every module file and forbids `--no-verify`,
and [spec.md](./spec.md) SC-004 requires _per rule_ both a test proving it fires on a violating artifact and one
proving it does not fire on a compliant one. A rule task is therefore not complete when the rule works — it is
complete when both halves of its pair exist. **Every task below that names a source module also names its
colocated suite, and the two land in the same task**, because a rule and the fixtures that pin its behaviour
cannot be reviewed apart.

**Organization**: Grouped by user story, in the spec's priority order. Each story is independently shippable and
leaves the repository in a working state.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: Which user story the task belongs to (US1–US4). Setup, Foundational and Polish tasks carry none
- Exact file paths are given in every task

## Path Conventions

Nx + pnpm monorepo. One new workspace member, `tooling/prompt-lint/` (`@bluetel-ai/prompt-lint`), structurally
cloned from `tooling/qlty-diff/`. All paths below are repository-relative. All task execution goes through
`pnpm nx` from the repository root, or `pnpm exec` from the project directory (Constitution I).

Seven files change outside the new project, exactly as [plan.md](./plan.md#files-changed-outside-the-new-project)
lists: `package.json`, `knip.json`, `cspell.json`, `README.md`, `.github/workflows/ci.yml`, `.husky/pre-commit`,
`tooling/skills/project.json`.

## How these phases map onto the plan's phases

[plan.md](./plan.md#phasing-delivery-order-by-user-story) names four delivery phases A–D by story. This document
splits A into the parts that block every story and the parts that only serve US1, because the template's
Foundational phase is the thing that must be finished before any story can start:

| Plan phase | Phases here                         | Story |
| ---------- | ----------------------------------- | ----- |
| A          | Phase 1 (Setup) + Phase 2 + Phase 3 | US1   |
| B          | Phase 4                             | US2   |
| C          | Phase 5                             | US3   |
| D          | Phase 6                             | US4   |
| —          | Phase 7 (Polish)                    | —     |

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Stand the project up as a workspace member Nx can see, before any behaviour exists. Every file here
is a copy-with-renames of its `tooling/qlty-diff/` counterpart; deviating from that shape is a finding, not a
choice ([plan.md](./plan.md#summary)).

- [x] T001 Create `tooling/prompt-lint/package.json` — `@bluetel-ai/prompt-lint`, `"private": true`,
      `"type": "module"`, `"main": "./src/index.ts"`, `"exports": { ".": "./src/index.ts" }`, devDependencies
      `@bluetel-ai/eslint-config-internal: workspace:*` and `vitest: ^3.2.4`. Copy the field order of
      `tooling/qlty-diff/package.json`.
- [x] T002 [P] Create `tooling/prompt-lint/project.json` — `"name": "prompt-lint"`,
      `"projectType": "library"`, and the two targets from `tooling/qlty-diff/project.json` verbatim except for
      `cwd`: `typecheck` (`tsc --noEmit`, `inputs` including `{projectRoot}/tsconfig.json`, `cache: true`) and
      `test` (`vitest run`, `cache: true`).
- [x] T003 [P] Create `tooling/prompt-lint/tsconfig.json` extending `../../tsconfig.base.json`. Do not relax
      `strict`, `isolatedModules`, ESM or `bundler` module resolution (Constitution, Technology Standards).
- [x] T004 [P] Create `tooling/prompt-lint/vitest.config.ts` mirroring `tooling/qlty-diff/vitest.config.ts`.
- [x] T005 [P] Create `tooling/prompt-lint/eslint.config.mjs` — the shared base plus `withTypeChecking`, as every
      `tooling/*` project does.
- [x] T006 Add to root `package.json`: `"@bluetel-ai/prompt-lint": "workspace:*"` in `devDependencies`, and the
      two scripts `"prompt-lint": "tsx tooling/prompt-lint/src/cli.ts --all"` and
      `"prompt-lint:diff": "tsx tooling/prompt-lint/src/cli.ts"` — placed beside `qlty` / `qlty:diff` so the pair
      reads as the two gates it is. Then `pnpm install` and commit the lockfile change.
- [x] T007 [P] Update `knip.json`: add `"@bluetel-ai/prompt-lint"` to the root `ignoreDependencies` array (a root
      devDependency consumed only by a script otherwise reads as unused and `knip:orphans` is a blocking CI step),
      and add a `"tooling/prompt-lint"` workspace entry declaring `src/cli.ts` and `src/test-helpers.ts` as
      entries — `cli.ts` is deliberately not exported from the barrel, and the test helpers are imported only by
      suites, which is the same shape `tooling/skills`' `lib/test-helpers.ts` entry already handles.
- [x] T008 [P] Update `cspell.json` with the identifiers this feature introduces — `contextops`, `tiktoken`,
      `uvx`, `pipx`, `frontmatter`, `semver`, `prompt-lint` — then confirm with `pnpm audit:cspell`.
- [x] T009 Verify the skeleton before writing behaviour: `pnpm nx run prompt-lint:typecheck` and
      `pnpm nx run prompt-lint:test` both resolve the project, and `pnpm exec tsc --noEmit` succeeds from
      `tooling/prompt-lint/` (Constitution I — runnable in isolation). An empty suite is acceptable at this task;
      an unresolvable project is not.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The types every later module speaks, and the two stages upstream of every rule — `scope/` (the only
code that touches `git`) and `artifact/` (the only code that touches the filesystem). Every rule in every story
is a pure function over their output, which is what makes the rule suites fixture-driven
([data-model.md](./data-model.md)).

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T010 Implement `tooling/prompt-lint/src/rules/define.ts` + `define.test.ts` — the `Severity`, `RuleId`,
      `Dimension`, `Rule`, `RuleInput` and `Finding` types from
      [data-model.md](./data-model.md#rules-and-findings), and the `defineRule` helper. `defineRule` is the
      anti-duplication seam Constitution IV forces (15+ rule modules of identical skeleton is how a diff crosses
      the 10% duplication limit — [plan.md](./plan.md#constitution-check)), so it lands first, not as a later
      cleanup. The `source: 'prompt-lint' | 'contextops'` discriminant is part of the type from the start, even
      though nothing sets `'contextops'` until Phase 6.
- [x] T011 Implement `tooling/prompt-lint/src/config.ts` + `config.test.ts` — the `Config` type and the default
      object, one exported constant, with the `[PROMPT_LINT_*]` comment convention copied from
      `tooling/qlty-diff/src/config.ts`. Ships `maxErrors: 0`, `maxWarnings: 50`, `minScore: 0` (inert),
      `severities`, `exclude` (each entry with a non-empty `reason`) and `defaultBaseRef: 'origin/main'`. The
      `contextops` block and `tokenBudgets` are added in Phase 6 (T070). Also implement `validateConfig` covering
      every row of the FR-036 table in [data-model.md](./data-model.md#config) that is expressible now, and its
      test: an invalid config exits before any artifact is read.
- [x] T012 [P] Implement `tooling/prompt-lint/src/test-helpers.ts` — the shared fixture builders every rule suite
      uses (`artifactFixture()`, `metaFixture()`, `expectFires()`, `expectDoesNotFire()`). Shared helpers rather
      than per-suite copy-paste, for the same duplication reason as `defineRule`; and they are what make SC-004's
      fires/does-not-fire pair two lines per rule instead of twenty.
- [x] T013 [P] Implement `tooling/prompt-lint/src/artifact/load.ts` + `load.test.ts` — the `Artifact` type and the
      loader. Covers each `readError` case explicitly: `not-utf8`, `symlink`, `empty`, `unreadable`. A
      `readError` artifact keeps its place in the model and is never dropped, because the rules that need
      `content` must be recorded as **not evaluated** rather than passing (spec Edge Cases).
- [x] T014 [P] Implement `tooling/prompt-lint/src/artifact/markdown.ts` + `markdown.test.ts` — the hand-written
      positional scanner producing `MarkdownView` and `PathToken` ([research.md](./research.md#r3)): lines,
      headings, fenced ranges, HTML comment ranges, per-line code spans, links, and path-shaped tokens with their
      `inCodeSpan` / `inFence` / `inHtmlComment` / `literal` flags. It holds no judgement — every rule that reads
      it decides what the position means.
- [x] T015 [P] Implement `tooling/prompt-lint/src/artifact/meta.ts` + `meta.test.ts` — `skill.meta` `key=value`
      parsing into `MetaBlock`, preserving order, keeping every value of a repeatable key (`next_step` is the only
      one), and recording `duplicates` and `strayLines` ([research.md](./research.md#r4)).
- [x] T016 [P] Implement `tooling/prompt-lint/src/artifact/frontmatter.ts` + `frontmatter.test.ts` — the flat
      `key: value` block of a `.claude/` pointer, into the same `MetaBlock` shape with
      `format: 'frontmatter'`. No YAML dependency: the decision and its boundary are
      [research.md](./research.md#r4).
- [x] T017 Implement `tooling/prompt-lint/src/artifact/suppress.ts` + `suppress.test.ts` — parse
      `<!-- prompt-lint-disable-next-line <rule> — <reason> -->` and the `#` form for `skill.meta` into
      `Suppression`, next-line scope only. A suppression with no reason is surfaced for the
      `suppression/unreasoned` finding (T029), and `used` is left for the evaluator to set so
      `suppression/stale` can be reported (FR-009, FR-010).
- [x] T018 Create `tooling/prompt-lint/src/artifact/index.ts` — the barrel for `load`, `markdown`, `meta`,
      `frontmatter`, `suppress`. Cross-directory imports go through it and never reach into a module path
      (Constitution II).
- [x] T019 [P] Implement `tooling/prompt-lint/src/scope/patterns.ts` + `patterns.test.ts` — the single declared
      table of artifact locations (FR-001, FR-002) covering the skill catalog, `.agents/skills/*/**`,
      `.claude/skills/*/SKILL.md`, `AGENTS.md`, `CLAUDE.md`, `.claude/rules/*.md`, `.agents/*.md`,
      `.specify/templates/*.md` and `.specify/memory/constitution.md`, plus the four named subsets `--scope=`
      accepts (`catalog`, `installed`, `guidance`, `speckit`). The test asserts `specs/**` is **not** in the set
      ([research.md](./research.md#r1)) and that every subset name resolves.
- [x] T020 [P] Implement `tooling/prompt-lint/src/scope/classify.ts` + `classify.test.ts` — path → `ArtifactKind`
      per the table in [data-model.md](./data-model.md#artifactkind). A file that matches a declared location but
      fits no kind classifies as `unclassified` and is reported, never skipped (FR-004).
- [x] T021 [P] Implement `tooling/prompt-lint/src/scope/git.ts` + `git.test.ts` — changed-vs-base, staged, and
      all-files enumeration via `node:child_process`, plus deletion detection (the diff's deleted paths, which
      T055 needs to widen `refs/dangling-path` to `universe`). An unresolvable base ref or a non-repository is a
      typed failure carrying the ref name, which `cli.ts` turns into exit `4` (FR-032, US2 §5) — never an empty
      changed-file list.
- [x] T022 Implement `tooling/prompt-lint/src/scope/resolve.ts` + `resolve.test.ts` — assemble the `Scope`:
      `targets` (what per-artifact rules run over), `universe` (the whole declared set, which set-scoped rules run
      over), the `PathIndex` built once, and `exclusions` with a reason for each (FR-005). The `targets` versus
      `universe` distinction is the model's load-bearing one; the suite asserts it directly, because US1 §4 is
      exactly the case where the referring artifact is in `universe` and not in `targets`.
- [x] T023 Create `tooling/prompt-lint/src/scope/index.ts` — the barrel for `patterns`, `classify`, `git`,
      `resolve`.
- [x] T024 Implement `tooling/prompt-lint/src/report/order.ts` + `order.test.ts` — the one deterministic ordering
      used everywhere: severity descending, then `path`, then `line`, then `rule`. Total and stable, so SC-005
      holds structurally rather than by discipline (FR-029). The suite asserts a shuffled input produces an
      identical output.

**Checkpoint**: Types, scope and artifact loading exist and are tested. Rules can now be written as pure
functions, and every story below can start.

---

## Phase 3: User Story 1 - A contributor edits a skill and learns immediately that it is broken (Priority: P1) 🎯 MVP

**Goal**: `pnpm prompt-lint:diff` on a branch reports correct, actionable findings about the artifacts that branch
touched — a dangling reference, a missing metadata field, a placeholder left in — with file, line, rule and fix,
and exits non-zero.

**Independent Test**: On a scratch branch, break a reference path in one artifact and delete a required metadata
field in another. Run `pnpm prompt-lint:diff origin/main`. Confirm exit non-zero, exactly those findings, each
with a `→` remediation, and nothing about the hundreds of artifacts the branch did not touch. Fix both; confirm
exit `0`. Then delete a referenced file and confirm the finding lands on the surviving artifact that references
it. Full script: [quickstart.md](./quickstart.md) Scenario 4.

- [x] T025 [P] [US1] Implement `tooling/prompt-lint/src/rules/metadata.ts` + `metadata.test.ts` — four rules via
      `defineRule`: `meta/required-field` (`name`, `version`, `description` for `catalog-meta`; `name`,
      `description` for `agent-pointer`), `meta/duplicate-key` (only `next_step` repeatable),
      `meta/version-semver`, `meta/stray-line`. Each gets the SC-004 pair. Statements, rationales and fixes come
      verbatim from [contracts/rules.md](./contracts/rules.md#meta--metadata-integrity) — the catalogue is the
      contract, not a summary written afterwards.
- [x] T026 [P] [US1] Implement `tooling/prompt-lint/src/rules/references.ts` + `references.test.ts` —
      `refs/dangling-path`, implementing the three-root resolution algorithm of
      [research.md](./research.md#r2): resolve against the artifact's directory, then its `skillRoot`, then the
      repository root; report only a token that is `literal`, path-shaped, and whose first segment is a real
      directory in one of those roots. **This is the task the feature's credibility rests on**, so its suite is
      asymmetric on purpose: one fires-case (the live defect —
      `tooling/skills/catalog/copywriting/references/natural-transitions.md:276` naming a `seo-audit` skill that
      does not exist) and a does-not-fire case for **each** shape the naive rule got wrong — bare filenames with
      no `/`, tokens carrying variable syntax, paths inside fenced blocks and code spans, paths whose first
      segment is not a real directory, and paths in HTML comments. The naive rule produced 40+ hits and one true
      positive; a suite that only proves the true positive would not have caught that.
- [x] T027 [P] [US1] Implement `tooling/prompt-lint/src/rules/sections.ts` + `sections.test.ts` —
      `skill/section-missing`: a `catalog-skill` or `installed-skill` body carries a completion-criteria section
      (`## Done When` or equivalent). Fires on a body with no such section; does not fire on the `speckit-*`
      bodies that already model it.
- [x] T028 [P] [US1] Implement `tooling/prompt-lint/src/rules/placeholders.ts` + `placeholders.test.ts` —
      `template/placeholder-residue`: bracketed template slots, clarification markers, `TODO`, and `$ARGUMENTS`
      outside its intended slot, **ignored inside code spans, fenced blocks and HTML comments** (which is what
      lets this repository's own rule catalogue quote the tokens it detects — spec Edge Cases). The rule is
      **inverted** for `speckit-template`: there the tokens must be _present_, so a template cannot be filled in
      place and shipped. Both directions get the pair.
- [x] T029 [US1] Wire the four bookkeeping rules — `artifact/unclassified` (from `scope/classify.ts`),
      `artifact/unreadable` (from `artifact/load.ts`), `suppression/unreasoned` and `suppression/stale` (from
      `artifact/suppress.ts`). Their declarations live in `tooling/prompt-lint/src/rules/registry.ts` and their
      findings are emitted by `tooling/prompt-lint/src/gate.ts`, because they describe the run rather than an
      artifact's content ([contracts/rules.md](./contracts/rules.md#bookkeeping-rules)). They have no
      configurable severity and cannot be baselined: a report that cannot say "I could not read this file" is
      worse than a red one. Tests land in `registry.test.ts` and `gate.test.ts`.
- [x] T030 [US1] Implement `tooling/prompt-lint/src/rules/registry.ts` + `registry.test.ts` — the array of every
      rule, and the registry invariants that make the rule set self-describing (FR-006): ids unique and
      `family/name`-shaped, `statement` and `rationale` non-empty, `appliesTo` non-empty for artifact-scoped
      rules, and **every rule able to produce a non-empty `remediation`** — SC-006 enforced by a test rather than
      by review. The catalogue cross-check against `docs/rules.md` is a separate task (T045), because that file
      does not exist yet.
- [x] T031 [US1] Create `tooling/prompt-lint/src/rules/index.ts` — the barrel exporting `defineRule`, the
      registry and the rule modules.
- [x] T032 [US1] Implement `tooling/prompt-lint/src/report/human.ts` + `human.test.ts` — the output shape in
      [contracts/cli.md](./contracts/cli.md#human-output-shape): verdict line first **and** last, counts by
      severity, findings ordered by `order.ts`, every finding printing what is wrong and a `→` fix, the list
      capped at `--max-findings` with the omitted count always stated (FR-037), and the empty-scope case replaced
      by the single explicit line `no AI-authored artifacts in scope` (FR-040). The suite asserts the negative
      properties too, because they are the ones that rot silently: no absolute path, no timestamp, no duration
      (FR-039).
- [x] T033 [US1] Create `tooling/prompt-lint/src/report/index.ts` — the barrel for `human` and `order`.
- [x] T034 [US1] Implement `tooling/prompt-lint/src/gate.ts` + `gate.test.ts` — the orchestration, one direction
      only: validate config → resolve scope → load artifacts → run per-artifact rules over `targets` → apply
      suppressions → order → render. Emits the bookkeeping findings from T029, records **not evaluated** for
      every rule skipped because an artifact failed to parse or read, and returns a `Report` plus the verdict.
      The exit-code contract itself is T041; this task returns the verdict and lets the caller map it.
- [x] T035 [US1] Create `tooling/prompt-lint/src/index.ts` — the barrel exporting `runPromptLintGate` and the
      public types only. `cli.ts` is deliberately **not** exported (it is an executable), which is why T007 gives
      knip an explicit entry for it.
- [x] T036 [US1] Implement `tooling/prompt-lint/src/cli.ts` + `cli.test.ts` — argv per
      [contracts/cli.md](./contracts/cli.md#arguments-and-flags): the positional base ref, `--all`, `--staged`,
      `--max-findings=<n>`. Mutually exclusive scopes and unknown flags are usage errors (exit `2`), never
      silently resolved or ignored. `cli.test.ts` was absent from the module tree in
      [plan.md](./plan.md#source-code-repository-root) when this list was generated; Constitution III admits no
      exception for an entry point, so the suite exists and the tree was corrected in the same change that added
      this task, along with an explicit statement that the `index.ts` barrels are the one exemption.
- [ ] T037 [US1] Run the US1 acceptance script end to end —
      [quickstart.md](./quickstart.md#scenario-4--a-contributors-broken-edit-is-caught-locally-us1-all-five-scenarios).
      All five US1 scenarios in one pass: a dangling reference reported with line and fix (§1), a diff touching
      only source code reporting `no AI-authored artifacts in scope` at exit `0` (§3), a deleted referenced file
      reported against the surviving referrers that the diff never touched (§4 — the `targets`/`universe`
      property), and every finding readable without opening the source (§5). §2 (`install/version-bump`) belongs
      to US3 and is expected to be absent here; note it as such rather than as a failure.

**Checkpoint**: US1 is complete and usable on its own. A contributor gets a correct verdict on their own branch in
seconds with no CI round-trip, and nothing yet blocks anyone.

---

## Phase 4: User Story 2 - CI refuses to merge a pull request that degrades the prompt surface (Priority: P2)

**Goal**: The same run, wired as a blocking gate — one central set of thresholds, a documented exit-code contract,
a draining baseline so the rule set can be adopted in stages, and the two integration seams (CI and the
pre-commit hook).

**Independent Test**: Open a pull request containing exactly one error-severity prompt defect and nothing else.
The prompt-quality step fails, its log names the finding, and the failure is attributable to this gate rather than
to lint, typecheck, tests or `qlty`. Remove the defect; the step passes.
[quickstart.md](./quickstart.md#scenario-5--the-gate-blocks-a-pull-request-and-only-for-the-right-reason-us2-sc-008)
provokes each exit code in turn.

- [ ] T038 [US2] Implement `tooling/prompt-lint/src/baseline.ts` + `baseline.test.ts` — read
      `tooling/prompt-lint/baseline.json`, downgrade a matched finding to `note` and set `baselined: true`, and
      report an entry that matches nothing as `suppression/stale` at `warn` (FR-010's mechanism, reused) so the
      file drains and cannot quietly become permanent. Entries are keyed on `rule` + `path` only — not on line
      number, which would churn on every unrelated edit, and not on a content hash, which would make the file
      unreadable.
- [ ] T039 [P] [US2] Create `tooling/prompt-lint/baseline.json` as an empty entry list with a header comment
      naming what it is for. It is populated from a measured run in T058, not guessed now.
- [ ] T040 [US2] Extend `tooling/prompt-lint/src/config.ts` + `config.test.ts` with the per-rule `severities`
      override applied at evaluation time — the staged-adoption lever
      ([plan.md](./plan.md#adoption-how-this-lands-without-breaking-every-open-pr)). The test asserts a
      `severities` key naming a rule that does not exist is a config error (FR-036), which is also what catches a
      rule rename, and that **no environment variable can change a per-rule severity or the exclusion list**
      (FR-034, SC-009 — those change _what_ is checked, so they must appear in a diff).
- [ ] T041 [US2] Extend `tooling/prompt-lint/src/gate.ts` + `gate.test.ts` with the threshold comparison and the
      full exit-code contract from [contracts/cli.md](./contracts/cli.md#exit-codes): `0` within thresholds
      (including the explicit nothing-in-scope case), `1` threshold breached, `2` usage, `3` config invalid with
      **no artifact evaluated**, `4` scope not establishable, `5` a rule threw — named, never swallowed into a
      clean pass. The suite asserts each code independently, because the whole value of the contract is that a
      red step is attributable to "the prompts are wrong" versus "the tool could not run".
- [ ] T042 [US2] Extend `tooling/prompt-lint/src/cli.ts` + `cli.test.ts` with `--list-rules`, `--explain=<ruleId>`
      (both exit `0`, evaluating no artifacts) and `--no-baseline`. An unknown `--explain` target is exit `2`.
- [ ] T043 [US2] Extend `tooling/prompt-lint/src/report/human.ts` + `human.test.ts` with the header line naming
      every `PROMPT_LINT_*` override in effect and the footer line reporting
      `suppressions: N used, M stale   baseline: N applied, M stale`. FR-034's point is that a passing CI log must
      never be able to conceal a relaxed threshold, so the test asserts the header from the environment, not from
      a parameter.
- [ ] T044 [US2] Write `tooling/prompt-lint/docs/rules.md` — the FR-047 catalogue, mirrored from
      [contracts/rules.md](./contracts/rules.md) for every rule that exists at this phase, each entry carrying
      id, ships-as severity, statement, rationale and fix. This is the copy the cross-check reads; the spec
      directory's copy stays the design record.
- [ ] T045 [US2] Extend `tooling/prompt-lint/src/rules/registry.test.ts` with the catalogue cross-check (FR-047,
      SC-010): every registered rule has an entry in `docs/rules.md` and every entry names a registered rule.
      This is the test that makes an undocumented rule impossible and a documented-but-deleted rule impossible in
      the same assertion.
- [ ] T046 [US2] Add the gate to `.github/workflows/ci.yml` — a step in the `main` job running
      `pnpm prompt-lint:diff "origin/$BASE_REF"` with `BASE_REF: ${{ github.base_ref }}`, and `prompt-lint`
      appended to the `nx affected -t lint test typecheck design-lint` target list. The `contextops` setup step is
      Phase 6 (T077): at this phase the delegated half does not exist, so the gate is the correctness half and
      needs no Python. **`.github/workflows/` cannot be modified by the GitHub App this repository's agent runs
      as**, so this task requires a human commit or a token with `workflows` scope — flagged here rather than
      discovered at push time.
- [ ] T047 [US2] Add `pnpm prompt-lint:diff` to `.husky/pre-commit`, after `pnpm typecheck` and before the qlty
      block. It does **not** install anything, unlike the qlty block below it
      ([research.md](./research.md#r9)). Note the working-tree state: `.husky/pre-commit` currently carries an
      uncommitted modification that makes the qlty block install on demand; reconcile with whatever has landed
      rather than reverting it blind.
- [ ] T048 [P] [US2] Write `tooling/prompt-lint/README.md` — what it gates, how to run it, the exit codes, how to
      add a rule (one `defineRule` module + its suite + its catalogue entry), and how to add a baseline entry.
- [ ] T049 [P] [US2] Add the prerequisite section to the root `README.md`: what `prompt-lint` needs available and
      the routes to providing it. The `contextops` specifics are appended in T079 when that half exists.
- [ ] T050 [US2] Run [quickstart.md](./quickstart.md#scenario-5--the-gate-blocks-a-pull-request-and-only-for-the-right-reason-us2-sc-008)
      Scenario 5 for exit codes `0`–`4` (exit `6` is Phase 6), and
      [Scenario 9](./quickstart.md#scenario-9--pre-commit-path-fr-043) for the hook. Time the hook step: FR-043
      requires it be fast enough that skipping it is never worth it, and a hook slow enough to skip is a hook that
      gets skipped. Verify the exit-`4` case deliberately — a shallow checkout must **fail** rather than evaluate
      zero artifacts and pass (US2 §5).

**Checkpoint**: US1 and US2 both work. A prompt defect cannot reach `main` green, and lowering a threshold is a
visible edit to one file.

---

## Phase 5: User Story 3 - A skill cannot be published to other projects broken (Priority: P3)

**Goal**: The catalog-specific invariants no other check knows about — declared dependencies, agreement with
`.agents/skills.config`, and the three cross-tree rules that protect the catalog→target install model.

**Independent Test**: For each catalog invariant, break it in a scratch copy and confirm exactly the corresponding
rule fires and no other. Then confirm a clean catalog produces no findings.
[quickstart.md](./quickstart.md#scenario-6--a-skill-cannot-be-published-broken-us3-fr-044) has the break/expect
table.

- [ ] T051 [P] [US3] Implement `tooling/prompt-lint/src/rules/declared.ts` + `declared.test.ts` —
      `meta/declared-dependency-missing`: `requires=` names catalog skills that exist, `assets=` names an existing
      bundle directory, and each `next_step=` line carries its two mandatory `|`-separated fields (`action`,
      `why`) with an optional third (`when`). A `next_step` missing its `why` renders as a bare instruction with
      no rationale, which is exactly what that field exists to prevent, so it fires.
- [ ] T052 [P] [US3] Implement `tooling/prompt-lint/src/rules/conventions.ts` + `conventions.test.ts` —
      `conventions/config-mismatch`: an artifact must not assert a convention contradicting
      `.agents/skills.config` — a recognisable `owner/repo` slug that is not the configured one, a
      `PREFIX-<digits>` ticket token that is not the configured prefix, or a base/staging branch name that is not
      the configured branch. Mechanical comparisons only; it does not read the meaning of a sentence. The
      fires-case fixture is the live defect: `.agents/remote-workflow-instructions.md` naming `URM` and
      `harrytwigg/universal-react-monorepo` while the config says `bluetel/bluetel-ai`.
- [ ] T053 [P] [US3] Implement `tooling/prompt-lint/src/rules/trigger.ts` + `trigger.test.ts` —
      `skill/use-when-trigger` (FR-014): a `catalog-meta` or `agent-pointer` `description` carries a `Use when:`
      clause naming the situations the skill applies to, because the description is the only thing an agent sees
      when deciding whether to invoke a skill. Fires on the ten `speckit-*` descriptions, which describe what they
      do but never when — which is why they get selected by name rather than by need; does not fire on the seven
      that already carry the clause (`review`, `merging`, `pr-creation`, `copywriting`, `jira-ticket`,
      `skills-install`, `frontend-design`). It ships at `warn` with those ten baselined (T058). **This rule was absent from the
      plan's phase table**: [plan.md](./plan.md#phasing-delivery-order-by-user-story) listed it in no phase, while
      [contracts/rules.md](./contracts/rules.md#skill--skill-body-contract) and
      [data-model.md](./data-model.md#the-25-rules-by-family) both require it. It belongs here, with the rest of
      the catalog-publishing invariants US3 §2 names; phase C of that table was corrected in the same change that
      added this task.
- [ ] T054 [US3] Implement `tooling/prompt-lint/src/rules/install.ts` + `install.test.ts` — the three
      `scope: 'set'` rules: `install/catalog-drift` (`.agents/skills/<name>/` matches
      `tooling/skills/catalog/<name>/` byte for byte, **excluding** the files the installer's model deliberately
      leaves per-project — `.skill`, `.agents/skills.config`, asset bundles), `install/version-bump` (content
      changed in the diff, `version` did not), and `install/pointer-mismatch` (a `.claude/` pointer's frontmatter
      `name`/`description` agrees with `skill.meta`, and its body still names the shared
      `.agents/skills/<name>/SKILL.md` file). Each finding names **both** paths via `related`. `install/version-bump`
      is diff-scoped by nature: under `--all` it is reported as **not evaluated**, never as passing.
- [ ] T055 [US3] Extend `tooling/prompt-lint/src/gate.ts` + `gate.test.ts` to run set-scoped rules over
      `universe` while per-artifact rules run over `targets`, and to widen `refs/dangling-path` to `universe`
      when the diff deletes any artifact. Stated as one rule in
      [data-model.md](./data-model.md#scope-and-configuration) and asserted here, because getting it wrong makes
      US1 §4 silently pass.
- [ ] T056 [US3] Add a `prompt-lint` target to `tooling/skills/project.json` running the validator with
      `--scope=catalog`, so `nx affected -t … prompt-lint` runs the catalog rules whenever a skill changes.
      Division of labour, stated in the spec's Assumptions and worth restating in the target's comment: **the
      shell tests own the installer's behaviour, `prompt-lint` owns the artifact's content.** Confirm
      `pnpm nx test skills` still passes unchanged (FR-044).
- [ ] T057 [US3] Extend `tooling/prompt-lint/docs/rules.md` with the entries for T051–T054 and re-run the
      cross-check from T045. A rule cannot land without its entry — that is what the cross-check is for.
- [ ] T058 [US3] Measure the surface and set the adoption state: run `pnpm prompt-lint --all --no-baseline`,
      compare against the table in
      [plan.md](./plan.md#adoption-how-this-lands-without-breaking-every-open-pr), then encode it — `warn` for
      `skill/use-when-trigger` and `conventions/config-mismatch` in `src/config.ts` `severities`, and one
      `baseline.json` entry per known pre-existing violation with a reason. Record any divergence from the
      predicted counts in the pull request; a measurement that disagrees with the plan is information, not a
      number to bend.
- [ ] T059 [US3] Run [quickstart.md](./quickstart.md#scenario-6--a-skill-cannot-be-published-broken-us3-fr-044)
      Scenario 6 (one rule per break, both paths named for the set-scoped ones) and
      [Scenario 7](./quickstart.md#scenario-7--suppressions-and-the-baseline-behave-fr-009-fr-010-fr-035)
      (an unreasoned suppression is itself a finding and exempts nothing; a fixed violation with a surviving
      baseline entry reports that entry **stale**).

**Checkpoint**: US1–US3 all work. A broken catalog entry cannot be pushed green, and the two live defects the
design predicted are either fixed or explicitly recorded.

---

## Phase 6: User Story 4 - Anyone can see the whole prompt surface's health, and an agent can consume it (Priority: P4)

**Goal**: The delegated half. `contextops==0.3.3` is located, pinned, asserted and invoked once per context
bundle; its findings join the same stream and its score is reported **verbatim**; and `--json` emits the whole
report against the documented schema.

**Independent Test**: `pnpm prompt-lint` over the whole repository produces a per-bundle and aggregate score with
its four dimensions and the analyser's identity; `--json` emits valid structured data carrying every field the
human output showed; two runs over an unchanged tree are byte-identical; and pointing
`PROMPT_LINT_CONTEXTOPS_BIN` at nothing exits `6` with no score and no verdict of `pass`.
[quickstart.md](./quickstart.md#scenario-2--whole-repository-run-over-the-real-surface-us4-sc-002-sc-003)
Scenarios 2 and 3.

- [ ] T060 [US4] Obtain the human licence sign-off this phase is gated on, and record it in
      [plan.md](./plan.md#constitution-check) beside the `PASS*` it resolves. `contextops` is Sustainable-Use
      licensed: the grant covers _"your own internal business operations"_, which this repository's CI is inside,
      and it restricts _providing_ the software to third parties as part of a commercial offering — which is why
      nothing here ever ships, vendors or installs it (FR-052). **That reading was made by an agent from the
      licence text** ([research.md](./research.md#r8),
      [checklists/requirements.md](./checklists/requirements.md)) and is the one clarification the spec leaves
      open. It blocks nothing already built — the design is arranged so the answer is only ever needed to unblock
      new work — but it gates this phase, because Phase 6 is the first thing that depends on the tool. A human
      decision, not an agent's; the task is done when the decision is written down, either way.
- [ ] T061 [US4] Implement `tooling/prompt-lint/src/contextops/locate.ts` + `locate.test.ts` — the resolution
      order of [research.md](./research.md#r9): `PROMPT_LINT_CONTEXTOPS_BIN`, then `PATH`, then `uvx`, then
      `pipx run`, producing `AnalyserBinary` with the `source` that resolved it. The pinned version is
      **asserted** against `--version`, not merely required to be present — a different engine silently rescoring
      the repository is exactly what pinning is for (FR-050). Unresolvable or mismatched is exit `6` with the
      message from [contracts/cli.md](./contracts/cli.md#exit-codes) verbatim: every route named, both versions
      named on a mismatch, and `--rules-only` marked explicitly as **not** a substitute. The suite asserts the
      message content, because a bare "command not found" would be a worse failure than the one it replaces.
- [ ] T062 [US4] Implement `tooling/prompt-lint/src/contextops/bundle.ts` + `bundle.test.ts` — `Artifact[]` →
      `Bundle[]` per [research.md](./research.md#r10): `guidance` (what every run loads), `speckit`, and one
      `skill:<name>` per skill consisting of the fixed guidance prefix plus the skill body and its references.
      The exclusions are properties of the payload and are asserted directly: `.agents/skills/**` never enters a
      bundle (identity with the catalog is what installation _means_), an `agent-pointer` enters only as `tools`
      and never as measured `chunks` (17 near-identical pointers are the installer's intended shape), every
      bundle has at least one `chunks` entry, and membership derives from a sorted list so two runs build
      byte-identical payloads. **This is the second load-bearing decision after R2**: get it wrong and every
      number the dependency returns is noise.
- [ ] T063 [US4] Implement `tooling/prompt-lint/src/contextops/payload.ts` + `payload.test.ts` — `Bundle` → the
      `{system, chunks, tools}` JSON the analyser reads. `memory` is deliberately not modelled: there is no
      per-project memory store here, and filling the section with something that is not memory would produce a
      confident measurement of nothing.
- [ ] T064 [US4] Implement `tooling/prompt-lint/src/contextops/invoke.ts` + `invoke.test.ts` — one subprocess per
      bundle: an **explicitly constructed** environment (`TIKTOKEN_CACHE_DIR` when configured, `cwd` at the repo
      root) so no inherited variable becomes an unrecorded input, a temp payload file deleted after the run and
      never named in the report (FR-039), `--json-output` parsed into `AnalyserReport`, and a non-zero exit or
      unparseable response reported as a run failure naming the bundle and quoting the analyser's own stderr —
      never as a clean bundle. Plus the **contract test**: invoke the real pinned binary, assert `--version`
      equals the pin, and run `contextops stability` to prove the engine is deterministic on this machine. It
      skips with a message naming what it skipped when the binary is absent, so a contributor without Python
      still gets a green suite — but CI has it, so a drifted engine cannot land.
- [ ] T065 [US4] Implement `tooling/prompt-lint/src/contextops/map.ts` + `map.test.ts` — `AnalyserReport` →
      `Finding[]` (the five `contextops/*` rules) + `Scorecard`, driven by **recorded fixtures** with no
      subprocess. Translates `findings[].items` back to artifact paths, and where an item cannot be translated
      keeps the bundle id as the location and says so rather than guessing a file. Asserts the dimension maxima
      against the pinned version's published values (30/30/20/20) — a mismatch means the engine changed under a
      pin that claimed it had not — and rejects a `score` outside 0–100 as a run failure rather than scoring the
      bundle 0.
- [ ] T066 [US4] Create `tooling/prompt-lint/src/contextops/index.ts` — the barrel. It is the **only** surface
      the rest of the tree may import from, which is what makes replacing the dependency, or running without it,
      a bounded change (FR-053, Constitution II).
- [ ] T067 [P] [US4] Implement `tooling/prompt-lint/src/rules/delegated.ts` + `delegated.test.ts` — declarations
      only, no check body, for the five `source: 'contextops'` rules: `contextops/redundancy`,
      `contextops/density`, `contextops/token-budget`, `contextops/structure-imbalance`,
      `contextops/concentration`. Each carries an id, statement, rationale, configurable severity and catalogue
      entry exactly like any other rule, so `--list-rules` shows 25, `--explain contextops/concentration`
      answers, and the cross-check cannot be satisfied by documenting something nothing evaluates (FR-047).
- [ ] T068 [P] [US4] Implement `tooling/prompt-lint/src/rules/structure.ts` + `structure.test.ts` —
      `structure/degenerate` (an artifact above a trivial size has headings and is not one undifferentiated
      block) and `structure/heading-skip` (no `h2` directly followed by `h4`). These stay ours despite the name
      overlap with `contextops/structure-imbalance`: they are properties of one document's headings, that is a
      property of how a bundle's cost is distributed. The suite asserts the two do not overlap, because a shared
      word would otherwise quietly merge them.
- [ ] T069 [P] [US4] Implement `tooling/prompt-lint/src/rules/contradiction.ts` + `contradiction.test.ts` —
      `content/self-contradiction`, bounded to mechanically decidable cases (FR-026): conflicting metadata
      values, an explicit rule and its literal negation. The does-not-fire half matters more than usual here: a
      test proving it stays silent on semantically-tense-but-not-contradictory prose is what keeps the rule out
      of the LLM-judged territory this feature excludes.
- [ ] T070 [US4] Extend `tooling/prompt-lint/src/config.ts` + `config.test.ts` with the `contextops` block
      (exact `version: '0.3.3'`, `model`, `profile: 'agent'`, `ratios`, `binOverride`) and `tokenBudgets`
      (per bundle and per artifact kind), plus the remaining FR-036 rows: a non-exact pin, a `ratios` value
      outside 0–1, `minScore > 0` with `--rules-only`, a `tokenBudgets.artifact` key for an unknown kind, a
      `tokenBudgets.bundle` key naming no constructible bundle. `minScore` stays `0` (inert) until T079.
- [ ] T071 [US4] Implement `tooling/prompt-lint/src/score/compose.ts` + `compose.test.ts` + `score/index.ts` —
      assemble the run-level `Scorecard` as the **token-weighted mean** of the per-bundle scores, stated as a mean
      in the output so it is not mistaken for a minimum. The score passes through **verbatim**: no re-weighting,
      no dropped dimension, no blending with correctness findings, which are reported beside it as findings
      (FR-048). A fixture test asserts every dimension penalty equals the recorded response's, so any
      transformation — even a rounding — fails.
- [ ] T072 [US4] Extend `tooling/prompt-lint/src/gate.ts` + `gate.test.ts` to run the delegated half after the
      rules: build bundles, invoke once per bundle, merge the findings into the same ordered stream, attach the
      scorecards, and compare `minScore`. Under `--rules-only` it skips the half entirely and lists all five
      delegated rules under `notEvaluated`. Exit `6` propagates from `contextops/` and is never downgraded to a
      threshold failure.
- [ ] T073 [US4] Implement `tooling/prompt-lint/src/report/json.ts` + `json.test.ts` — `schemaVersion: 1` and
      every field of [contracts/report.schema.md](./contracts/report.schema.md), with all nine invariants that
      document lists asserted as tests: nothing but the object on stdout, byte-identical across runs,
      human/JSON parity, `verdict` and exit code unable to disagree, `thresholds` serialised from the object the
      gate actually compared against, empty scope representable, a missing score **always** explained, the score
      passed through not computed, and `analyser.version` equal to the pin.
- [ ] T074 [US4] Extend `tooling/prompt-lint/src/report/human.ts` + `human.test.ts` with the score block — the
      mean, the four dimensions, the per-bundle scores, and the analyser's name, version, encoding and profile
      (a number whose engine is not identified cannot be compared with the last one). Absence is always stated,
      never merely absent: `context: not evaluated (--rules-only)` under that flag, and no score block at all for
      an empty artifact set (FR-030). A delegated finding is tagged with its bundle, because its location is a
      relationship rather than a line.
- [ ] T075 [US4] Extend `tooling/prompt-lint/src/cli.ts` + `cli.test.ts` with `--json`, `--rules-only`,
      `--bundle=<id>` and `--scope=<name>`, and the exit-`6` mapping. `--rules-only` is rejected outright when
      `minScore > 0` (exit `3`), names itself in the report header, and reports every delegated rule as not
      evaluated: a pull request whose gate ran with it is a pull request whose gate did not run.
- [ ] T076 [US4] Extend `tooling/prompt-lint/docs/rules.md` with the five `contextops/*` entries and the two
      `structure/*` and one `content/*` entries, then re-run the T045 cross-check. It must now report 25 rules
      across 11 families, 21 of them with a configurable severity.
- [ ] T077 [US4] Add the analyser to `.github/workflows/ci.yml` — a **separate preceding step** in the `main` job
      making `contextops==0.3.3` available (`astral-sh/setup-uv`, or `pipx install`) plus a cache for
      `TIKTOKEN_CACHE_DIR` keyed on the pin. Keeping it distinct is the point: when it fails, the log says the
      environment is wrong rather than implying the prompts are. Same GitHub App workflow-scope constraint as
      T046.
- [ ] T078 [P] [US4] Append the analyser prerequisite to the root `README.md` and
      `tooling/prompt-lint/README.md`: the four routes (`uv`/`uvx`, `pipx`, `pip`,
      `PROMPT_LINT_CONTEXTOPS_BIN`), the one-time `tiktoken` vocabulary fetch and `TIKTOKEN_CACHE_DIR`, that
      `prompt-lint` never installs it (FR-052), and that it is Sustainable-Use-licensed with the licence question
      still awaiting a human ([research.md](./research.md#r8)).
- [ ] T079 [US4] Run [quickstart.md](./quickstart.md#scenario-2--whole-repository-run-over-the-real-surface-us4-sc-002-sc-003)
      Scenario 2 to take the **first real measurement**, and
      [Scenario 3](./quickstart.md#scenario-3--deterministic-output-fr-029-fr-039-sc-005) for determinism. Record
      the per-bundle scores and `token_breakdown` in the pull request, then set `minScore` and the
      `tokenBudgets` from the numbers — the two open questions
      [research.md](./research.md#open-questions-deliberately-left-open) left open on purpose. Both stay inert
      until this task, and the value that lands is a reviewable edit to `src/config.ts` with the measurement
      quoted beside it. Also confirm `--rules-only` prints no score and explains what it skipped, and that
      `contextops stability` passes.

**Checkpoint**: All four stories work. The surface has a score, an agent can consume the report as data, and the
gate covers both halves.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T080 Audit SC-004 coverage across `tooling/prompt-lint/src/rules/*.test.ts`: every one of the 25 rules has
      a fires case **and** a does-not-fire case. The second is what keeps the gate from being ignored, so a
      missing one is a gap, not a stylistic omission. Report the count per rule.
- [ ] T081 [P] Measure SC-002 and record it: a diff-scoped run over fewer than 20 changed artifacts under 10s, a
      whole-repository run under 60s, `--rules-only` under 2s, and this repository's own rules accounting for
      under 2s of either. If the delegated half misses its budget, the lever is the bundle count, not the
      threshold.
- [ ] T082 [P] Run [quickstart.md](./quickstart.md#scenario-1--the-tool-runs-and-describes-itself-fr-006-fr-047)
      Scenario 1 — `--list-rules` shows 25 with id, ships-as severity, source and statement; both `--explain`
      forms answer, including for a delegated rule. A delegated rule that cannot describe itself is the exact
      blind spot FR-047 exists to close.
- [ ] T083 Run [quickstart.md](./quickstart.md#scenario-8--the-gates-it-must-not-break) Scenario 8 — the gates
      this feature must not break: `pnpm nx affected -t lint typecheck test --base=origin/main`,
      `pnpm knip:orphans`, `pnpm qlty:diff origin/main`, `pnpm format:check`, all with **no** `QLTY_*` or
      `PROMPT_LINT_*` override. Two specifics to check rather than assume: `knip:orphans` needs T007's
      `ignoreDependencies` entry, and if `qlty:diff` fails on duplication across the rule modules the fix is
      `defineRule` and the shared fixtures, not a threshold (Constitution IV).
- [ ] T084 Verify the suite is green **without** Python: `PROMPT_LINT_CONTEXTOPS_BIN=/nonexistent pnpm nx test prompt-lint`.
      The payload and mapping suites run from recorded fixtures and the one contract test skips with a message
      naming what it skipped. A suite that goes red without the dependency makes the dependency mandatory for
      contributors, which it is not.
- [ ] T085 [P] Confirm `tooling/prompt-lint/docs/rules.md` and
      [contracts/rules.md](./contracts/rules.md) still agree after implementation, and record in the plan's
      Complexity Tracking any rule whose shipped behaviour diverged from its catalogue entry. The catalogue is
      the contract; a divergence is a defect in one of the two, and Governance requires the discovering change to
      fix it.
- [ ] T086 Fix the live `refs/dangling-path` defect **in its own commit**:
      `tooling/skills/catalog/copywriting/references/natural-transitions.md:276` references a `seo-audit` skill
      that does not exist in this catalog. Correct or remove the reference, bump `version` in
      `tooling/skills/catalog/copywriting/skill.meta` (`install/version-bump` will require it), and re-run the
      installer so `.agents/skills/copywriting/` does not drift. Separate commit because entangling the
      validator's diff with its first findings is what
      [plan.md](./plan.md#files-changed-outside-the-new-project) deliberately avoids.
- [ ] T087 Fix the live `conventions/config-mismatch` defect **in its own commit**:
      `.agents/remote-workflow-instructions.md` hardcodes ticket prefix `URM` and repo
      `harrytwigg/universal-react-monorepo` while `.agents/skills.config` says `bluetel/bluetel-ai` with no
      ticket board. Prefer deleting the hardcoded values and pointing at the config — two sources of truth is the
      defect, and correcting one of them leaves the defect in place. Then remove its `baseline.json` entry and
      promote `conventions/config-mismatch` to `error` in `src/config.ts`.
- [ ] T088 Promote `skill/use-when-trigger` to `error` once the ten `speckit-*` descriptions have been rewritten
      in `tooling/skills/catalog/speckit-*/skill.meta`, draining those `baseline.json` entries. Its own change,
      per the adoption table; SC-003 and SC-011 are the end-state of that staging, not preconditions for merging
      the validator.
- [ ] T089 Reconcile the constitution deviation recorded in
      [plan.md](./plan.md#complexity-tracking): Principle V's `^(main|staging|feature/.+)$` branch rule has no
      provision for the `claude/*` branches `.github/workflows/claude.yml` creates, so every commit on an
      agent-run branch is rejected by `commit-msg` regardless of subject. That is a constitution amendment in its
      own dedicated pull request (Governance), not a change this feature may make — raise it and link it here.
- [ ] T090 Final pass: run [quickstart.md](./quickstart.md) top to bottom and record the verdict against its
      traceability table. Confirm SC-003 (zero error-severity findings once adoption is complete) and SC-011
      (every error-severity finding at adoption either fixed or reasoned-suppressed, with no rule disabled
      wholesale) hold as stated, or say precisely which entries remain and why.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies. T001 → T002–T005 (they configure the project T001 declares); T006 → T007
  (knip needs the dependency to exist); T009 gates the phase.
- **Foundational (Phase 2)**: Depends on Setup. **Blocks every user story.** Within it: T010 and T011 first
  (every module imports their types), then `artifact/` (T013–T018) and `scope/` (T019–T023) in parallel, then
  T024.
- **US1 (Phase 3)**: Depends on Phase 2 only.
- **US2 (Phase 4)**: Depends on Phase 3 — it wires US1's run into a gate, so `gate.ts`, `cli.ts` and
  `report/human.ts` must exist to be extended.
- **US3 (Phase 5)**: Depends on Phase 2; independent of Phase 4 except that T057 extends the catalogue file T044
  creates and T058 uses the baseline machinery T038 provides. Runnable in parallel with Phase 4 if T044 and T038
  land first.
- **US4 (Phase 6)**: Depends on Phase 2 for types and Phase 4 for the exit-code contract it extends with `6`.
  Independent of Phase 5. Gated additionally on T060, which is not code: the licence question is answered before
  the repository takes a dependency, not after.
- **Polish (Phase 7)**: Depends on all four stories. T086–T089 are each their own commit and are deliberately
  **not** part of this feature's diff.

### User Story Dependencies

- **US1 (P1)**: No dependency on another story. Ships alone as a usable product.
- **US2 (P2)**: Extends US1's modules rather than duplicating them. Cannot precede US1.
- **US3 (P3)**: Only the two shared files above tie it to US2. Its rules are independent.
- **US4 (P4)**: Additive. Its whole surface sits behind `src/contextops/` plus five rule declarations, which is
  what makes it removable and the dependency replaceable.

### Within each story

- A rule module and its colocated suite are one task and land together.
- Barrels come after the modules they export (T018, T023, T031, T033, T066).
- The catalogue entry for a rule lands in the same phase as the rule; T045's cross-check is what enforces it.
- A rule that has never been measured against this repository ships non-blocking and is promoted in its own
  reviewable change (T058, T087, T088) — adding a rule must not be the same act as breaking the build.

### Parallel Opportunities

- Phase 1: T002–T005 together; T007 and T008 together after T006.
- Phase 2: the whole of `artifact/` (T013–T017) and the whole of `scope/` (T019–T021) — nine tasks over nine
  files, none depending on another's output.
- Phase 3: T025–T028, the four independent rule modules.
- Phase 5: T051, T052 and T053 together; T054 alone (it is the only one needing `universe` and the git diff at
  once).
- Phase 6: T067–T069 together; the `contextops/` chain T061 → T062 → T063 → T064 → T065 is strictly sequential,
  because no link in it is useful alone.
- Phase 7: T081, T082 and T085 together.

---

## Parallel Example: User Story 1

```bash
# The four independent rule modules — different files, no shared state:
Task: "Implement src/rules/metadata.ts + metadata.test.ts (meta/*)"
Task: "Implement src/rules/references.ts + references.test.ts (refs/dangling-path)"
Task: "Implement src/rules/sections.ts + sections.test.ts (skill/section-missing)"
Task: "Implement src/rules/placeholders.ts + placeholders.test.ts (template/placeholder-residue)"

# Then, strictly after all four:
Task: "Implement src/rules/registry.ts + registry.test.ts"
```

## Parallel Example: Phase 2

```bash
# artifact/ and scope/ have no dependency on each other:
Task: "Implement src/artifact/load.ts + load.test.ts"
Task: "Implement src/artifact/markdown.ts + markdown.test.ts"
Task: "Implement src/artifact/meta.ts + meta.test.ts"
Task: "Implement src/artifact/frontmatter.ts + frontmatter.test.ts"
Task: "Implement src/scope/patterns.ts + patterns.test.ts"
Task: "Implement src/scope/classify.ts + classify.test.ts"
Task: "Implement src/scope/git.ts + git.test.ts"
```

---

## Implementation Strategy

### MVP first (US1 only)

1. Phase 1 — Setup (T001–T009)
2. Phase 2 — Foundational (T010–T024). **Blocks everything.**
3. Phase 3 — US1 (T025–T037)
4. **STOP and validate**: [quickstart.md](./quickstart.md) Scenario 4 in full
5. Ship it. A contributor gets correct findings on their own branch and nothing blocks anyone yet — which is the
   right first state for a gate whose surface is not currently clean.

### Incremental delivery

1. Setup + Foundational → the pipeline exists
2. - US1 → correct local findings (**MVP**)
3. - US2 → the gate blocks, thresholds are central, adoption is stageable
4. - US3 → the catalog cannot be published broken
5. - US4 → scores, `--json`, the delegated half

Each step leaves the repository green and adds value without changing what the previous step did.

### Parallel team strategy

Phases 1–2 are shared and sequential. After Phase 2, three tracks run concurrently: US1 → US2 on one (they share
`gate.ts`, `cli.ts` and `report/human.ts`, so one pair of hands), US3 on another (its own rule modules plus
`tooling/skills/project.json`), US4 on a third (entirely inside `src/contextops/`, `src/score/`,
`src/report/json.ts`). The three touch `gate.ts`, `config.ts` and `docs/rules.md` in common — sequence those three
files rather than merging them twice.

---

## Requirement coverage

Every functional requirement maps to at least one task. Requirements are the spec's; a task ID here is the place
the requirement becomes true.

| Requirement    | Tasks                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------- |
| FR-001, FR-002 | T019                                                                                     |
| FR-003         | T020, T025–T028                                                                          |
| FR-004         | T020, T029                                                                               |
| FR-005         | T022, T011                                                                               |
| FR-006         | T030, T042, T082                                                                         |
| FR-007         | T030, T032                                                                               |
| FR-008         | T010, T040                                                                               |
| FR-009         | T017, T029                                                                               |
| FR-010         | T017, T029, T038, T043                                                                   |
| FR-011         | T010, T030                                                                               |
| FR-012, FR-013 | T025                                                                                     |
| FR-014         | T053, T058, T088                                                                         |
| FR-015         | T026, T055                                                                               |
| FR-016         | T027                                                                                     |
| FR-017         | T028                                                                                     |
| FR-018         | T052                                                                                     |
| FR-019         | T054                                                                                     |
| FR-020         | T054, T055                                                                               |
| FR-021         | T051                                                                                     |
| FR-022         | T062, T065, T067                                                                         |
| FR-023         | T065, T067                                                                               |
| FR-024         | T065, T067, T070                                                                         |
| FR-025         | T065, T067, T068                                                                         |
| FR-026         | T069                                                                                     |
| FR-027, FR-028 | T071, T074                                                                               |
| FR-029         | T024, T062, T073                                                                         |
| FR-030         | T074, T073                                                                               |
| FR-031         | T021, T036                                                                               |
| FR-032         | T021, T041                                                                               |
| FR-033         | T041, T075                                                                               |
| FR-034         | T011, T040, T043                                                                         |
| FR-035         | T038, T039, T040, T058                                                                   |
| FR-036         | T011, T040, T070                                                                         |
| FR-037         | T032                                                                                     |
| FR-038         | T073, T075                                                                               |
| FR-039         | T032, T064, T073                                                                         |
| FR-040         | T032, T041                                                                               |
| FR-041         | T002, T006, T009, T056                                                                   |
| FR-042         | T046                                                                                     |
| FR-043         | T047, T050                                                                               |
| FR-044         | T056                                                                                     |
| FR-045         | deferred — [research.md](./research.md#r8); T078 records the reasoning, no task ships it |
| FR-046         | T064, T078, T084                                                                         |
| FR-047         | T044, T045, T057, T067, T076                                                             |
| FR-048         | T065, T071, T073                                                                         |
| FR-049         | T061–T066                                                                                |
| FR-050         | T061, T065, T070                                                                         |
| FR-051         | T061, T072                                                                               |
| FR-052         | T060, T061, T078                                                                         |
| FR-053         | T066, T072, T075                                                                         |

| Success criterion | Tasks                            |
| ----------------- | -------------------------------- |
| SC-001            | T025–T028, T051–T054, T080       |
| SC-002            | T081, T050                       |
| SC-003            | T086–T088, T090                  |
| SC-004            | every rule task, audited at T080 |
| SC-005            | T024, T073, T079                 |
| SC-006            | T030, T032, T037                 |
| SC-007            | T010, T030, T045                 |
| SC-008            | T041, T046, T050                 |
| SC-009            | T040, T043, T083                 |
| SC-010            | T045, T057, T076                 |
| SC-011            | T058, T086–T088, T090            |

---

## Notes

- `[P]` tasks touch different files and depend on nothing incomplete.
- A rule task is done when both halves of its SC-004 pair exist, not when the rule works.
- Commit after each task or logical group, with the `<branch-name>: ` subject prefix Constitution V requires.
- **Two tasks need a permission this repository's agent does not have**: T046 and T077 edit
  `.github/workflows/ci.yml`, which the GitHub App cannot modify. They need a human commit or a token with
  `workflows` scope.
- **Three tasks are deliberately outside this feature's diff**: T086 and T087 fix the two live defects the design
  found, and T089 raises the constitution amendment for agent-run branch names. Each is its own commit or pull
  request, for the reason [plan.md](./plan.md#files-changed-outside-the-new-project) gives: the validator's diff
  and its first findings must not arrive entangled.
- Four inconsistencies between the three artifacts were found while generating this list and corrected in the
  same change: the missing phase entry for `skill/use-when-trigger` (T053), the missing `cli.test.ts` (T036), the
  module count in the plan's Scale/Scope, and two counts in the rule catalogue. Two more need a human and are
  recorded rather than corrected: FR-045's `MUST` has no shipping task by design, and the `contextops` licence
  reading is an agent's (T060).
