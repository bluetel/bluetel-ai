# Implementation Plan: Fast Lint Feedback Without Losing Coverage

**Branch**: `005-oxlint-lint-performance` | **Date**: 2026-08-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-oxlint-lint-performance/spec.md`, Phase 0 research
from [research.md](./research.md)

**Revision, 2026-08-11**: scope expanded to include the TypeScript upgrade, per
[PR #27](https://github.com/bluetel/bluetel-ai/pull/27) review feedback. That work produced
`research.md` §7, which **retracts** the "oxlint cannot own type-aware rules" finding this plan was
originally built on. The architecture below is the revised one: oxlint owns 127 of the 129 rules,
ESLint keeps 2, and TypeScript 7 lands as its own phase afterwards. §7.6 records why that order is
forced rather than preferred.

## Summary

The pre-commit lint step costs **5.68 s for a single staged file**, and that cost is two things:
~3.2 s of fixed per-invocation overhead (Node boot, flat-config resolution, plugin loading,
TypeScript program construction) and ~2.5 s of rule work, 62 % of which is one rule
(`@cspell/spellchecker`). `pnpm typecheck` on the same hook adds 5.1 s of `tsc` time. None of it is
caused by the volume of code being checked, so none of it is fixed by tuning.

The approach is to **move all 127 per-file rules to oxlint** — including the type-aware ones — and then
upgrade the compiler:

- **86 syntactic rules** move to **oxlint** native rules. Rules with no native equivalent
  (`import-x/order`, both `check-file` rules, `prefer-arrow-functions`, and the local
  `@bluetel-ai/enforce-safe-env`) run through oxlint's ESLint-v9-compatible **JS plugin API**, which is
  the mechanism the issue proposed.
- **41 type-aware rules also move to oxlint**, via `--type-aware` / `oxlint-tsgolint`. This is the
  revision: tsgolint embeds its own typechecker and works on this workspace today at TypeScript 5.9.2 —
  verified, including in a project with no `typescript` package installed at all. All 41 rules are on
  its implemented list, and it hard-fails on an unknown rule name, so a config that parses is a config
  where every rule is live. Measured: **0.21 s for one file including type-aware analysis**, against
  ESLint's 5.68 s.
- **2 rules stay on ESLint** — `@nx/enforce-module-boundaries`, which needs the Nx project graph, and
  `@cspell/spellchecker`, which has no oxlint equivalent and costs 1555 ms. Both become an Nx-only
  target: cached, `affected`-scoped, blocking, and never per-file.
- **TypeScript 7.0.2 lands last**, taking per-project `tsc` from 5.09 s to 0.87 s and aligning the
  compiler's semantics with the TypeScript 7 semantics tsgolint already applies.

The order is not a preference. TypeScript 7 ships **no JavaScript compiler API**, and typescript-eslint's
TS 7 support is closed as _not planned_ — so an ESLint-owned type-aware layer and TypeScript 7 are
mutually exclusive. Migrating those rules to oxlint first is what makes the upgrade a version bump;
doing the upgrade first would drop 41 rules on the day it lands.

The work is sequenced so that **every phase is independently landable and independently valuable**,
and so that the cheapest, highest-yield changes (Phase 0: one tsconfig line; Phase 1: move cspell off
the per-file path) ship before any new dependency is introduced.

## Technical Context

**Language/Version**: TypeScript `~5.9.2` today (`strict`), **target 7.0.2**; Node from `.nvmrc`
(v24.15.0 on CI), ESM throughout. Note `@nx/eslint` hard-depends on `typescript ~5.9.2`, so 5.9.2 stays
in the tree regardless (plan **C4**)

**Primary Dependencies**: Nx 22.6.1, ESLint 9.34.0, `typescript-eslint` ^8, pnpm 11.3.0,
husky 9.1.7, lint-staged 16.4.0, Prettier ^3.8.1, Vitest, qlty

**New dependencies (proposed)**: `oxlint` 1.78.0 (dev, workspace root), **`oxlint-tsgolint` 7.0.2001**
(dev, workspace root — the type-aware checker), `eslint-plugin-oxlint` (dev, in
`tooling/eslint-config-internal`), `@oxlint/migrate` (invoked via `npx`, not installed).
**Not** proposed: `cspell` CLI (see research §3.5)

**Dependencies removed**: `typescript-eslint` and its plugins leave the lint path entirely once oxlint
owns all 127 per-file rules — which is also what unblocks the TypeScript bump (research §7.2)

**Storage**: N/A — tooling change

**Testing**: Vitest, colocated `*.test.ts`/`*.test.mjs`. The lint-rule-coverage guarantee gets its
own executable fixture suite (see "Coverage parity harness")

**Target Platform**: developer machines (macOS, Linux) and GitHub Actions `ubuntu-latest`

**Project Type**: Nx monorepo — pnpm workspaces under `apps/`, `packages/`, `tooling/`

**Performance Goals**: staged-file lint < 1 s (from 5.68 s; measured 0.21 s with type-aware rules on);
cold full lint ≤ 15 s (from 30.7 s); staged-file peak RSS well under 780 MB so
`--max-old-space-size=8192` can be dropped; cold `tsc` down ≥ 50 % (measured 5.09 s → 0.87 s)

**Constraints**: no rule relaxed (FR-005); no new violations on existing code (FR-013); hook and CI
must enforce the same set (FR-011); the type-aware rule owner must not need the TypeScript compiler API
(FR-021) and must migrate **before** the version bump (FR-022); new deps subject to
`pnpm-workspace.yaml` `minimumReleaseAge: 1 week` — TypeScript 7.0.2 (2026-07-08), oxlint 1.78.0 and
`oxlint-tsgolint` 7.0.2001 (2026-07-21) all clear it

**Scale/Scope**: 7 Nx projects, 42 tracked lintable files, 129 enabled lint rules. Fixed overhead
dominates at this size, so the design is judged per-file and by reduction ratio, not by totals

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

Evaluated against `.specify/memory/constitution.md` (v1.0.0).

| Gate                             | Check                                                                                                                                                                                              | Status                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| I. Nx-Orchestrated Workspace     | New `oxlint-config` package lands under `tooling/`; both lint layers are Nx targets run via `pnpm nx run-many` / `affected`                                                                        | **PASS** (see C1)         |
| IV. Blocking Quality Gates (TS)  | The TypeScript bump keeps `pnpm typecheck` blocking and makes it ~6× cheaper; no `tsconfig` option relaxed (FR-023)                                                                                | **PASS**                  |
| II. Modular Code, Barrel Exports | Each oxlint JS plugin rule is its own module; the package's public API is an `index.mjs` barrel; imports stay extensionless                                                                        | **PASS**                  |
| III. Colocated Tests             | Ported rule keeps its colocated `enforce-safe-env.test.mjs`; the coverage-parity harness ships with colocated tests                                                                                | **PASS**                  |
| IV. Blocking Quality Gates       | Every gate stays blocking. Lint gets faster and stricter (closes the `enforce-module-boundaries` gap), never weaker                                                                                | **PASS**                  |
| V. Traceable, Spec-Driven Flow   | This spec directory precedes implementation. Branch/commit shape deviates on the CI-authored branch                                                                                                | **FAIL — recorded as C2** |
| Dependency Standards             | `oxlint` and `oxlint-tsgolint` at the root (used by the root hook), `eslint-plugin-oxlint` in the consuming `tooling/` package; shared configs extended, not forked; `minimumReleaseAge` respected | **PASS** (see C3, C4)     |

**Re-check after the 2026-08-11 scope expansion**: still passing. The revised design adds one `tooling/`
package and two Nx targets, and the TypeScript phase changes only version pins and `tsconfig.base.json`.
It introduces no new project outside `apps/`/`packages/`/`tooling/`, no monolithic file, and no threshold
override. C1–C4 below are the only deviations, and none of them relaxes a gate. Note the revision makes
principle IV **more** satisfiable than the original plan did: type-aware rules now run per-file at commit
time rather than only via `nx affected`.

## Architecture

### Rule ownership

| Owner                                       | Count | Rules                                                                                                                                                                                                                          |
| ------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **oxlint — native**                         |   ~79 | ESLint core (47), syntactic `@typescript-eslint` (30), `import/no-duplicates`, plus `no-unused-vars` covering both `unused-imports` rules. Exact count confirmed by task T013                                                  |
| **oxlint — JS plugins**                     |    ~7 | `import-x/order`, `check-file/filename-naming-convention`, `check-file/folder-naming-convention`, `prefer-arrow-functions/prefer-arrow-functions`, `@bluetel-ai/enforce-safe-env`, and `react-compiler` if native parity fails |
| **oxlint — type-aware (`oxlint-tsgolint`)** |    41 | Every `requiresTypeChecking` rule from `strictTypeChecked`. All 41 confirmed present on tsgolint's implemented-rules list (research §7.3)                                                                                      |
| **ESLint — workspace-scoped**               |     2 | `@nx/enforce-module-boundaries` (needs the Nx project graph) and `@cspell/spellchecker` (no oxlint equivalent, 1555 ms)                                                                                                        |

Anything task T013 finds oxlint does **not** implement stays in the ESLint layer. That direction of
fallback is always safe: it costs speed, never coverage. The one thing that must not happen is a rule
staying with ESLint _and_ needing type information — that combination is what FR-021 prohibits, because
it re-couples the lint gate to the TypeScript compiler API and re-blocks the upgrade.

### Nx targets

| Target           | Tool                                     | Scope       | Cached | Invoked by                                           |
| ---------------- | ---------------------------------------- | ----------- | ------ | ---------------------------------------------------- |
| `lint`           | oxlint, **including `--type-aware`**     | per project | yes    | `pnpm lint` / `lint:check`, CI `nx affected`, agents |
| `lint-workspace` | ESLint (2 rules: nx boundaries + cspell) | per project | yes    | pre-commit via `nx affected`, CI `nx affected`       |

`@nx/eslint/plugin`'s inferred target is renamed from `lint` to `lint-workspace` in `nx.json`, and each
of the 7 `project.json` files gains an explicit `lint` target. Explicit per-project targets with a `cwd`
are already this repo's established pattern for `typecheck` and `test`, so this introduces no new
convention.

The name is `lint-workspace`, not the `lint-types` of the original plan, and deliberately so: after the
revision that target has nothing to do with types. Calling it `lint-types` would misdescribe it and
invite someone to put a type-aware rule back into it, which FR-021 forbids.

`nx.json` `namedInputs.sharedGlobals` gains the oxlint config paths, so a rule change invalidates the
`lint` cache (FR-015, gap G9). CI's `nx affected -t lint test typecheck design-lint` gains
`lint-workspace`.

### Pre-commit hook order

Ordered fail-fast — cheapest and most-likely-to-fire first:

| Step | Command                                                             | Change                                                                                                                                                   |
| ---: | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
|    1 | `npx lint-staged` → `oxlint --type-aware --fix`, `prettier --write` | ESLint replaced by oxlint in the staged path; the `node --max-old-space-size=8192` wrapper is dropped. Measured 0.21 s for one file, type-aware included |
|    2 | Vitest for staged tests + colocated tests                           | unchanged                                                                                                                                                |
|    3 | `pnpm typecheck`                                                    | unchanged in shape; ~6× faster after the TypeScript 7 phase                                                                                              |
|    4 | `pnpm nx affected -t lint-workspace`                                | **new** — the 2-rule ESLint layer, Nx-cached and affected-scoped                                                                                         |
|    5 | `pnpm qlty:diff`                                                    | unchanged; still fails closed when `qlty` is absent                                                                                                      |

Type-aware rules stay blocking at commit time (FR-008) and stay in step 1 rather than being relegated to
step 4 — the whole point of the revision is that they are affordable per-file. Step 4 exists only for the
two rules that need the Nx project graph or have no oxlint equivalent, and it is also what closes the
`@nx/enforce-module-boundaries` gap found in research §1: running under Nx means the project graph
exists, so the rule actually executes.

Step 1 must fail closed if `oxlint` or `oxlint-tsgolint` is missing (FR-018), matching the existing
`qlty` treatment. This matters more than it did before: **without tsgolint resolvable, `--type-aware`
errors out rather than silently skipping** (`Failed to find tsgolint executable`, verified), which is the
behaviour we want — but the hook must still treat it as a failure and not swallow it.

### Auto-fix ownership (FR-017)

Exactly one tool fixes any given rule. oxlint owns fixes for everything it owns; the ESLint layer runs
**without `--fix`** (a `nx affected` pass must not rewrite files behind the contributor's back); Prettier
owns all formatting and runs last in the `lint-staged` chain. `eslint-config-prettier` stays in the
ESLint layer, and the oxlint config must not enable formatting-adjacent rules.

Type-aware fixes need explicit care: several of the 41 rules are auto-fixable in typescript-eslint. The
migration must not silently gain or lose fixability — task T048 records the fix status of all 41 rules
before and after, because a rule that reports but no longer fixes changes US1 acceptance scenario 2.

### De-duplication (FR-014 / SC-008)

`eslint-plugin-oxlint` is added to `tooling/eslint-config-internal` and applied **last** in the flat
config, after `prettierConfig`. With the ESLint layer reduced to 2 rules this is close to belt-and-braces
— which is the point: it is what stops a future ESLint config addition from silently duplicating a rule
oxlint already owns.

### TypeScript version strategy

| Rung     | Version     | Why it exists                                                                                                                                                                                               |
| -------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Today    | `~5.9.2`    | Current state. typescript-eslint supports it; tsgolint applies TS 7 semantics to it, i.e. a recorded mismatch (research §7.5)                                                                               |
| Fallback | `6.0.3`     | Last release with the JS compiler API, and inside typescript-eslint's `<6.1.0` peer range. Reachable with no lint change at all — the safe landing spot if TypeScript 7 blocks on a workspace tool (FR-026) |
| Target   | **`7.0.2`** | Go port. `tsc` 5.09 s → 0.87 s, 287 MB → 95 MB. No JS compiler API, so it requires the lint migration to have landed first                                                                                  |

Two prerequisites, both established by measurement:

1. **`"types": ["node"]`.** TypeScript 7 does not auto-discover `@types/node` from the hoisted root in
   this layout; without it there are 16 `TS2591` errors, and ~108 knock-on type-aware lint diagnostics
   from `process` resolving to an `error` type. TypeScript 5.9.2 also passes with the option set, so this
   lands in **Phase 0**, ahead of everything else, and is independently revertible. Gap **G14** covers
   whether it belongs in `tsconfig.base.json` or per project.
2. **The lint migration.** FR-022. Non-negotiable ordering, for the reason in research §7.6.

The upgrade's blast radius is every tool that reads TypeScript, not just `tsc` (FR-025) — Nx's
`@nx/js/typescript` inference plugin, `knip`, Vitest, and `qlty`. `@nx/eslint`'s hard `typescript ~5.9.2`
dependency means the tree will hold two copies; which one `tsc` resolves must be pinned deliberately
(FR-024, plan **C4**, gap **G13**).

## Project Structure

### Documentation (this feature)

```text
specs/005-oxlint-lint-performance/
├── spec.md              # Phase -1: requirements and success criteria
├── research.md          # Phase 0: oxlint compatibility findings, decision + rejected alternatives
├── plan.md              # This file
├── tasks.md             # The task breakdown (/speckit-tasks output)
├── rule-inventory.md    # Task T008/T039 output: the 129-rule ownership audit (FR-006)
├── typescript-upgrade.md # Task T050 output: per-tool TS 7 compatibility evidence (FR-025)
├── measurements.md       # Task T001 onward: before/after evidence for every SC
└── oxlint-rules.txt     # Task T013 output: `oxlint --rules`, for the coverage diff
```

Contributor-facing usage is documented in `AGENTS.md` and `.claude/rules/` (task T042) rather than in a
`quickstart.md` here, so the commands live where contributors and agents already look.

### Source code (repository root)

```text
.oxlintrc.json                          # NEW  root oxlint config; extends the shared tooling config
tsconfig.base.json                      # EDIT Phase 0: "types": ["node"]; Phase 6: any TS 7 fallout
nx.json                                 # EDIT eslint plugin targetName → lint-workspace; lint target default; sharedGlobals
package.json                            # EDIT lint-staged command; oxlint devDependency; lint scripts
.husky/pre-commit                       # EDIT oxlint in lint-staged; new `nx affected -t lint-workspace` step

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
│   ├── index.mjs                       # EDIT reduced to 2 rules: nx boundaries + cspell
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

