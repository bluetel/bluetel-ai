<!--
SYNC IMPACT REPORT
==================
Version change: TEMPLATE (unfilled) → 1.0.0
Bump rationale: Initial ratification. All placeholder tokens replaced with concrete,
enforceable governance derived from the tooling already active in this repository.

Modified principles: none (no prior named principles existed)

Added sections:
  - Core Principles I. Nx-Orchestrated Workspace
  - Core Principles II. Modular Code with Barrel Exports
  - Core Principles III. Colocated Tests, Verified Before Commit (NON-NEGOTIABLE)
  - Core Principles IV. Automated Quality Gates Are Blocking
  - Core Principles V. Traceable, Spec-Driven Change Flow
  - Technology & Dependency Standards (was [SECTION_2_NAME])
  - Development Workflow & Quality Gates (was [SECTION_3_NAME])
  - Governance

Removed sections: none

Templates requiring updates:
  - ✅ .specify/templates/plan-template.md — "Constitution Check" placeholder replaced
       with the five concrete principle gates
  - ✅ .specify/templates/spec-template.md — reviewed; no constitution-driven mandatory
       sections added or removed, no change required
  - ✅ .specify/templates/tasks-template.md — reviewed; task categorization already covers
       the principle-driven types (tests, quality gates), no change required
  - ✅ .specify/templates/checklist-template.md — reviewed; agent-agnostic, no change required
  - ✅ .claude/skills/speckit-*/ and .agents/skills/speckit-*/ — reviewed for stale
       agent-specific references; all use generic or correctly-scoped naming
  - ✅ README.md / AGENTS.md — reviewed; no principle references to correct

Deferred TODOs: none

SYNC IMPACT REPORT — 1.0.0 → 1.1.0
==================================
Bump rationale: MINOR. Principle IV's lint gate is materially expanded — it now describes two
layers rather than one, and adds a new requirement (a rule belongs to exactly one layer, and
moving one requires a planted-violation fixture). No principle removed or redefined.

Trigger: spec 005 replaced ESLint with oxlint on the per-file path. Per the Governance section,
a tool/document disagreement is a defect to be fixed in the change that creates it.

Modified sections:
  - Core Principles IV — lint gate now names oxlint and the ESLint `lint-workspace` layer
  - Development Workflow & Quality Gates — pre-commit order gains the `lint-workspace` step
    and the oxlint/tsgolint fail-closed requirement; CI command gains `lint-workspace`

