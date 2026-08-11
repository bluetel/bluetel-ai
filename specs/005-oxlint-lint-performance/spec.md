# Feature Specification: Fast Lint Feedback Without Losing Coverage

**Feature Branch**: `005-oxlint-lint-performance`

**Created**: 2026-08-11

**Status**: Draft

**Input**: GitHub issue [#24](https://github.com/bluetel/bluetel-ai/issues/24) — "[Feature] Improve lint-staged and broader lint performance"

> Husky linting is currently very slow for individual contributors when pushing to PRs. However it's
> important we still maintain strict checks as AI agents often attempt to push sloppy code that would
> then fail in CI.

## Problem Statement

The pre-commit gate is the repo's primary defence against sloppy code — [Constitution](../../.specify/memory/constitution.md)
principle IV makes it blocking and forbids weakening it. That gate is currently slow enough that
contributors feel the friction on every commit, which creates pressure to bypass it (`--no-verify`),
which is exactly the failure mode principle III prohibits.

The friction is not evenly distributed. Measured on a GitHub Actions runner against this repo's
42 linted files (method recorded in `research.md`):

| Measurement                                                      | Observed                    |
| ---------------------------------------------------------------- | --------------------------- |
| ESLint on a **single** file, exactly as `lint-staged` invokes it | **5.68 s**, 780 MB peak RSS |
| `pnpm lint:check --skip-nx-cache` — all 7 projects, cold         | 30.7 s                      |
| `pnpm typecheck --skip-nx-cache` — all projects, cold            | 7.3 s                       |

Two things stand out:

1. **Per-file cost is almost entirely fixed overhead.** 5.68 s to lint one file is Node startup, flat
   config resolution, plugin loading, and TypeScript program construction — not analysis of the file.
   `lint-staged` pays this on every commit no matter how small the change, and it cannot be Nx-cached
   because it runs against the staged working tree rather than a project.
2. **One rule dominates the analysis that does happen.** A `TIMING=15` run over
   `packages/env-validation-errors` attributes **61.7 %** of rule time to `@cspell/spellchecker`
   (1555 ms) — a check that has to be blocking somewhere, but has no reason to run per-file at commit
   time.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Contributor commits a one-line change (Priority: P1)

A contributor fixes a typo in one source file and commits. The pre-commit hook lints and formats the
staged file, runs its colocated test, typechecks the workspace, and runs the code-health gate. Today
the lint step alone costs ~5.7 s of that wait; the contributor comes to see the hook as something to
work around rather than a safety net.

**Why this priority**: This is the friction the issue was opened about, it is paid many times per day
per contributor, and it is what motivates hook bypass. Fixing it alone delivers the feature's value.

**Independent Test**: Stage a single-line edit to one `.ts` file, run the staged-lint command, and
compare wall-clock time against the recorded baseline. No other story needs to ship for this to be
demonstrable.

**Acceptance Scenarios**:

1. **Given** one `.ts` file staged with a trivial edit, **When** the pre-commit lint step runs,
   **Then** it completes in under 1 s and reports the same diagnostics the current setup reports for
   that file.
2. **Given** one `.ts` file staged containing an unused import, **When** the pre-commit lint step
   runs, **Then** the import is auto-fixed and re-staged, as it is today.
3. **Given** 20 files staged, **When** the pre-commit lint step runs, **Then** wall-clock time grows
   sub-linearly rather than paying per-file startup cost.

---

### User Story 2 - Maintainer verifies no coverage was lost (Priority: P1)

A maintainer reviewing the change needs to confirm that every rule enforced before is still enforced
after — same severity, equivalent options. "It got faster" is worthless if it got faster by quietly
not checking something. This is the issue's first condition of satisfaction.

**Why this priority**: Equal in priority to P1 speed. A fast gate with a hole in it is a regression,
not an improvement, and the hole would stay invisible until an agent pushed code through it.

**Independent Test**: A checked-in inventory maps every currently-enforced rule to its post-change
owner (fast linter, ESLint, or a separate workspace check) with a coverage status, and a reviewer can
diff that inventory against the current effective config.

**Acceptance Scenarios**:

1. **Given** the rule inventory artifact, **When** a reviewer compares it to the pre-change effective
   config, **Then** every rule appears with an explicit owner and none is marked dropped or
   downgraded.
2. **Given** a file that violates any single previously-enforced rule, **When** the full lint gate
   runs, **Then** that violation is still reported as an error.
3. **Given** a rule whose enforcement genuinely cannot be preserved, **When** the inventory is read,
   **Then** it is listed with the reason, the compensating check, and explicit sign-off — never
   silently absent.

---

### User Story 3 - AI agent gets fast, in-loop feedback (Priority: P2)

An AI agent working in the repo runs the lint command repeatedly while iterating, before ever
attempting a commit. A sub-second lint pass makes self-correction cheap, so sloppy code gets fixed in
the agent's own loop instead of arriving at CI.

**Why this priority**: This is the issue's stated reason for keeping checks strict. It largely follows
from P1, but it drives one distinct requirement: the fast pass must be runnable standalone, on a path
or glob, without the commit machinery around it.

**Independent Test**: Run the fast lint command directly against a directory and confirm it returns
diagnostics in under 1 s without invoking git, Nx, or the hook.

**Acceptance Scenarios**:

1. **Given** an agent mid-edit, **When** it runs the fast lint command on the files it touched,
   **Then** it gets errors in under 1 s.
2. **Given** an agent has fixed the reported errors, **When** the pre-commit hook later runs,
   **Then** the hook reports nothing new from the fast pass.

---

### User Story 4 - Existing code is not flooded with new violations (Priority: P2)

Whoever lands this change must not also land hundreds of unrelated violations. Adopting a new linter
means adopting its rule catalogue, and enabling a broad category can light up code that was
previously clean. This is the issue's second condition of satisfaction.

**Why this priority**: A migration that produces a large unrelated diff, or that needs `--no-verify`
to land, has broken principles III and IV on the way to serving principle IV. It must be prevented by
construction, not cleaned up afterwards.

**Independent Test**: Run the full lint gate over the whole workspace on the migration commit and
confirm zero errors, with no per-file suppressions added to source files.

**Acceptance Scenarios**:

1. **Given** the workspace at the migration commit, **When** the full lint gate runs, **Then** it
   exits zero.
2. **Given** a rule newly available from the fast linter that flags existing code, **When** the config
   is authored, **Then** that rule is either left disabled with a recorded reason or the existing code
   is fixed in the same change — not suppressed inline.
3. **Given** the migration commit, **When** its diff is reviewed, **Then** it contains no
   `eslint-disable`/`oxlint-disable` comments added to pre-existing source files.

---

### User Story 5 - Rules stay defined once, for the whole workspace (Priority: P3)

A maintainer who wants to add or change a rule edits one shared config under `tooling/` and every
project picks it up, as today with `@bluetel-ai/eslint-config-base`. The repo's own custom rule
(`@bluetel-ai/enforce-safe-env`) keeps being enforced.

**Why this priority**: Preserves the existing maintenance model and the Constitution's "shared
configuration" standard. Valuable, but the feature is useful without any change to how sharing works.

**Independent Test**: Change one rule's severity in the shared config and confirm the change takes
effect in a project that only extends it.

**Acceptance Scenarios**:

1. **Given** a rule severity changed in the shared `tooling/` config, **When** a consuming project is
   linted, **Then** the new severity applies without editing that project's own config.
2. **Given** a file that reads `process.env` unsafely, **When** it is linted, **Then**
   `@bluetel-ai/enforce-safe-env` still reports an error.
3. **Given** the custom rule's existing unit tests, **When** the suite runs, **Then** it still passes.

---

### Edge Cases

- **A file type the fast linter cannot parse.** `.mjs`/`.cjs` config files, and any future `.vue`/
  `.svelte` file, must either be handled or explicitly routed to the slower linter — never silently
  skipped.
- **A rule that needs type information.** Rules requiring a TypeScript program cannot run in a fast
  per-file pass. They must keep running somewhere blocking, at a cadence that does not reintroduce
  the per-file cost.
- **Auto-fixes fighting each other.** Two linters plus Prettier all writing the same staged file can
  leave a file re-modified after being re-staged. Fix ownership per rule must be unambiguous.
- **The same violation reported twice.** If both linters enforce a rule, the contributor sees a
  duplicate diagnostic and cannot tell which tool to satisfy.
- **Inline suppression comments.** Existing `eslint-disable*` comments in the codebase must keep
  suppressing the rule they name, regardless of which tool now owns it.
- **A binary that is not installed.** The hook already fails closed when `qlty` is missing; a new tool
  must behave the same way rather than skipping the check.
- **Nx cache correctness.** If lint config moves into files Nx does not treat as an input, cached
  `lint` results go stale and a rule change appears to have no effect.
- **CI vs local divergence.** CI runs `nx affected -t lint …`; the hook runs on staged files. Both
  must enforce the same rule set, or a contributor can be green locally and red in CI.
- **A commit that stages only a deletion.** The lint step must not fail on an empty file list.

## Requirements _(mandatory)_

### Functional Requirements

**Speed**

- **FR-001**: The staged-file lint pass MUST complete in under 1 s for a single-file change on
  hardware comparable to the recorded baseline.
- **FR-002**: The staged-file lint pass MUST NOT pay a per-file process startup cost; linting N files
  MUST cost materially less than N times the single-file cost.
- **FR-003**: The full-workspace lint gate, run cold with caching disabled, MUST complete in at most
  half the recorded 30.7 s baseline.
- **FR-004**: A fast lint pass MUST be runnable standalone against an arbitrary path or glob, without
  git, Nx, or the pre-commit hook.

**Coverage preservation**

- **FR-005**: Every rule enforced before this change MUST remain enforced after it, at the same
  severity and with equivalent options.
- **FR-006**: The change MUST include a checked-in inventory mapping each previously-enforced rule to
  its post-change owner and coverage status.
- **FR-007**: Any rule that cannot be preserved MUST be recorded in that inventory with the reason and
  the compensating check; silent removal or downgrade is prohibited.
- **FR-008**: Rules that require TypeScript type information MUST continue to be enforced as blocking
  checks.
- **FR-009**: The workspace's custom lint rule (`@bluetel-ai/enforce-safe-env`) MUST remain enforced,
  with its unit tests still passing.
- **FR-010**: Existing inline suppression comments MUST continue to suppress the rules they name.
- **FR-011**: The rule set enforced by the pre-commit hook MUST match the rule set enforced by CI, so
  a locally-green commit cannot fail CI on lint.

**No new noise**

- **FR-012**: At the migration commit, the full lint gate MUST report zero errors across the
  workspace.
- **FR-013**: Newly-available rules that would flag existing code MUST NOT be enabled unless the
  existing code is fixed in the same change; enabling a rule and suppressing its findings inline is
  prohibited.
- **FR-014**: The same violation MUST NOT be reported by two tools in one run.

**Fit with the existing workspace**

- **FR-015**: All lint execution MUST remain reachable through Nx targets (`pnpm nx run`, `run-many`,
  `affected`), and cached lint results MUST invalidate when lint configuration changes.
- **FR-016**: Shared lint configuration MUST continue to live in `tooling/` and be extended, not
  forked, by consuming projects.
- **FR-017**: Auto-fix ownership MUST be unambiguous: for any given rule exactly one tool applies the
  fix, and the staged-file pipeline MUST leave a file in a stable state after re-staging.
- **FR-018**: The pre-commit hook MUST fail closed if a required lint tool is unavailable.
- **FR-019**: The lint step MUST exit successfully when no lintable files are staged.
- **FR-020**: Contributor-facing documentation (`AGENTS.md` / `.claude/rules/`) MUST describe the
  commands to run, and MUST NOT contradict the Constitution.

### Key Entities

- **Rule inventory**: The audit artifact behind FR-006. One row per previously-enforced rule: rule
  name, source plugin, severity, options, post-change owner, coverage status, notes.
- **Shared lint configuration**: The `tooling/` package(s) defining the workspace rule set, which
  every project extends.
- **Fast lint pass**: The per-file, type-information-free check that runs in `lint-staged` and can be
  invoked ad hoc.
- **Type-aware lint pass**: The check that needs a TypeScript program, running at a cadence that keeps
  it off the per-file path.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: Linting a single staged `.ts` file drops from 5.68 s to under 1 s — an ≥ 80 % reduction
  on the same hardware and measurement method.
- **SC-002**: Total pre-commit wall-clock time for a one-file change falls by at least 40 %, measured
  before and after with the same staged diff.
- **SC-003**: Cold full-workspace lint drops from 30.7 s to 15 s or less.
- **SC-004**: Peak memory for the staged-file lint pass falls well below the current 780 MB, removing
  the need for the `--max-old-space-size=8192` workaround in the `lint-staged` command.
- **SC-005**: 100 % of previously-enforced rules are accounted for in the inventory, with zero rows
  marked dropped or downgraded without recorded sign-off.
- **SC-006**: A deliberately-planted violation of each previously-enforced rule is still reported as
  an error — verified by an executable check, not by inspection.
- **SC-007**: The migration commit introduces zero lint errors and zero new inline suppressions in
  pre-existing files.
- **SC-008**: Zero duplicate diagnostics: no violation is reported by more than one tool in a single
  full lint run.
- **SC-009**: The commit lands without `--no-verify`, i.e. every blocking gate passes on it.

## Assumptions

- The Constitution's blocking-gate principle is not up for negotiation; this feature makes the gates
  cheaper, never weaker. Any rule relaxation would be a constitutional amendment and is out of scope.
- The `@cspell/spellchecker` ESLint rule accounts for 61.7 % of measured rule time. Spell checking
  does **not** need to happen per-file at commit time to be effective; it needs to happen blockingly
  somewhere. Relocating it off the per-file path therefore counts as preserving coverage, and it is the
  single largest available win. (`pnpm audit:cspell` is **not** a substitute — it audits `cspell.json`'s
  word list for unused/duplicate entries; it does not spell-check source. See `research.md` §3.5.)
- Baseline numbers were taken on a GitHub Actions runner and are a relative reference. Re-measure
  locally before and after; the ratios, not the absolute figures, are the target.
- The repo currently has 42 linted files, so fixed overhead dominates today. The design must also hold
  as the workspace grows, which is why targets are expressed per-file and as reductions rather than as
  fixed totals for 42 files.
- The type-aware rule layer stays exactly as strict as it is today. Where it runs — which tool, which
  cadence — is a design decision for `plan.md`.
- Prettier remains the formatter; no formatting rules move into a linter.
- Tool selection is deliberately not fixed here. The issue proposes oxlint, and `plan.md` evaluates it
  against these requirements — including the parts of the current rule set it cannot yet cover.

## Out of Scope

- Weakening, disabling, or re-scoping any existing rule to gain speed.
- Changing the `qlty` code-health thresholds in `tooling/qlty-diff/src/config.ts`.
- Reworking the pre-commit Vitest or typecheck steps, except where a lint change measurably affects
  them.
- Upgrading TypeScript. If a faster type-aware path depends on a TypeScript major upgrade, that is a
  separate feature; this one must deliver its P1 value without it.
- Adding new lint rules for their own sake. New rules are in scope only where needed to preserve
  existing coverage.