| Phase | Goal                                                                                                                                                                                                                                                   | Delivers                                                                                                 | Stories            |
| ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------ |
| **0** | One line: `"types": ["node"]` in `tsconfig.base.json`. Passes on 5.9.2 today; prerequisite for TypeScript 7 and for a quiet type-aware lint run.                                                                                                       | Removes 16 latent `TS2591` errors and ~108 knock-on lint diagnostics before they can be blamed on oxlint | US6                |
| **1** | Take the free win. Move `@cspell/spellchecker` out of the per-file path into the Nx-only layer. No new dependency.                                                                                                                                     | ~1.5 s off the staged path; proves the two-layer idea before adopting a new tool                         | US1                |
| **2** | Build the safety net _first_: generate `rule-inventory.md` from `--print-config`, write the fixture suite covering all 129 rules against the **current** setup, and confirm it passes today.                                                           | The parity harness that makes every later phase falsifiable                                              | US2                |
| **3** | Resolve research gaps with a throwaway spike: native rule coverage, JS plugin loading, unused-import fix parity, react-compiler parity, JS plugin cost, **and the type-aware layer's fix parity and `.mjs` scoping**. Record answers in `research.md`. | Go/no-go per rule, with measurements                                                                     | US2                |
| **4** | Split for real: `tooling/oxlint-config`, port `enforce-safe-env`, seed `.oxlintrc.json` via `@oxlint/migrate`, **wire `--type-aware` + `oxlint-tsgolint`**, rename the Nx targets, add `eslint-plugin-oxlint`, rewrite the hook.                       | The migration; harness from Phase 2 must stay green                                                      | US1, US2, US3, US5 |
| **5** | Re-measure against every SC, drop `--max-old-space-size`, update `AGENTS.md` / `.claude/rules/`, record final numbers.                                                                                                                                 | Evidence the SCs are met, and the docs to use it                                                         | US1, US3, US4      |
| **6** | **TypeScript 7.0.2.** Bump the pins, verify every TypeScript-consuming tool, re-measure `tsc`. Only reachable once Phase 4 has taken typescript-eslint off the lint path.                                                                              | ~4 s off every commit's typecheck; compiler and linter finally agree on semantics                        | US6                |