Templates requiring updates:
  - ✅ AGENTS.md — new "Linting" section describing both layers and how to add a rule
  - ✅ .claude/rules/typescript-conventions.md — same, in brief
  - ✅ .specify/templates/*.md — reviewed; no lint-tool references, no change required
-->

# bluetel-ai Constitution

## Core Principles

### I. Nx-Orchestrated Workspace

Every project lives under `apps/`, `packages/`, or `tooling/` as a pnpm workspace member and
declares its own targets. All task execution MUST go through Nx (`nx run`, `nx run-many`,
`nx affected`) prefixed with pnpm, never the underlying tool directly. Each project owns its own
config (e.g. `vitest.config.ts`, `eslint.config.mjs`, `tsconfig.json`) and MUST be runnable in
isolation from its own directory.

Rationale: Nx's project graph is what makes caching and `affected`-scoped CI correct. Invoking
tools directly bypasses the graph, silently defeats caching, and produces CI runs that miss real
breakage in dependent projects.

### II. Modular Code with Barrel Exports

Source MUST be split into focused modules with a single, clear responsibility; large monolithic
files are not acceptable. A directory's or package's public API MUST be exported through an
`index.ts` barrel, and consumers MUST import from the barrel rather than reaching into internal
module paths. Import statements MUST NOT carry `.js` (or other) file extensions.

Rationale: Barrels are the seam that lets internals be refactored without breaking consumers.
Extensionless imports keep the ESM + bundler `moduleResolution` setup consistent across every
project in the workspace.

### III. Colocated Tests, Verified Before Commit (NON-NEGOTIABLE)

Every module file MUST have a colocated test file in the same directory, named
`<filename>.test.ts` (or `.tsx`/`.js`/`.jsx`). Tests MUST NOT be relocated to a separate mirror
tree. The pre-commit hook runs Vitest for every staged test file and for the colocated test of
every staged source file; a failing test blocks the commit. Committing with verification bypassed
(e.g. `--no-verify`) is prohibited.

Rationale: Colocation makes an untested module visibly untested and keeps the test adjacent to
the code it constrains. Running only the affected tests at commit time is what keeps that gate
fast enough to never be worth skipping.

### IV. Automated Quality Gates Are Blocking

Quality signals are gates, not advice. The following MUST pass and MUST NOT be weakened to make
a change land:

- oxlint (with `--type-aware --fix`) and Prettier over all staged files, via lint-staged.
  oxlint enforces the great majority of the rule set, including every rule that needs type
  information. The handful it cannot run — currently `@nx/enforce-module-boundaries`,
  `@cspell/spellchecker`, `no-octal` and `no-dupe-args` — are enforced by ESLint as the Nx
  `lint-workspace` target, which the pre-commit hook runs `affected`-scoped. A rule MUST
  belong to exactly one layer, and moving one between layers MUST come with a
  planted-violation fixture in `tooling/lint-coverage` proving it still fires. A green lint
  run is not evidence that a rule ran.
- `pnpm typecheck` across the workspace — TypeScript runs in `strict` mode.
- The qlty code-health gate on the branch diff (`pnpm qlty:diff`): zero lint or security issues
  at `medium` severity or above, and at most 10% duplicated lines in the changed files.

Thresholds live in `tooling/qlty-diff/src/config.ts`. `QLTY_*` environment overrides exist for
local investigation only and MUST NOT be used to pass CI. Raising a threshold is an amendment to
this constitution, not a per-change decision.

Rationale: A gate that any individual change can lower is not a gate. Centralising the thresholds
makes every relaxation a reviewable, deliberate act.

### V. Traceable, Spec-Driven Change Flow

Branch names MUST match `main`, `staging`, or `feature/<name>`. Commit subjects MUST be prefixed
`BTAI-<number>: ` when the branch carries a ticket ID, otherwise `<branch-name>: `; only
machine-generated commits (Merge, Revert, Amend, `fixup!`, `squash!`) are exempt. Both rules are
enforced by the `commit-msg` hook.

Non-trivial features MUST be developed through the Spec Kit flow — a `specs/<###-feature-name>/`
directory carrying `spec.md`, then `plan.md`, then `tasks.md` — before implementation begins.

Rationale: The prefix convention ties every commit back to its ticket or branch, and the spec
directory keeps the reasoning behind a change durable and reviewable after the branch is gone.

## Technology & Dependency Standards

**Runtime and tooling.** pnpm is the only package manager (version pinned via `packageManager`).
The Node version MUST come from `.nvmrc`; CI resolves it via `node-version-file`. TypeScript is
configured once in `tsconfig.base.json` with `strict`, `isolatedModules`, ESM modules, and
`bundler` module resolution — projects extend it and MUST NOT relax these compiler options.

**Dependencies.** New dependencies MUST be installed at the workspace member that uses them.
Cross-cutting versions (React, React Native, Tailwind, Vite, Lexical, and security-driven
minimums) are pinned centrally in `pnpm-workspace.yaml` `overrides` and MUST be changed there
rather than per-project. `minimumReleaseAge` is set to one week: freshly published versions are
not adopted automatically. The lockfile MUST be committed, and CI installs with
`--frozen-lockfile`.

**Shared configuration.** Lint, formatting, and commit conventions are consumed from the
`@bluetel-ai/*` packages under `tooling/`. Projects MUST extend the shared configs rather than
fork them; a rule that should apply everywhere belongs in `tooling/`.

**Dead code and spelling.** Knip (`pnpm knip`) and cspell configurations are workspace-level.
Unused exports and dependencies MUST be removed rather than suppressed, unless an entry in
`knip.json` documents why the code is legitimately unreferenced.

## Development Workflow & Quality Gates

**Local loop.** Work happens on a `feature/<name>` branch. The pre-commit hook runs, in order:
lint-staged (oxlint + Prettier), the affected Vitest suites, `pnpm typecheck`,
`nx affected -t lint-workspace` (the ESLint layer), and `pnpm qlty:diff` against `origin/main`.
qlty MUST be installed locally, and `oxlint` and `oxlint-tsgolint` MUST both be resolvable; the
hook fails closed when any of them is absent.

**Continuous integration.** Pull requests run two independent jobs. The `qlty` job re-runs the
code-health gate against the PR base ref. The `main` job runs
`nx affected -t lint lint-workspace test typecheck`. Both MUST be green before merge — a run
that omits `lint-workspace` is not enforcing the whole rule set.

**Review.** Every pull request MUST be reviewed against these principles. A reviewer who finds a
principle violated MUST either request a change or require it be recorded in the plan's
Complexity Tracking table with a rejected simpler alternative. Unjustified complexity is grounds
for rejection on its own.

**Deployment.** Deploys are triggered only from `main` (production) and `staging` (staging), and
only for `affected` projects exposing a `trigger-deploy` target. Deploying from a feature branch
or by hand-running a deploy target outside this flow is prohibited.

## Governance

This constitution supersedes ad-hoc practice and undocumented convention. Where a tool's
configuration and this document disagree, that is a defect: one of the two MUST be corrected in
the same change that discovers it.

**Amendments.** Any change to a principle, a quality threshold, or the workflow gates MUST be
made by amending this file in a dedicated pull request that states the rationale, the version
bump, and the migration path for work already in flight. Amendments MUST propagate to the
dependent artifacts in the same change: `.specify/templates/plan-template.md`,
`.specify/templates/spec-template.md`, `.specify/templates/tasks-template.md`, and the runtime
guidance in `AGENTS.md` and `.claude/rules/`.

**Versioning.** This document is versioned MAJOR.MINOR.PATCH:

- MAJOR — a principle is removed or redefined in a backward-incompatible way.
- MINOR — a principle or section is added, or existing guidance is materially expanded.
- PATCH — clarifications, wording, and non-semantic refinements.

**Compliance review.** Principle compliance is verified at two points: the Constitution Check
gate in `plan-template.md`, evaluated before Phase 0 research and re-checked after Phase 1
design; and pull request review. Automated enforcement lives in the git hooks and CI workflows
described above, and those MUST remain the source of truth for anything mechanically checkable.

**Runtime guidance.** Day-to-day development guidance for agents and contributors lives in
`AGENTS.md` and `.claude/rules/`. Those documents elaborate on this constitution and MUST NOT
contradict it.

**Version**: 1.1.0 | **Ratified**: 2026-08-05 | **Last Amended**: 2026-08-12
