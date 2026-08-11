# Implementation Plan: Fast Lint Feedback Without Losing Coverage

**Branch**: `005-oxlint-lint-performance` | **Date**: 2026-08-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-oxlint-lint-performance/spec.md`, Phase 0 research
from [research.md](./research.md)

## Summary

The pre-commit lint step costs **5.68 s for a single staged file**, and that cost is two things:
~3.2 s of fixed per-invocation overhead (Node boot, flat-config resolution, plugin loading,
TypeScript program construction) and ~2.5 s of rule work, 62 % of which is one rule
(`@cspell/spellchecker`). Neither is caused by the volume of code being checked, so neither is fixed
by tuning.

The approach is a **hybrid split of the 129 enabled rules by whether they need a TypeScript program**:

- **86 syntactic rules** move to **oxlint** — a single Rust binary, so the fixed overhead largely
  disappears. Rules oxlint has no native equivalent for (`import-x/order`, both `check-file` rules,
  `prefer-arrow-functions`, and the local `@bluetel-ai/enforce-safe-env`) run through oxlint's
  ESLint-v9-compatible **JS plugin API**, which is the mechanism the issue proposed.
- **42 rules stay on ESLint** — the 41 that declare `requiresTypeChecking`, plus
  `@nx/enforce-module-boundaries`, which needs the Nx project graph. This layer stops running per-file
  and becomes an Nx target only: cached, `affected`-scoped, and blocking.
- **`@cspell/spellchecker` stays exactly as it is** but joins the Nx-only layer, which removes 1555 ms
  from the staged path for zero new dependencies and zero coverage change.

oxlint cannot own the type-aware layer today: its type-aware mode requires TypeScript 7.0+ and this
workspace is on `~5.9.2`. Taking the split now delivers the P1 win without that upgrade, and when the
workspace does reach TS 7, the split collapses into `oxlint --type-aware` with no change to the rule
set.

The work is sequenced so that **every phase is independently landable and independently valuable**,
and so that the cheapest, highest-yield change (Phase 1: move cspell off the per-file path) ships
before any new dependency is introduced.

## Technical Context

**Language/Version**: TypeScript `~5.9.2` (workspace-wide, `strict`), Node from `.nvmrc`
(v24.15.0 on CI), ESM throughout

**Primary Dependencies**: Nx 22.6.1, ESLint 9.34.0, `typescript-eslint` ^8, pnpm 11.3.0,
husky 9.1.7, lint-staged 16.4.0, Prettier ^3.8.1, Vitest, qlty

**New dependencies (proposed)**: `oxlint` (dev, workspace root), `eslint-plugin-oxlint` (dev, in
`tooling/eslint-config-internal`), `@oxlint/migrate` (invoked via `npx`, not installed).
**Not** proposed: `oxlint-tsgolint` (needs TS 7), `cspell` CLI (see research §3.5)

**Storage**: N/A — tooling change

**Testing**: Vitest, colocated `*.test.ts`/`*.test.mjs`. The lint-rule-coverage guarantee gets its
own executable fixture suite (see "Coverage parity harness")

**Target Platform**: developer machines (macOS, Linux) and GitHub Actions `ubuntu-latest`

**Project Type**: Nx monorepo — pnpm workspaces under `apps/`, `packages/`, `tooling/`

**Performance Goals**: staged-file lint < 1 s (from 5.68 s); cold full lint ≤ 15 s (from 30.7 s);
staged-file peak RSS well under 780 MB so `--max-old-space-size=8192` can be dropped

**Constraints**: no rule relaxed (FR-005); no new violations on existing code (FR-013); hook and CI
must enforce the same set (FR-011); no TypeScript upgrade (spec: Out of Scope); new deps subject to
`pnpm-workspace.yaml` `minimumReleaseAge: 1 week`

**Scale/Scope**: 7 Nx projects, 42 tracked lintable files, 129 enabled lint rules. Fixed overhead
dominates at this size, so the design is judged per-file and by reduction ratio, not by totals

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

Evaluated against `.specify/memory/constitution.md` (v1.0.0).

| Gate                             | Check                                                                                                                                                                        | Status                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| I. Nx-Orchestrated Workspace     | New `oxlint-config` package lands under `tooling/`; both lint layers are Nx targets run via `pnpm nx run-many` / `affected`                                                  | **PASS** (see C1)         |
| II. Modular Code, Barrel Exports | Each oxlint JS plugin rule is its own module; the package's public API is an `index.mjs` barrel; imports stay extensionless                                                  | **PASS**                  |
| III. Colocated Tests             | Ported rule keeps its colocated `enforce-safe-env.test.mjs`; the coverage-parity harness ships with colocated tests                                                          | **PASS**                  |
| IV. Blocking Quality Gates       | Every gate stays blocking. Lint gets faster and stricter (closes the `enforce-module-boundaries` gap), never weaker                                                          | **PASS**                  |
| V. Traceable, Spec-Driven Flow   | This spec directory precedes implementation. Branch/commit shape deviates on the CI-authored branch                                                                          | **FAIL — recorded as C2** |
| Dependency Standards             | `oxlint` at the root (used by the root hook), `eslint-plugin-oxlint` in the consuming `tooling/` package; shared configs extended, not forked; `minimumReleaseAge` respected | **PASS** (see C3)         |

**Re-check after Phase 1 design**: unchanged. The design adds one `tooling/` package and two Nx
targets; it introduces no new project outside `apps/`/`packages/`/`tooling/`, no monolithic file, and
no threshold override. C1–C3 below are the only deviations, and none of them relaxes a gate.

## Architecture

### Rule ownership

| Owner                                    | Count | Rules                                                                                                                                                                                                                          |
| ---------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **oxlint — native**                      |   ~79 | ESLint core (47), syntactic `@typescript-eslint` (30), `import/no-duplicates`, plus `no-unused-vars` covering both `unused-imports` rules. Exact count confirmed by task T004                                                  |
| **oxlint — JS plugins**                  |    ~7 | `import-x/order`, `check-file/filename-naming-convention`, `check-file/folder-naming-convention`, `prefer-arrow-functions/prefer-arrow-functions`, `@bluetel-ai/enforce-safe-env`, and `react-compiler` if native parity fails |
| **ESLint — type-aware layer**            |    42 | the 41 `requiresTypeChecking` rules from `strictTypeChecked`, plus `@nx/enforce-module-boundaries`                                                                                                                             |
| **ESLint — type-aware layer (spelling)** |     1 | `@cspell/spellchecker`, config unchanged                                                                                                                                                                                       |

Anything task T004 finds oxlint does **not** implement stays in the ESLint layer. That direction of
fallback is always safe: it costs speed, never coverage.

### Nx targets

| Target       | Tool                    | Scope       | Cached | Invoked by                                           |
| ------------ | ----------------------- | ----------- | ------ | ---------------------------------------------------- |
| `lint`       | oxlint                  | per project | yes    | `pnpm lint` / `lint:check`, CI `nx affected`, agents |
| `lint-types` | ESLint (type-aware set) | per project | yes    | pre-commit via `nx affected`, CI `nx affected`       |

`@nx/eslint/plugin`'s inferred target is renamed from `lint` to `lint-types` in `nx.json`, and each of
the 7 `project.json` files gains an explicit `lint` target. Explicit per-project targets with a `cwd`
are already this repo's established pattern for `typecheck` and `test`, so this introduces no new
convention.

`nx.json` `namedInputs.sharedGlobals` gains the oxlint config paths, so a rule change invalidates the
`lint` cache (FR-015, gap G9). CI's `nx affected -t lint test typecheck design-lint` gains
`lint-types`.

### Pre-commit hook order

Ordered fail-fast — cheapest and most-likely-to-fire first:

| Step | Command                                                | Change                                                                                                |
| ---: | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
|    1 | `npx lint-staged` → `oxlint --fix`, `prettier --write` | ESLint replaced by oxlint in the staged path; the `node --max-old-space-size=8192` wrapper is dropped |
|    2 | Vitest for staged tests + colocated tests              | unchanged                                                                                             |
|    3 | `pnpm typecheck`                                       | unchanged                                                                                             |
|    4 | `pnpm nx affected -t lint-types`                       | **new** — the type-aware layer, Nx-cached and affected-scoped                                         |
|    5 | `pnpm qlty:diff`                                       | unchanged; still fails closed when `qlty` is absent                                                   |

Step 4 is what keeps FR-008 and FR-011 true: the type-aware rules stay blocking at commit time, they
just stop being paid per-file. It is also what closes the `@nx/enforce-module-boundaries` gap found in
research — running under Nx means the project graph exists, so the rule actually executes.

Step 1 must fail closed if `oxlint` is missing (FR-018), matching the existing `qlty` treatment.

### Auto-fix ownership (FR-017)

Exactly one tool fixes any given rule. oxlint owns fixes for the syntactic layer; the ESLint layer
runs **without `--fix`** (a `nx affected` pass must not rewrite files behind the contributor's back);
Prettier owns all formatting and runs last in the `lint-staged` chain. `eslint-config-prettier` stays
in the ESLint layer, and the oxlint config must not enable formatting-adjacent rules.

### De-duplication (FR-014 / SC-008)

`eslint-plugin-oxlint` is added to `tooling/eslint-config-internal` and applied **last** in the flat
config, after `prettierConfig`, to switch off every ESLint rule oxlint now owns. This is preferred
over hand-maintaining a disable list because it tracks oxlint's coverage as oxlint changes.

### Coverage parity harness (FR-006, SC-005, SC-006)

Two artifacts, because a table alone is not a check:

1. **`rule-inventory.md`** — the FR-006 audit artifact. One row per rule from the 129-rule
   `--print-config` extraction: rule, source plugin, severity, options, post-change owner, coverage
   status, notes. Generated from a script so it can be regenerated and diffed, not hand-typed.
2. **A fixture suite** — one small fixture per previously-enforced rule that violates it, asserted to
   still produce an error from whichever layer now owns it. This is what makes SC-006 executable
   rather than a claim. Fixtures live outside the linted source tree (so they don't fail the repo's own
   lint) and are driven from a colocated `*.test.ts`.

The harness is written **before** the config migration (Phase 2 precedes Phase 4), so it can prove the
migration rather than being retrofitted to agree with it.

## Project Structure

### Documentation (this feature)

```text
specs/005-oxlint-lint-performance/
├── spec.md              # Phase -1: requirements and success criteria
├── research.md          # Phase 0: oxlint compatibility findings, decision + rejected alternatives
├── plan.md              # This file
├── tasks.md             # The task breakdown (/speckit-tasks output)
├── rule-inventory.md    # Task T008/T039 output: the 129-rule ownership audit (FR-006)
├── measurements.md       # Task T001 onward: before/after evidence for every SC
└── oxlint-rules.txt     # Task T013 output: `oxlint --rules`, for the coverage diff
```

Contributor-facing usage is documented in `AGENTS.md` and `.claude/rules/` (task T042) rather than in a
`quickstart.md` here, so the commands live where contributors and agents already look.

### Source code (repository root)

```text
.oxlintrc.json                          # NEW  root oxlint config; extends the shared tooling config
nx.json                                 # EDIT eslint plugin targetName → lint-types; lint target default; sharedGlobals
package.json                            # EDIT lint-staged command; oxlint devDependency; lint scripts
.husky/pre-commit                       # EDIT oxlint in lint-staged; new `nx affected -t lint-types` step