If Phase 3 finds oxlint cannot carry enough of the rule set to reach SC-001, **Phases 0 and 1 still stand
on their own** and Phase 4 is abandoned rather than forced. That is the intended failure mode.

Phase 6 has its own, different failure mode: if a workspace tool cannot cope with TypeScript 7, the
correct outcome is **TypeScript 6.0.3 plus a recorded blocker** (FR-026), not a partial upgrade and not
a dropped rule. Phase 6 is also the only phase that can be reverted on its own without touching anything
else, which is why it is last rather than interleaved.

## Complexity Tracking

| Violation                                                                                                                                      | Why Needed                                                                                                                                                                                                                                                                                                                                              | Simpler Alternative Rejected Because                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1** — `lint-staged` invokes `oxlint` directly, not through Nx, which principle I says all task execution must go through                    | The staged-file pass operates on the git index, not on a project. Nx has no node for "the files you just staged", and routing through Nx would add back the process overhead this feature exists to remove. Pre-existing: `lint-staged` already calls `eslint` directly today                                                                           | Running `nx affected -t lint` in place of `lint-staged` cannot auto-fix-and-re-stage individual files, and re-lints whole projects for a one-line change. The Nx-orchestrated path is preserved in parallel: the same rules run as the `lint` target in CI and via `run-many`, so the graph-aware execution the principle protects still exists                                                                                                                                                                                             |
| **C2** — Branch is `claude/issue-24-…`, not `feature/<name>`; commit subject cannot match the `<branch>: ` form the `commit-msg` hook requires | The branch is created by the CI action (`.github/workflows/claude.yml`) before any repo convention is consulted. `tooling/commit-conventions/src/validate.ts` accepts only `main`, `staging`, `feature/*`, so the hook rejects any commit on this branch and `--no-verify` is required                                                                  | Renaming the branch mid-run would orphan the action's push target. Recorded here and in the PR body with the hook output, per `.agents/remote-workflow-instructions.md` §implement/4. Worth a follow-up: either widen `BRANCH_PATTERN` to admit `claude/*`, or have the workflow create `feature/*` branches                                                                                                                                                                                                                                |
| **C4** — Two TypeScript copies in the tree after the upgrade                                                                                   | `@nx/eslint` declares `typescript: ~5.9.2` as a hard dependency, not a peer, so 5.9.2 is present whether or not any workspace package asks for it. With `nodeLinker: hoisted`, bumping the workspace to 7.0.2 leaves both resolvable                                                                                                                    | Waiting for Nx to drop or widen that dependency defers a measured 6× typecheck win on someone else's release schedule. The mitigation is to make the resolution deterministic rather than incidental (FR-024): pin `typescript` explicitly at the root, verify `node -e "require('typescript/package.json').version"` and `tsc --version` agree, and record the second copy and its consumer in `measurements.md`. Gap **G13** verifies Nx still functions on its own copy                                                                  |
| **C3** — Four new devDependencies for a change whose headline goal is _less_ tooling                                                           | `oxlint` is the fast linter itself; `oxlint-tsgolint` is what lets it own the 41 type-aware rules, which is what takes typescript-eslint off the lint path and unblocks TypeScript 7; `eslint-plugin-oxlint` prevents duplicate diagnostics (FR-014) without a hand-maintained disable list; `@oxlint/migrate` is invoked via `npx` and never installed | Hand-writing `.oxlintrc.json` from the 129-rule inventory risks silent divergence — exactly the FR-005 failure being guarded against. Hand-maintaining the ESLint disable list goes stale the first time oxlint adds a rule. Net dependency count falls further than in the original plan, because `typescript-eslint` and its seven `@typescript-eslint/*` packages now leave the lint path too, alongside `eslint-plugin-check-file`, `eslint-plugin-import-x`, `eslint-plugin-prefer-arrow-functions` and `eslint-plugin-unused-imports` |

