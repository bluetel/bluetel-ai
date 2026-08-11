# Implementation Plan: Static prompt-quality validator for AI-authored artifacts

**Branch**: `claude/issue-15-20260811-1041` | **Date**: 2026-08-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-prompt-quality-validator/spec.md`

## Summary

Add `tooling/prompt-lint` — a new Nx library + CLI that lints this repository's AI-authored markdown the way
`tooling/qlty-diff` lints its code health: deterministic, offline, diff-scoped by default, thresholds in one
central file, blocking in CI.

The approach is deliberately **the qlty-diff shape, not a new one**: `config.ts` holding every threshold with
documented `PROMPT_LINT_*` overrides for local investigation only, a `gate.ts` that turns findings into one exit
code, a thin `cli.ts` run through `tsx`, a barrel `index.ts`, and colocated Vitest beside every module. A
contributor who has read one of these tools can read the other. Nothing new is introduced at the workspace level:
no new dependency, no new runtime, no new CI provider.

Three things make this more than a markdown linter, and they are where the design effort goes:

1. **Reference resolution that is right rather than loud.** A prototype scan of the naive rule ("every backticked
   path must exist") produced 40+ hits over the current tree, of which exactly one was a real defect. The
   resolution algorithm in [research.md](./research.md#r2) — resolve against the artifact directory, the skill
   root, then the repo root; only claim a path is dangling when it is _path-shaped_ and its first segment is a
   real directory in one of those roots — reduces that to the one true positive:
   `tooling/skills/catalog/copywriting/references/natural-transitions.md:276` points at "the seo-audit skill's
   `references/ai-writing-detection.md`", and there is no `seo-audit` skill in this catalog. That defect is live
   in the published catalog today and every project that installed `copywriting` has a copy of it.

2. **Cross-artifact rules the installer's model demands.** Catalog-to-installed drift, the version bump that
   makes an update visible to targets, `assets=`/`requires=`/`next_step=` referential integrity, and
   `.claude/` pointer agreement with `skill.meta`. These are not properties of a file; they are properties of the
   set, and no per-file linter can see them.

3. **Staged adoption, because the surface is not currently clean.** Measured now: 10 of 17 catalog descriptions
   lack the `Use when:` trigger clause (`speckit-*`, all of them), and `.agents/remote-workflow-instructions.md`
   tells the agent the ticket prefix is `URM` and the repo is `harrytwigg/universal-react-monorepo` while
   `.agents/skills.config` — the file the skills actually read — says `bluetel/bluetel-ai`. Turning both rules on
   as errors would fail every pull request in flight. The plan ships per-rule severity in the central config plus
   a draining `baseline.json`, so a rule can land non-blocking and be promoted in its own reviewable change.

Net shape: one new project, ~20 small modules each with a colocated suite, one new root script pair, one new CI
step, one new Nx target on `tooling/skills`, one rule-catalogue doc. No change to any existing behaviour.

## Technical Context

**Language/Version**: TypeScript 5.x, `strict`, ESM, `bundler` module resolution — inherited from
`tsconfig.base.json` and not relaxed. Node from `.nvmrc`. Executed via `tsx`, exactly as `qlty:diff` is.

**Primary Dependencies**: **None added.** `node:fs`, `node:path`, `node:process`, `node:child_process` (for
`git`), plus the workspace-internal `@bluetel-ai/eslint-config-internal` and `vitest` as devDependencies. No
YAML parser (the frontmatter in scope is a flat `key: value` block — see [research.md](./research.md#r4)), no
tokenizer (deterministic approximation — [research.md](./research.md#r5)), no markdown AST library
([research.md](./research.md#r3)).

**Storage**: None. Two checked-in data files: `src/config.ts` (thresholds) and `baseline.json` (known
pre-existing violations, drains over time). Nothing is written at runtime except the report on stdout.

**Testing**: Vitest, colocated per Principle III, one `<module>.test.ts` per module. Rule tests use in-memory
artifact fixtures rather than temp trees where the rule is pure; the discovery, git-scope and drift modules use
throwaway temp directories, following the pattern already established in `tooling/skills/lib/test-helpers.ts`.

**Target Platform**: Node on Linux and macOS — a developer machine via the pre-commit hook and the root script,
and `ubuntu-latest` in GitHub Actions. No browser, no bundling, nothing published to npm.

**Project Type**: Nx library + CLI under `tooling/`, private to the workspace. Mirrors `tooling/qlty-diff` in
every structural respect.

**Performance Goals**: SC-002 — under 5s for a diff-scoped run over fewer than 20 changed artifacts, under 30s
for the whole repository. The current artifact set is ~140 files totalling well under 1 MB; the only subprocess
is `git diff --name-only`. Headroom is large, so the design spends no effort on parallelism or caching.

**Constraints**: No network, no model calls (FR-046). Deterministic output — no timestamps, no absolute paths, no
`Date`, no unordered iteration surfacing in output (FR-029, FR-039). `qlty:diff` must pass with no threshold
override, which for a change of this shape means the **duplication** limit is the binding constraint: 15+ rule
modules with the same skeleton is exactly how a diff crosses 10% duplicated lines. Mitigated by a single
`defineRule` helper and shared assertion helpers in the tests rather than copy-paste per rule.

**Scale/Scope**: ~20 new source modules + ~20 colocated suites in one new project, ~6 files modified outside it
(root `package.json`, `knip.json`, `.github/workflows/ci.yml`, `.husky/pre-commit`, `tooling/skills/project.json`,
`cspell.json`). 23 rules across 10 families — 19 with a catalogue entry that can be promoted or demoted,
plus 4 self-describing bookkeeping rules. No existing module changes behaviour.

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

Evaluate each gate against `.specify/memory/constitution.md` (v1.0.0). Mark PASS, or FAIL with an
entry in Complexity Tracking below.

| Gate                             | Check                                                                                                                                                                     | Status |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| I. Nx-Orchestrated Workspace     | New projects land under `apps/`/`packages/`/`tooling/`, own their configs, and are run via `pnpm nx`                                                                      | PASS   |
| II. Modular Code, Barrel Exports | Public API exposed through `index.ts`; no monolithic files; extensionless imports                                                                                         | PASS   |
| III. Colocated Tests             | Every planned module has a colocated `<name>.test.ts` in the same directory                                                                                               | PASS   |
| IV. Blocking Quality Gates       | Design passes lint, Prettier, `strict` typecheck, and `qlty:diff` (0 medium+ issues, ≤10% duplication) without threshold overrides                                        | PASS   |
| V. Traceable, Spec-Driven Flow   | Work sits on `feature/<name>`; commits prefixed `BTAI-<n>: ` or `<branch>: `; this spec directory precedes implementation                                                 | PASS\* |
| Dependency Standards             | New deps added at the consuming workspace member; cross-cutting versions pinned in `pnpm-workspace.yaml` overrides; shared `tooling/` configs extended rather than forked | PASS   |

\* One deviation, recorded in [Complexity Tracking](#complexity-tracking): the branch is `claude/issue-15-…`, not
`feature/<name>`.

**Notes on the gates that required a judgement rather than an observation:**

- **I (Nx).** `tooling/prompt-lint` owns `project.json`, `tsconfig.json`, `vitest.config.ts` and
  `eslint.config.mjs`, and is runnable from its own directory (`pnpm exec tsx src/cli.ts --all`). Two root
  scripts (`prompt-lint`, `prompt-lint:diff`) mirror `qlty` / `qlty:diff` so the pre-commit hook and CI invoke it
  the same way the code-health gate is invoked. The catalog half additionally gets an Nx target on
  `tooling/skills` so `nx affected` picks it up when a skill changes — see
  [Integration](#integration-with-the-skills-installer-and-the-rest-of-the-ai-surface).
- **II (barrels).** Every subdirectory (`scope/`, `artifact/`, `rules/`, `score/`, `report/`) exposes an
  `index.ts`; cross-directory imports go through it. `src/index.ts` exports `runPromptLintGate` and the public
  types only. `src/cli.ts` is an executable, imports from `.` like `qlty-diff`'s does, and is deliberately not
  exported from the barrel — which has a knip consequence, noted under Constraints and handled in
  [Files changed outside the new project](#files-changed-outside-the-new-project).
- **III (colocated tests).** One rule per module means one suite per rule, and SC-004's "fires / does not fire"
  pair lands in the module's own file. The registry gets its own suite for the catalogue cross-check (FR-047,
  SC-010) — the test that makes an undocumented rule impossible.
- **IV (`qlty:diff`).** The duplication limit is the real risk here, not lint or security: a rule family written
  by copy-paste would breach 10% on its own. `defineRule` plus shared test helpers is a design constraint
  imposed by the gate, not a stylistic preference. No `QLTY_*` override is used.
- **Dependency Standards.** Zero new third-party dependencies is a design goal, not a coincidence — a linter
  that gates the repo's prompts should not be the thing that introduces a transitive supply-chain surface. The
  three places a dependency was the obvious answer (YAML, markdown AST, tokenizer) each got a decision entry in
  [research.md](./research.md) explaining what was written by hand instead and why the hand-written version is
  sufficient for the artifact kinds in scope.

## Project Structure

### Documentation (this feature)

```text
specs/005-prompt-quality-validator/
├── plan.md              # This file (/speckit-plan command output)
├── spec.md              # Feature specification
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
│   ├── cli.md           # command surface, flags, exit codes
│   ├── report.schema.md # machine-readable report schema
│   └── rules.md         # the rule catalogue (identifier, severity, rationale, fix)
├── checklists/
│   └── requirements.md  # Spec quality checklist (/speckit-specify output)
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
tooling/prompt-lint/                     # NEW Nx project, @bluetel-ai/prompt-lint
├── src/
│   ├── index.ts                         # barrel: runPromptLintGate + public types
│   ├── cli.ts                           # #!/usr/bin/env tsx — argv → gate → exit code
│   ├── config.ts                        # EVERY threshold + per-rule severity; PROMPT_LINT_* overrides
│   ├── config.test.ts                   #   incl. FR-036 contradictory-config rejection
│   ├── gate.ts                          # orchestrate scope → load → rules → score → report → exit code
│   ├── gate.test.ts
│   ├── baseline.ts                      # read baseline.json, downgrade known violations, detect stale entries
│   ├── baseline.test.ts
│   ├── scope/
│   │   ├── patterns.ts                  # the declared artifact locations (FR-001, FR-002) — one table
│   │   ├── patterns.test.ts
│   │   ├── classify.ts                  # path → ArtifactKind; unrecognised → finding, never silence (FR-004)
│   │   ├── classify.test.ts
│   │   ├── git.ts                        # changed-vs-base / staged / all; unresolvable ref → exit 4 (FR-032)
│   │   ├── git.test.ts
│   │   ├── resolve.ts                   # scope + exclusions → Scope; reports what it excluded (FR-005)
│   │   ├── resolve.test.ts
│   │   └── index.ts
│   ├── artifact/
│   │   ├── load.ts                      # read, UTF-8/symlink/empty handling, line index
│   │   ├── load.test.ts
│   │   ├── frontmatter.ts               # flat key: value block, no YAML dependency
│   │   ├── frontmatter.test.ts
│   │   ├── meta.ts                      # skill.meta key=value, repeatable keys, duplicate detection
│   │   ├── meta.test.ts
│   │   ├── markdown.ts                  # headings, fences, code spans, links, comments, path-shaped tokens
│   │   ├── markdown.test.ts
│   │   ├── size.ts                      # deterministic offline size approximation
│   │   ├── size.test.ts
│   │   ├── suppress.ts                  # reasoned inline suppressions + stale detection (FR-009, FR-010)
│   │   ├── suppress.test.ts
│   │   └── index.ts
│   ├── rules/
│   │   ├── define.ts                    # defineRule helper — the anti-duplication seam (Principle IV)
│   │   ├── define.test.ts
│   │   ├── registry.ts                  # all rules + the catalogue cross-check (FR-047, SC-010)
│   │   ├── registry.test.ts
│   │   ├── metadata.ts                  # meta/* — required fields, well-formedness, semver, duplicates
│   │   ├── metadata.test.ts
│   │   ├── trigger.ts                   # skill/use-when-trigger
│   │   ├── trigger.test.ts
│   │   ├── references.ts                # refs/dangling-path — the resolution algorithm of research R2
│   │   ├── references.test.ts
│   │   ├── sections.ts                  # skill/section-missing
│   │   ├── sections.test.ts
│   │   ├── placeholders.ts              # template/placeholder-residue (comment- and code-span-aware)
│   │   ├── placeholders.test.ts
│   │   ├── conventions.ts               # conventions/config-mismatch — vs .agents/skills.config
│   │   ├── conventions.test.ts
│   │   ├── install.ts                   # install/catalog-drift, install/version-bump, install/pointer-mismatch
│   │   ├── install.test.ts
│   │   ├── declared.ts                  # meta/declared-dependency-missing (requires=, assets=, next_step=)
│   │   ├── declared.test.ts
│   │   ├── redundancy.ts                # content/cross-artifact-duplication (shingle clustering)
│   │   ├── redundancy.test.ts
│   │   ├── density.ts                   # content/density
│   │   ├── density.test.ts
│   │   ├── budget.ts                    # content/size-budget
│   │   ├── budget.test.ts
│   │   ├── structure.ts                 # structure/degenerate
│   │   ├── structure.test.ts
│   │   ├── contradiction.ts             # content/self-contradiction (mechanically decidable only)
│   │   ├── contradiction.test.ts
│   │   └── index.ts
│   ├── score/
│   │   ├── score.ts                     # 4 dimensions → 0-100, per artifact and per run
│   │   ├── score.test.ts
│   │   └── index.ts
│   └── report/
│       ├── human.ts                     # verdict-first, severity-ordered, capped list
│       ├── human.test.ts
│       ├── json.ts                      # the documented machine-readable schema
│       ├── json.test.ts
│       ├── order.ts                     # the single deterministic ordering (FR-029, SC-005)
│       ├── order.test.ts
│       └── index.ts
├── docs/
│   └── rules.md                         # THE rule catalogue — cross-checked by registry.test.ts
├── baseline.json                        # known pre-existing violations at adoption; drains, never grows quietly
├── package.json                         # @bluetel-ai/prompt-lint, private, main → ./src/index.ts
├── project.json                         # typecheck + test targets (copy of qlty-diff's shape)
├── tsconfig.json                        # extends ../../tsconfig.base.json
├── vitest.config.ts
├── eslint.config.mjs                    # base + withTypeChecking, as every tooling project does
└── README.md                            # what it gates, how to run it, how to add a rule
```

**Structure Decision**: One new project under `tooling/`, structurally cloned from `tooling/qlty-diff` and
subdivided per Principle II into the five concerns the data model names — scope, artifact, rules, score, report.
The subdivision is not decoration: `scope/` is the only place that touches `git`, `artifact/` is the only place
that touches the filesystem, and `rules/` is therefore pure functions over already-loaded artifacts. That is what
lets all but the four set-scoped rules be tested from in-memory fixtures instead of temp trees, which is most of how SC-002's time budget
is met and all of how SC-005's determinism is guaranteed.

### Files changed outside the new project

| File                                | Change                                                                                                                                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                      | `@bluetel-ai/prompt-lint` in `devDependencies` (workspace); scripts `prompt-lint` (`tsx tooling/prompt-lint/src/cli.ts --all`) and `prompt-lint:diff` (`tsx tooling/prompt-lint/src/cli.ts`)                           |
| `knip.json`                         | `@bluetel-ai/prompt-lint` added to `ignoreDependencies`, exactly as `@bluetel-ai/qlty-diff` is — a root devDependency consumed only by a script is otherwise reported unused, and `knip:orphans` is a blocking CI step |
| `.github/workflows/ci.yml`          | one step in the `main` job: `pnpm prompt-lint:diff "origin/$BASE_REF"`; and `prompt-lint` appended to the `nx affected -t …` target list                                                                               |
| `.husky/pre-commit`                 | `pnpm prompt-lint:diff` after `pnpm typecheck`, before the qlty gate                                                                                                                                                   |
| `tooling/skills/project.json`       | a `prompt-lint` target scoping the validator to the catalog, so `nx affected` runs it whenever a skill changes                                                                                                         |
| `cspell.json`                       | any new identifiers the rule catalogue introduces (`shingle`, `frontmatter`) if not already accepted                                                                                                                   |
| `tooling/prompt-lint/baseline.json` | (new, inside the project) the measured adoption baseline — see [Adoption](#adoption-how-this-lands-without-breaking-every-open-pr)                                                                                     |

**Deliberately not changed**: `tooling/qlty-diff` (untouched — the two gates are independent), the skills
`catalog/` content (the real defects the prototype found are fixed in their own change, so the validator's diff
and its first findings do not arrive entangled), and `.agents/remote-workflow-instructions.md` (same reason —
and it is the file governing this run, so editing it here would be self-serving).

## Integration with the skills installer and the rest of the AI surface

The issue asked how this incorporates into the skills installer and the other AI code. There are four distinct
seams, and they are worth separating because they fail differently.

**1. The repo-wide gate (all AI code, blocking).** A root CI step, diff-scoped against the PR base, plus the
pre-commit hook. This is the seam that covers `AGENTS.md`, `CLAUDE.md`, `.claude/rules/*.md`, `.agents/*.md`,
`.specify/templates/*.md` and `.specify/memory/constitution.md` — none of which belong to any Nx project, so
`nx affected` structurally cannot see them. It is a separate step for the same reason `knip:orphans` is: the tool
is not Nx-aware and the condition is global. Cross-artifact rules (drift, redundancy) also need the whole set in
memory even when the diff is one file, which `affected` cannot express.

**2. The catalog publish gate (the installer's content).** `tooling/skills/project.json` gains a `prompt-lint`
target scoped to `catalog/`, so editing a skill makes `nx affected -t … prompt-lint` run the catalog rules
alongside the existing `pnpm nx test skills`. The division of labour is deliberate and stated in the spec's
Assumptions: **the shell tests own the installer's behaviour, `prompt-lint` owns the artifact's content.**
`skills.describe.test.ts` already asserts that a missing `description` is a catalog error — it does so by running
`skills.sh` and checking exit code 2, which is a test of the installer. Whether the description carries a
`Use when:` clause, whether `assets=` names a bundle that exists, whether the body's references resolve: those
are content, and they get a rule.

**3. Catalog-to-target integrity (the installer's model).** The installer's whole update story rests on a content
hash and a `version`: a target learns an update exists because `version` moved. Three rules exist purely to
protect that: `install/version-bump` (content changed in this diff, `version` did not), `install/catalog-drift`
(`.agents/skills/<name>/` no longer matches `catalog/<name>/`, excluding the data files the model intentionally
leaves per-project — `.skill`, `.agents/skills.config`, asset bundles), and `install/pointer-mismatch` (the
`.claude/skills/<name>/SKILL.md` frontmatter disagrees with `skill.meta`, or stops naming the shared
`.agents/skills/<name>/SKILL.md` file). All three are invisible to any single-file linter and to the shell tests,
because they compare two trees.

**4. Adoption by target projects — deferred, with the path recorded.** FR-045 requires that a project which
installs skills _can_ adopt the validator; the spec's Assumptions put the shipping work out of scope. Recording
why, so it is not re-litigated: the installer ships **no Node** to targets by design (see
`tooling/skills/README.md` — Claude driving `git`/`curl`/POSIX shell only), so `prompt-lint` cannot be an asset
bundle without either breaking that constraint or being rewritten in POSIX shell. The realistic path, when
someone wants it, is a catalog skill whose procedure runs the checks an agent can perform unaided, with the
TypeScript implementation staying here as the authority for this repo and any repo that has Node. Two rejected
alternatives and their reasons are in [research.md](./research.md#r8).

## Adoption: how this lands without breaking every open PR

Measured against the tree at `ee740a3`:

| Rule                                 | Existing violations                                                         | Ships as                                         | Promoted to `error` when                           |
| ------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------- |
| `refs/dangling-path`                 | 1 (`copywriting/references/natural-transitions.md:276` → `seo-audit` skill) | `error`                                          | immediately — fix the one defect in its own change |
| `skill/use-when-trigger`             | 10 (`speckit-*`, every one)                                                 | `warn`                                           | the ten descriptions have been rewritten           |
| `conventions/config-mismatch`        | 1 (`.agents/remote-workflow-instructions.md` — `URM`, wrong repo slug)      | `warn`                                           | that file is corrected                             |
| `install/catalog-drift`              | 0 (verified: every installed skill matches its catalog source)              | `error`                                          | immediately                                        |
| `content/cross-artifact-duplication` | not yet measured — needs the shingle implementation to quantify             | `warn`                                           | after the first measurement is reviewed            |
| everything else                      | 0 or unmeasured                                                             | `error` unless the first full run says otherwise | —                                                  |

Two mechanisms make that table expressible, and both are reviewable diffs rather than flags:

- **Per-rule severity in `src/config.ts`.** A rule can ship non-blocking and be promoted in a dedicated pull
  request. Because the severity lives in the same central file as the thresholds, promoting or demoting a rule is
  as visible as changing a threshold — which is what FR-034 and SC-009 require.
- **`baseline.json`.** Rule + path pairs known-violating at adoption, downgraded to `note`. A baseline entry that
  stops matching is reported **stale** (FR-010's mechanism, reused), so the file drains as the surface is fixed
  and cannot quietly become permanent. Adding an entry is a diff a reviewer sees.

Both are needed: severity handles "this rule is not ready to block anywhere", the baseline handles "this rule
blocks, except for these named pre-existing files".

## Phasing (delivery order, by user story)

Each phase is independently shippable and leaves the repository in a working state, matching the spec's story
priorities. `/speckit-tasks` expands these into the ordered task list.

| Phase | Story | Delivers                                                                                                                                                                                 | Done when                                                                                     |
| ----- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| A     | US1   | Project skeleton, `config.ts`, `scope/`, `artifact/`, `report/human.ts`, `rules/`: `meta/*`, `refs/dangling-path`, `skill/section-missing`, `template/placeholder-residue`; root scripts | A contributor runs `pnpm prompt-lint:diff` and gets correct findings on their own branch      |
| B     | US2   | `gate.ts` thresholds + exit-code contract, `baseline.ts`, per-rule severity, CI step, pre-commit hook, `docs/rules.md` + its cross-check                                                 | A PR with one error-severity defect fails CI; the same PR without it passes                   |
| C     | US3   | `install/*` rules, `meta/declared-dependency-missing`, `conventions/config-mismatch`, the `prompt-lint` target on `tooling/skills`                                                       | A broken catalog entry cannot be pushed green                                                 |
| D     | US4   | `score/`, `report/json.ts`, `content/cross-artifact-duplication`, `content/density`, `content/size-budget`, `structure/degenerate`, `content/self-contradiction`                         | `pnpm prompt-lint --json` emits the full schema; whole-repo score is reported with dimensions |

Phase A is the one that must be right; B–D are additive and each closes a story the spec ranked lower. Note that
the `minScore` threshold named in `config.ts` is **inert until Phase D** — the gate in Phase B decides on severity
counts alone. That is stated here rather than discovered later.

## Complexity Tracking

| Violation                                                                     | Why Needed                                                                                                                                                                                                                                                         | Simpler Alternative Rejected Because                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch is `claude/issue-15-20260811-1041`, not `feature/<name>` (Principle V) | The branch was created by `.github/workflows/claude.yml` before this run began, and `.agents/remote-workflow-instructions.md` instructs the run to work on the `claude/*` branch the action provides. Nothing in the run can choose otherwise.                     | Renaming or re-branching mid-run would orphan the action's push target and the comment it updates. The constitution's branch rule predates the GitHub Action workflow and does not yet name agent-run branches; reconciling the two is its own amendment. |
| A checked-in `baseline.json` of known violations                              | Ten `Use when:` violations and one stale-convention file exist today. Without a baseline the only options are "fail every open PR" or "do not ship the rule".                                                                                                      | Per-rule severity alone cannot express "blocks everywhere except these three known files", so a rule with one legacy violation would have to stay non-blocking for the whole repository. Stale-entry reporting is what stops the file becoming permanent. |
| 13 rule modules rather than a handful of grouped checks                       | Principle II (single clear responsibility) and SC-007 (a rule is added by one self-contained change touching no existing rule). Colocated tests then land one suite per rule, which is what makes SC-004's fires/does-not-fire pair natural rather than bolted on. | Grouping rules into 5 large modules would make each module a monolith that every new rule edits — the exact shape SC-007 exists to prevent — and would put unrelated rules' tests in one file.                                                            |

## Post-Design Constitution Re-check

Re-evaluated after Phase 1 ([data-model.md](./data-model.md), [contracts/](./contracts/),
[quickstart.md](./quickstart.md)). All six gates still PASS, with the one recorded deviation on Principle V.
Three things the design surfaced that the pre-Phase-0 check had not yet confirmed:

- **Principle II held under pressure.** The reference-resolution algorithm (research R2) wanted access to git, to
  the filesystem and to parsed markdown at once, which would have collapsed `scope/`, `artifact/` and `rules/`
  into one module. It is instead expressed as a pure function over an artifact plus a pre-built path index that
  `scope/` hands it — so `rules/` stayed pure and `references.test.ts` needs no temp tree.
- **Principle IV's duplication risk is now concrete, not speculative.** `defineRule` and the shared fixture
  builders are load-bearing for the gate, so they are Phase A work rather than a later cleanup.
- **Principle III is satisfiable for every module in the tree above** — checked module by module; no module in the
  planned layout lacks a colocated suite, and no suite exists without its module.