tooling/
├── oxlint-config/                      # NEW  shared oxlint config + JS plugins
│   ├── package.json                    #      @bluetel-ai/oxlint-config
│   ├── project.json
│   ├── oxlintrc.base.json              #      the shared rule set
│   ├── index.mjs                       #      barrel: re-exports the JS plugins
│   ├── plugins/
│   │   ├── index.mjs                   #      barrel
│   │   ├── enforce-safe-env.mjs        #      ported from eslint-config-base/rules/
│   │   ├── enforce-safe-env.test.mjs   #      moved with it, colocated
│   │   └── ...                         #      one module per rule needing the JS plugin API
│   └── vitest.config.ts
├── eslint-config-internal/
│   ├── index.mjs                       # EDIT reduced to the type-aware layer + cspell + nx boundaries
│   │                                   #      + eslint-plugin-oxlint applied last
│   └── package.json                    # EDIT drop plugins that moved to oxlint; add eslint-plugin-oxlint
└── eslint-config-base/
    ├── index.mjs                       # EDIT enforce-safe-env moves out to oxlint-config
    └── rules/                          # REMOVED once ported (rule + test move together)

packages/env-validation-errors/project.json   # EDIT explicit `lint` target (×7 projects)
tooling/*/project.json                        # EDIT explicit `lint` target
```

**Structure Decision**: A new `tooling/oxlint-config` workspace member holds the shared oxlint rule
set and the JS plugins, mirroring how `tooling/eslint-config-internal` and
`tooling/eslint-config-base` already work. This keeps Constitution principle I (own config, runnable in
isolation) and the "shared configuration" standard: a rule that should apply everywhere is defined
once in `tooling/` and extended, never forked into a project.

The existing two-package ESLint split (`internal` for tooling packages, `base` adding
`enforce-safe-env` for application packages) becomes unnecessary for that rule once it moves to
oxlint, since the oxlint config is workspace-wide. **Whether to collapse `eslint-config-base` into
`eslint-config-internal` is deliberately left out of this feature** — it is a separate simplification
with its own blast radius, and folding it in here would make the migration diff harder to review.

## Phasing

Each phase is independently landable, independently verifiable, and ordered so risk arrives late.

| Phase | Goal                                                                                                                                                                                            | Delivers                                                                         | Stories            |
| ----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------ |
| **1** | Take the free win. Move `@cspell/spellchecker` out of the per-file path into the Nx-cached layer. No new dependency.                                                                            | ~1.5 s off the staged path; proves the two-layer idea before adopting a new tool | US1                |
| **2** | Build the safety net _first_: generate `rule-inventory.md` from `--print-config`, write the fixture suite covering all 129 rules against the **current** setup, and confirm it passes today.    | The parity harness that makes every later phase falsifiable                      | US2                |
| **3** | Resolve research gaps G1–G5 with a throwaway spike: `oxlint --rules` diff, JS plugin loading, unused-import fix parity, react-compiler parity, JS plugin cost. Record answers in `research.md`. | Go/no-go per rule, with measurements                                             | US2                |
| **4** | Split the layers for real: `tooling/oxlint-config`, port `enforce-safe-env`, seed `.oxlintrc.json` via `@oxlint/migrate`, rename the Nx targets, add `eslint-plugin-oxlint`, rewrite the hook.  | The migration; harness from Phase 2 must stay green                              | US1, US2, US3, US5 |
| **5** | Re-measure against every SC, drop `--max-old-space-size`, update `AGENTS.md` / `.claude/rules/`, record final numbers.                                                                          | Evidence the SCs are met, and the docs to use it                                 | US1, US3, US4      |

If Phase 3 finds oxlint cannot carry enough of the rule set to reach SC-001, **Phase 1 still stands on
its own** and Phase 4 is abandoned rather than forced. That is the intended failure mode.

## Complexity Tracking

| Violation                                                                                                                                      | Why Needed                                                                                                                                                                                                                                                                             | Simpler Alternative Rejected Because                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1** — `lint-staged` invokes `oxlint` directly, not through Nx, which principle I says all task execution must go through                    | The staged-file pass operates on the git index, not on a project. Nx has no node for "the files you just staged", and routing through Nx would add back the process overhead this feature exists to remove. Pre-existing: `lint-staged` already calls `eslint` directly today          | Running `nx affected -t lint` in place of `lint-staged` cannot auto-fix-and-re-stage individual files, and re-lints whole projects for a one-line change. The Nx-orchestrated path is preserved in parallel: the same rules run as the `lint` target in CI and via `run-many`, so the graph-aware execution the principle protects still exists                                                                                                               |
| **C2** — Branch is `claude/issue-24-…`, not `feature/<name>`; commit subject cannot match the `<branch>: ` form the `commit-msg` hook requires | The branch is created by the CI action (`.github/workflows/claude.yml`) before any repo convention is consulted. `tooling/commit-conventions/src/validate.ts` accepts only `main`, `staging`, `feature/*`, so the hook rejects any commit on this branch and `--no-verify` is required | Renaming the branch mid-run would orphan the action's push target. Recorded here and in the PR body with the hook output, per `.agents/remote-workflow-instructions.md` §implement/4. Worth a follow-up: either widen `BRANCH_PATTERN` to admit `claude/*`, or have the workflow create `feature/*` branches                                                                                                                                                  |
| **C3** — Three new devDependencies for a change whose headline goal is _less_ tooling                                                          | `oxlint` is the fast linter itself; `eslint-plugin-oxlint` is what prevents duplicate diagnostics (FR-014) without a hand-maintained disable list; `@oxlint/migrate` is invoked via `npx` and never installed                                                                          | Hand-writing `.oxlintrc.json` from the 129-rule inventory risks silent divergence — exactly the FR-005 failure being guarded against. Hand-maintaining the ESLint disable list goes stale the first time oxlint adds a rule. Net dependency count still falls: `@cspell/eslint-plugin`, `eslint-plugin-check-file`, `eslint-plugin-import-x`, `eslint-plugin-prefer-arrow-functions` and `eslint-plugin-unused-imports` either move behind oxlint or drop out |

## Risks

| Risk                                                                                                  | Likelihood | Impact                                                           | Mitigation                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| oxlint's JS plugin API is **alpha**; a plugin misbehaves subtly                                       | Medium     | High — a rule that reports nothing looks identical to clean code | The Phase 2 fixture suite is exactly this detector: every rule must still fire on a planted violation. Never trust a green run as proof a rule is active                                |
| oxlint rule semantics differ from the ESLint original despite the same name                           | Medium     | Medium                                                           | Compare diagnostics on the repo before/after in Phase 3, not just exit codes. Any divergence → rule stays with ESLint                                                                   |
| JS plugins erase the speed advantage (gap G5)                                                         | Medium     | Medium                                                           | Measure with 0 and with all JS plugins. If SC-001 fails, move the most expensive plugin's rules back to the ESLint layer and re-measure                                                 |
| `nx affected -t lint-types` in pre-commit is slower than the ESLint call it replaced, on a cold cache | Low–Medium | Medium                                                           | Cold full is 30.7 s but `affected` scopes it and Nx Cloud caching applies. Measure a cold single-project change in Phase 5; if it regresses SC-002, scope step 4 to the staged projects |
| Nx caches a `lint` result across an oxlint config change                                              | Low        | High — a rule change appears to do nothing                       | Gap G9: add the oxlint config paths to `sharedGlobals` and verify a deliberate severity change produces a cache miss                                                                    |
| oxlint pinned version churn breaks CI                                                                 | Low        | Medium                                                           | Pin exactly (no `^`), honour `minimumReleaseAge: 1 week`, and let Renovate/manual bumps be reviewed like any dependency                                                                 |
| Contributors keep muscle-memory `pnpm lint` and get the wrong layer                                   | Medium     | Low                                                              | `pnpm lint` keeps meaning "lint everything"; document both targets in `AGENTS.md` (FR-020)                                                                                              |

## Success Verification

How each spec success criterion gets checked, and by which task:

| SC     | Verification                                                                             | Task            |
| ------ | ---------------------------------------------------------------------------------------- | --------------- |
| SC-001 | `/usr/bin/time` the staged-lint command on one file, same method as baseline             | T017, T036      |
| SC-002 | Time the full pre-commit hook on an identical one-file staged diff, before and after     | T001, T037      |
| SC-003 | `time pnpm lint:check --skip-nx-cache` plus the `lint-types` equivalent                  | T038            |
| SC-004 | Peak RSS from the same `/usr/bin/time -f %M` run; confirm `--max-old-space-size` removal | T032, T036      |
| SC-005 | `rule-inventory.md` row count = 129, every row has an owner, no unsigned-off drops       | T008, T039      |
| SC-006 | The fixture suite passes: every rule fires on its planted violation                      | T009–T012, T040 |
| SC-007 | `git diff` review: zero new suppressions in pre-existing files; full lint exits zero     | T041            |
| SC-008 | Full run of both layers over the workspace; assert no diagnostic appears twice           | T027            |
| SC-009 | The commit lands with every gate green (C2 aside, which is environmental)                | T044            |