## Risks

| Risk                                                                                                      | Likelihood         | Impact                                                           | Mitigation                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| oxlint's JS plugin API is **alpha**; a plugin misbehaves subtly                                           | Medium             | High — a rule that reports nothing looks identical to clean code | The Phase 2 fixture suite is exactly this detector: every rule must still fire on a planted violation. Never trust a green run as proof a rule is active                                                                                                        |
| oxlint rule semantics differ from the ESLint original despite the same name                               | Medium             | Medium                                                           | Already observed: 5 `no-unnecessary-type-assertion` diagnostics in one test file that ESLint does not report (research §7.5). Gap **G10** establishes cause before the migration commits to a fix. Any unexplained divergence → rule stays with ESLint          |
| The type-aware layer's **auto-fixes** differ from typescript-eslint's                                     | Medium             | Medium                                                           | Task T046 records fix status for all 41 rules before and after. A rule that reports but no longer fixes is a change to US1 acceptance scenario 2 and must be stated, not discovered                                                                             |
| `oxlint-tsgolint` is a young dependency carrying 41 rules                                                 | Medium             | High                                                             | It fails loudly, not silently: a missing binary aborts the run and an unknown rule name fails config parsing (both verified). Pin exactly, and keep the ESLint fallback path documented so a rule can be moved back in one commit                               |
| tsgolint applies TypeScript 7 semantics while the compiler is on 5.9                                      | High until Phase 6 | Medium                                                           | Known and deliberate (research §7.5). It is the argument for Phase 6, not a reason to delay Phase 4 — the mismatch already exists in the other direction today, unrecorded                                                                                      |
| JS plugins erase the speed advantage (gap G5)                                                             | Medium             | Medium                                                           | Measure with 0 and with all JS plugins. If SC-001 fails, move the most expensive plugin's rules back to the ESLint layer and re-measure. Current headroom is large: 0.21 s against a 1 s target                                                                 |
| `nx affected -t lint-workspace` in pre-commit is slower than the ESLint call it replaced, on a cold cache | Low                | Medium                                                           | It is now a 2-rule target rather than a 42-rule one, so the exposure is much smaller than in the original plan. Measure a cold single-project change in Phase 5                                                                                                 |
| Nx caches a `lint` result across an oxlint config change                                                  | Low                | High — a rule change appears to do nothing                       | Gap G9: add the oxlint config paths to `sharedGlobals` and verify a deliberate severity change produces a cache miss                                                                                                                                            |
| oxlint pinned version churn breaks CI                                                                     | Low                | Medium                                                           | Pin exactly (no `^`), honour `minimumReleaseAge: 1 week`, and let Renovate/manual bumps be reviewed like any dependency. `oxlint` and `oxlint-tsgolint` versions must be bumped **together** — tsgolint's version tracks the TypeScript semantics it implements |
| **TypeScript 7 breaks a workspace tool** (Nx `@nx/js/typescript` inference, `knip`, Vitest)               | Medium             | Medium                                                           | Gap **G13**, task T050. The fallback is TypeScript 6.0.3 with the blocker recorded (FR-026). Phase 6 is last and independently revertible precisely so this costs nothing already landed                                                                        |
| `"types": ["node"]` hides ambient types some project relies on implicitly                                 | Low–Medium         | Medium                                                           | All 4 projects pass with it under both 5.9.2 and 7.0.2, but gap **G14** requires checking each project's needs and preferring per-project `types` if they differ                                                                                                |
| The two TypeScript copies (C4) mean `tsc` silently resolves the wrong one                                 | Medium             | High — the upgrade appears to land while nothing changed         | FR-024: assert the resolved version in CI, not by eye. `tsc --version` and `require('typescript/package.json').version` must both be checked and recorded                                                                                                       |
| Contributors keep muscle-memory `pnpm lint` and get the wrong layer                                       | Medium             | Low                                                              | `pnpm lint` keeps meaning "lint everything"; document both targets in `AGENTS.md` (FR-020)                                                                                                                                                                      |

## Success Verification

How each spec success criterion gets checked, and by which task:

| SC     | Verification                                                                                                                     | Task            |
| ------ | -------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| SC-001 | `/usr/bin/time` the staged-lint command on one file, same method as baseline                                                     | T017, T036      |
| SC-002 | Time the full pre-commit hook on an identical one-file staged diff, before and after                                             | T001, T037      |
| SC-003 | `time pnpm lint:check --skip-nx-cache` plus the `lint-workspace` equivalent                                                      | T038            |
| SC-004 | Peak RSS from the same `/usr/bin/time -f %M` run; confirm `--max-old-space-size` removal                                         | T032, T036      |
| SC-005 | `rule-inventory.md` row count = 129, every row has an owner, no unsigned-off drops                                               | T008, T039      |
| SC-006 | The fixture suite passes: every rule fires on its planted violation                                                              | T009–T012, T040 |
| SC-007 | `git diff` review: zero new suppressions in pre-existing files; full lint exits zero                                             | T041            |
| SC-008 | Full run of both layers over the workspace; assert no diagnostic appears twice                                                   | T027            |
| SC-009 | The commit lands with every gate green (C2 aside, which is environmental)                                                        | T044            |
| SC-010 | `time pnpm typecheck --skip-nx-cache` plus per-project `tsc --noEmit`, before and after                                          | T001, T052      |
| SC-011 | Peak RSS from `/usr/bin/time -f %M` on the same `tsc` runs                                                                       | T052            |
| SC-012 | `rule-inventory.md` re-checked after the bump: still 129 rows, still zero dropped                                                | T053            |
| SC-013 | `pnpm nx run-many -t typecheck test build lint`, `pnpm knip`, `pnpm qlty:diff` all green; resolved `typescript` version recorded | T050, T053      |
