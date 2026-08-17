# Implementation Plan: Static prompt-quality validator for AI-authored artifacts

**Branch**: `claude/issue-15-20260811-1041` | **Date**: 2026-08-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-prompt-quality-validator/spec.md`

> **Revised 2026-08-11** after review feedback on [PR #28](https://github.com/bluetel/bluetel-ai/pull/28):
> _"we were hoping to use this tool as a dependency dont re-write it"._ `contextops` is now a pinned dependency
> rather than prior art. What changed: the token approximation, the shingle-clustering redundancy
> implementation and the re-weighted score are **deleted** and delegated to it; the score is reported verbatim
> with its own four dimensions; four modules leave the tree and one adapter directory joins it; the payload
> modelling in [research.md](./research.md#r10) becomes the design's second load-bearing decision. What did not
> change: the repository-specific correctness rules, which are the half `contextops` has no way to know about.

## Summary

Add `tooling/prompt-lint` — a new Nx library + CLI that gates this repository's AI-authored markdown the way
`tooling/qlty-diff` gates its code health: deterministic, diff-scoped by default, thresholds in one central file,
blocking in CI.

It is **two halves with a hard line between them**, and the line is the whole architecture:

- **Correctness — ours, because nothing else can do it.** Do the references resolve, is the metadata complete
  and well-formed, does the installed copy still match the catalog, was the version bumped, does the artifact
  contradict `.agents/skills.config`. These are properties of _this_ repository's conventions and _this_
  installer's model. They produce findings, and findings gate.
- **Context economy — [`contextops`](https://github.com/Abhijeet777ui/contextops), because it already does it.**
  Redundancy, density, structure and concentration over an assembled context payload, a token breakdown from
  `tiktoken`, and a bounded 0–100 score. `prompt-lint` shells out to a pinned `contextops==0.3.3`, maps its
  findings into the same finding stream, and reports its score **verbatim** — no re-weighting, no dropped
  dimension, no blending with our findings ([research.md](./research.md#r7)).

The structural approach stays **the qlty-diff shape**: `config.ts` holding every threshold with documented
`PROMPT_LINT_*` overrides for local investigation only, a `gate.ts` that turns findings into one exit code, a
thin `cli.ts` run through `tsx`, a barrel `index.ts`, and colocated Vitest beside every module. Shelling out to
an external non-Node binary that CI and the pre-commit hook both require is also the qlty-diff shape — `qlty`
is exactly that today ([research.md](./research.md#r9)).

Four things are where the design effort goes:

1. **Reference resolution that is right rather than loud.** A prototype scan of the naive rule ("every backticked
   path must exist") produced 40+ hits over the current tree, of which exactly one was a real defect. The
   resolution algorithm in [research.md](./research.md#r2) — resolve against the artifact directory, the skill
   root, then the repo root; only claim a path is dangling when it is _path-shaped_ and its first segment is a
   real directory in one of those roots — reduces that to the one true positive:
   `tooling/skills/catalog/copywriting/references/natural-transitions.md:276` points at "the seo-audit skill's
   `references/ai-writing-detection.md`", and there is no `seo-audit` skill in this catalog. That defect is live
   in the published catalog today and every project that installed `copywriting` has a copy of it.

2. **Turning a repository into context payloads.** `contextops` analyses `{system, chunks, tools, …}` assembled
   for one inference call, not a directory. `prompt-lint` assembles one payload per **context bundle** — the
   guidance every run loads, then one per skill consisting of that fixed guidance prefix plus the skill body and
   its references ([research.md](./research.md#r10)). Get this wrong and every number the dependency returns is
   noise; get it right and concentration means "one reference file is 80% of what this skill costs". **The
   repository's knowledge now lives in the payload, not in the algorithms.**

3. **Cross-artifact rules the installer's model demands.** Catalog-to-installed drift, the version bump that
   makes an update visible to targets, `assets=`/`requires=`/`next_step=` referential integrity, and
   `.claude/` pointer agreement with `skill.meta`. These are not properties of a file; they are properties of the
   set, and no per-file linter — ours or anyone's — can see them.

4. **Staged adoption, because the surface is not currently clean.** Measured now: 10 of 17 catalog descriptions
   lack the `Use when:` trigger clause (`speckit-*`, all of them), and `.agents/remote-workflow-instructions.md`
   tells the agent the ticket prefix is `URM` and the repo is `harrytwigg/universal-react-monorepo` while
   `.agents/skills.config` — the file the skills actually read — says `bluetel/bluetel-ai`. Turning both rules on
   as errors would fail every pull request in flight. The plan ships per-rule severity in the central config plus
   a draining `baseline.json`, so a rule can land non-blocking and be promoted in its own reviewable change.

Net shape: one new project, ~19 small modules each with a colocated suite, one pinned external dependency it
invokes but never installs, one new root script pair, two new CI steps (one to make `contextops` available, one
to run the gate), one new Nx target on `tooling/skills`, one rule-catalogue doc. No change to any existing
behaviour.

## Technical Context

**Language/Version**: TypeScript 5.x, `strict`, ESM, `bundler` module resolution — inherited from
`tsconfig.base.json` and not relaxed. Node from `.nvmrc`. Executed via `tsx`, exactly as `qlty:diff` is.

**Primary Dependencies**: **One external tool, pinned; no new npm package.**

| Dependency                 | Version               | How it is obtained                                                              | What breaks without it                                                                     |
| -------------------------- | --------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `contextops`               | `==0.3.3` (exact pin) | Already on `PATH`, or `uvx` / `pipx run`, or `PROMPT_LINT_CONTEXTOPS_BIN` (R9)  | The context-economy half and the score. Exit `6`, an explicit failure, never a silent pass |
| Python                     | ≥ 3.10                | The machine's, or `uv`'s ephemeral one — `prompt-lint` never installs a runtime | As above                                                                                   |
| `tiktoken`, `click`        | `contextops`' own     | Transitively, inside whichever environment runs it                              | As above. Not this workspace's dependency tree — nothing enters `pnpm-lock.yaml`           |
| `node:fs`/`path`/`process` | Node from `.nvmrc`    | Built in                                                                        | —                                                                                          |
| `node:child_process`       | Node from `.nvmrc`    | Built in — used for `git` and for `contextops`                                  | —                                                                                          |

Still deliberately absent: a YAML parser (the frontmatter in scope is a flat `key: value` block —
[research.md](./research.md#r4)) and a markdown AST library ([research.md](./research.md#r3)). Both were rejected
on fit rather than on a blanket no-dependencies stance, which is why neither reverses here. What does reverse is
the tokenizer: `tiktoken` arrives inside `contextops` and the hand-written size approximation is deleted
([research.md](./research.md#r5)).

**Storage**: None. Two checked-in data files: `src/config.ts` (thresholds, including the `contextops` pin) and
`baseline.json` (known pre-existing violations, drains over time). At runtime, one temp file per bundle carrying
the payload handed to `contextops`, deleted after the run and never named in the report (FR-039).

**Testing**: Vitest, colocated per Principle III, one `<module>.test.ts` per module. Rule tests use in-memory
artifact fixtures rather than temp trees where the rule is pure; the discovery, git-scope and drift modules use
throwaway temp directories, following the pattern already established in `tooling/skills/lib/test-helpers.ts`.
The `contextops/` adapter is tested at two levels: payload construction and response mapping against **recorded
fixtures** (fast, no subprocess, runs everywhere), plus one **contract test** that actually invokes the pinned
binary, asserts the version, and runs `contextops stability` to prove the engine is deterministic on this
machine. The contract test skips with a clear message when the binary is absent, so a contributor without Python
can still run the suite — but CI has it, so a drifted engine cannot land.

**Target Platform**: Node on Linux and macOS — a developer machine via the pre-commit hook and the root script,
and `ubuntu-latest` in GitHub Actions (which carries Python 3.12 and `pipx` out of the box; verified on the
runner this plan was written on). No browser, no bundling, nothing published to npm or PyPI.

**Project Type**: Nx library + CLI under `tooling/`, private to the workspace. Mirrors `tooling/qlty-diff` in
every structural respect, including that it drives an external binary.

**Performance Goals**: SC-002 — under 10s for a diff-scoped run over fewer than 20 changed artifacts, under 60s
for the whole repository. Both budgets doubled from the previous revision, because the context-economy half is
now 19 Python subprocesses rather than an in-process loop; `contextops` publishes under 2s per ≤5,000 tokens.
The correctness half remains milliseconds, and a diff-scoped run builds only the bundles a changed artifact
belongs to — usually one. `--rules-only` skips the subprocesses entirely.

**Constraints**: No model or inference calls, and no network call made by `prompt-lint` itself (FR-046). One
honest asterisk, recorded rather than buried: `tiktoken` fetches its BPE vocabulary once on a cold machine and
caches it — mitigated with `TIKTOKEN_CACHE_DIR` and a CI cache keyed on the pin
([research.md](./research.md#r5)). Deterministic output — no timestamps, no absolute paths, no `Date`, no
unordered iteration surfacing in output (FR-029, FR-039), and an explicitly constructed subprocess environment
so an inherited variable cannot become an input. `qlty:diff` must pass with no threshold override, which for a
change of this shape means the **duplication** limit is the binding constraint: 15+ rule modules with the same
skeleton is exactly how a diff crosses 10% duplicated lines. Mitigated by a single `defineRule` helper and shared
assertion helpers in the tests rather than copy-paste per rule.

**Scale/Scope**: ~35 new source modules and their colocated suites, plus 7 `index.ts` barrels, in one new project;
~7 files modified outside it
(root `package.json`, `knip.json`, `.github/workflows/ci.yml`, `.husky/pre-commit`, `tooling/skills/project.json`,
`cspell.json`, `README.md`). 25 rules across 11 families — 21 with a catalogue entry that can be promoted or
demoted, of which 5 are backed by `contextops` rather than implemented here, plus 4 self-describing bookkeeping
rules. No existing module changes behaviour.

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
| Dependency Standards — external  | `contextops` pinned exactly, declared in one place, asserted at runtime, never installed on a user's behalf, and licence-checked before adoption                          | PASS\* |

\* Two deviations, both recorded in [Complexity Tracking](#complexity-tracking): the branch is
`claude/issue-15-…`, not `feature/<name>`; and the external dependency is Sustainable-Use-licensed, which is
within its grant for internal use but needs a human sign-off before anything client-facing is built on it.

> **Update 2026-08-17 — the licence gate now passes outright for internal use.** The sign-off T060 was waiting
> for was granted; see [T060](#t060--licence-sign-off-granted). The `PASS*` on _Dependency Standards —
> external_ becomes `PASS` for this repository's own CI and pre-commit gate. It stays conditional only for
> client-facing use, which nothing here does. The branch deviation was also resolved for the implementation
> work, which sits on `feature/prompt-quality-validator`; the constitution amendment T089 raises is still
> outstanding for the `claude/*` branches the GitHub Action creates.

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
  pair lands in the module's own file. Two clarifications the tree above makes explicit: `cli.ts` carries
  `cli.test.ts` like any other module — Principle III admits no exception for an entry point — and the `index.ts`
  barrels do not, because a re-export has no behaviour of its own to constrain, which is the precedent
  `tooling/qlty-diff/src/index.ts` already sets. The registry gets its own suite for the catalogue cross-check (FR-047,
  SC-010) — the test that makes an undocumented rule impossible.
- **IV (`qlty:diff`).** The duplication limit is the real risk here, not lint or security: a rule family written
  by copy-paste would breach 10% on its own. `defineRule` plus shared test helpers is a design constraint
  imposed by the gate, not a stylistic preference. No `QLTY_*` override is used.
- **Dependency Standards.** One external tool, taken deliberately and on instruction: _"we were hoping to use
  this tool as a dependency dont re-write it"_. The judgement it replaces is worth stating, because the previous
  revision got it backwards — it treated "zero third-party dependencies" as a virtue and paid for it by
  hand-writing shingle clustering, a token approximation and a bespoke score. That is not a smaller
  supply-chain surface; it is the same surface with us as the vendor, minus the determinism guarantee and the
  external comparability. Three properties keep this a controlled dependency rather than an open one:
  **pinned exactly** (`==0.3.3`, asserted at startup, not merely present); **behind an adapter** — everything
  `contextops` touches lives in `src/contextops/` behind one JSON contract, so replacing it is a bounded change
  rather than an excavation; and **absent from `pnpm-lock.yaml`** — it is a tool the process invokes, exactly as
  `qlty` is, not a package this workspace resolves. The two places a dependency was still the wrong answer (YAML,
  markdown AST) keep their decision entries in [research.md](./research.md).

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
│   ├── cli.test.ts                      #   argv parsing, mutually exclusive flags, exit-code mapping
│   ├── config.ts                        # EVERY threshold + per-rule severity + the contextops pin; PROMPT_LINT_* overrides
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
│   │   ├── suppress.ts                  # reasoned inline suppressions + stale detection (FR-009, FR-010)
│   │   ├── suppress.test.ts
│   │   └── index.ts
│   ├── contextops/                      # THE ADAPTER — the only code that knows the dependency exists
│   │   ├── locate.ts                    # PATH / uvx / pipx / env var; version assertion; exit 6 (R9)
│   │   ├── locate.test.ts
│   │   ├── bundle.ts                    # artifacts → context bundles: guidance, skill:<name>, speckit (R10)
│   │   ├── bundle.test.ts
│   │   ├── payload.ts                   # bundle → the {system, chunks, tools} JSON contextops reads
│   │   ├── payload.test.ts
│   │   ├── invoke.ts                    # subprocess: fixed env, temp payload, --json-output, parse, cleanup
│   │   ├── invoke.test.ts               #   + the contract test against the pinned binary and `stability`
│   │   ├── map.ts                       # its report → our Finding[] (contextops/*) + Scorecard
│   │   ├── map.test.ts                  #   fixture-driven: recorded responses, no subprocess
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
│   │   ├── delegated.ts                 # DECLARATIONS ONLY for the 5 contextops/* rules — no check body
│   │   ├── delegated.test.ts            #   so --list-rules, --explain and the catalogue cover them (FR-047)
│   │   ├── structure.ts                 # structure/degenerate, structure/heading-skip (markdown shape)
│   │   ├── structure.test.ts
│   │   ├── contradiction.ts             # content/self-contradiction (mechanically decidable only)
│   │   ├── contradiction.test.ts
│   │   └── index.ts
│   ├── score/
│   │   ├── compose.ts                   # contextops score verbatim + our correctness count, side by side
│   │   ├── compose.test.ts
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
subdivided per Principle II into the six concerns the data model names — scope, artifact, rules, contextops,
score, report. The subdivision is not decoration, and each directory owns exactly one thing the others must not
touch: `scope/` is the only place that touches `git`, `artifact/` the only place that touches the filesystem,
`contextops/` the only place that knows the dependency exists, and `rules/` is therefore pure functions over
already-loaded artifacts. That is what lets all but the set-scoped rules be tested from in-memory fixtures
instead of temp trees, and what makes the dependency replaceable: swapping `contextops` for something else, or
for nothing, is a change to one directory and the five `contextops/*` rule declarations.

### Files changed outside the new project

| File                                | Change                                                                                                                                                                                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `package.json`                      | `@bluetel-ai/prompt-lint` in `devDependencies` (workspace); scripts `prompt-lint` (`tsx tooling/prompt-lint/src/cli.ts --all`) and `prompt-lint:diff` (`tsx tooling/prompt-lint/src/cli.ts`)                                                                                         |
| `knip.json`                         | `@bluetel-ai/prompt-lint` added to `ignoreDependencies`, exactly as `@bluetel-ai/qlty-diff` is — a root devDependency consumed only by a script is otherwise reported unused, and `knip:orphans` is a blocking CI step                                                               |
| `.github/workflows/ci.yml`          | two steps in the `main` job: make `contextops==0.3.3` available (`astral-sh/setup-uv`, or `pipx install`; plus a cache for `TIKTOKEN_CACHE_DIR` keyed on the pin), then `pnpm prompt-lint:diff "origin/$BASE_REF"`. And `prompt-lint` appended to the `nx affected -t …` target list |
| `.husky/pre-commit`                 | `pnpm prompt-lint:diff` after `pnpm typecheck`, before the qlty gate. It does **not** install `contextops` — unlike the qlty block directly below it, which does. See [R9](./research.md#r9) for why the two differ                                                                  |
| `README.md`                         | the prerequisite: what `prompt-lint` needs on `PATH`, and the three ways to provide it                                                                                                                                                                                               |
| `tooling/skills/project.json`       | a `prompt-lint` target scoping the validator to the catalog, so `nx affected` runs it whenever a skill changes                                                                                                                                                                       |
| `cspell.json`                       | any new identifiers the rule catalogue introduces (`contextops`, `frontmatter`, `tiktoken`, `uvx`, `pipx`) if not already accepted                                                                                                                                                   |
| `tooling/prompt-lint/baseline.json` | (new, inside the project) the measured adoption baseline — see [Adoption](#adoption-how-this-lands-without-breaking-every-open-pr)                                                                                                                                                   |

**Deliberately not changed**: `tooling/qlty-diff` (untouched — the two gates are independent), the skills
`catalog/` content (the real defects the prototype found are fixed in their own change, so the validator's diff
and its first findings do not arrive entangled), and `.agents/remote-workflow-instructions.md` (same reason —
and it is the file governing this run, so editing it here would be self-serving).

## Integration with the skills installer and the rest of the AI surface

The issue asked how this incorporates into the skills installer and the other AI code. There are five distinct
seams, and they are worth separating because they fail differently.

**0. The dependency itself (everywhere, before anything else).** `contextops==0.3.3` must be resolvable, or the
run exits `6` and says how to fix it — never a quiet pass with half the checks missing. CI makes it available in
a dedicated step so a failure there reads as "the environment is wrong", not "the prompts are wrong"; the
pre-commit hook reports rather than installs; and `PROMPT_LINT_CONTEXTOPS_BIN` exists for anyone who manages
Python their own way. Full resolution order and the reasoning in [research.md](./research.md#r9).

**1. The repo-wide gate (all AI code, blocking).** A root CI step, diff-scoped against the PR base, plus the
pre-commit hook. This is the seam that covers `AGENTS.md`, `CLAUDE.md`, `.claude/rules/*.md`, `.agents/*.md`,
`.specify/templates/*.md` and `.specify/memory/constitution.md` — none of which belong to any Nx project, so
`nx affected` structurally cannot see them. It is a separate step for the same reason `knip:orphans` is: the tool
is not Nx-aware and the condition is global. Set-scoped rules (drift) and the context bundles both need the whole
artifact set in memory even when the diff is one file, which `affected` cannot express — a skill's bundle
includes `AGENTS.md`, which is in no Nx project at all.

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
bundle without either breaking that constraint or being rewritten in POSIX shell. Taking a Python dependency
makes that route strictly worse, and adds a licence question on top: the Sustainable Use License permits internal
use but not redistribution as part of a commercial offering, so **nothing ever ships `contextops` anywhere** — a
target that wants the context-economy half installs it itself, under its own terms. The realistic path remains a
catalog skill whose procedure runs the checks an agent can perform unaided. The licence reading, and the note
that it needs a human rather than an agent to sign it off, are in [research.md](./research.md#r8).

## Adoption: how this lands without breaking every open PR

Measured against the tree at `ee740a3`:

| Rule                          | Existing violations                                                         | Ships as                                         | Promoted to `error` when                           |
| ----------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------- |
| `refs/dangling-path`          | 1 (`copywriting/references/natural-transitions.md:276` → `seo-audit` skill) | `error`                                          | immediately — fix the one defect in its own change |
| `skill/use-when-trigger`      | 10 (`speckit-*`, every one)                                                 | `warn`                                           | the ten descriptions have been rewritten           |
| `conventions/config-mismatch` | 1 (`.agents/remote-workflow-instructions.md` — `URM`, wrong repo slug)      | `warn`                                           | that file is corrected                             |
| `install/catalog-drift`       | 0 (verified: every installed skill matches its catalog source)              | `error`                                          | immediately                                        |
| `contextops/*` (all five)     | not yet measured — needs the first run against the pinned binary            | `warn`                                           | after the first measurement is reviewed            |
| everything else               | 0 or unmeasured                                                             | `error` unless the first full run says otherwise | —                                                  |

The five delegated rules ship at `warn` for a reason worth stating: **we do not control that scoring engine.**
A pinned version cannot move under us, but the first measurement is genuinely unknown until it is taken, and a
gate that starts blocking on someone else's thresholds before anyone has seen the numbers is how a team ends up
overriding a threshold in its first week. They are promoted the same way every other rule is — an edit to
`src/config.ts`, in its own reviewable change, after the numbers exist.

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

| Phase | Story | Delivers                                                                                                                                                                                 | Done when                                                                                                              |
| ----- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| A     | US1   | Project skeleton, `config.ts`, `scope/`, `artifact/`, `report/human.ts`, `rules/`: `meta/*`, `refs/dangling-path`, `skill/section-missing`, `template/placeholder-residue`; root scripts | A contributor runs `pnpm prompt-lint:diff` and gets correct findings on their own branch                               |
| B     | US2   | `gate.ts` thresholds + exit-code contract, `baseline.ts`, per-rule severity, CI step, pre-commit hook, `docs/rules.md` + its cross-check                                                 | A PR with one error-severity defect fails CI; the same PR without it passes                                            |
| C     | US3   | `install/*` rules, `meta/declared-dependency-missing`, `skill/use-when-trigger`, `conventions/config-mismatch`, the `prompt-lint` target on `tooling/skills`                             | A broken catalog entry cannot be pushed green                                                                          |
| D     | US4   | `contextops/` (locate, bundle, payload, invoke, map), the five `contextops/*` rule declarations, `score/compose.ts`, `report/json.ts`, `structure/*`, `content/self-contradiction`       | `pnpm prompt-lint --json` emits the full schema; the score and its four dimensions are reported per bundle and per run |

Phase A is the one that must be right; B–D are additive and each closes a story the spec ranked lower. Two things
about Phase D, stated here rather than discovered later:

- **The dependency lands whole, in one phase.** `locate` → `bundle` → `payload` → `invoke` → `map` is a single
  chain in which no link is useful alone, so splitting it across phases would ship a half-wired subprocess. It
  sits in D rather than A because the correctness half — the part that catches the defects the issue was actually
  about — must be shippable without Python on anyone's machine.
- **`minScore` is inert until Phase D**, because until then there is no score. The gate in Phases B and C decides
  on severity counts alone, and after D it still does unless someone sets a `minScore` from a measurement.

Not in any phase, and deliberately: `contextops diff`, `badge` and `telemetry`. All three now exist for free as
commands on a tool we already invoke, which is exactly why they should wait until someone wants them rather than
be wired speculatively.

## Complexity Tracking

| Violation                                                                     | Why Needed                                                                                                                                                                                                                                                         | Simpler Alternative Rejected Because                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch is `claude/issue-15-20260811-1041`, not `feature/<name>` (Principle V) | The branch was created by `.github/workflows/claude.yml` before this run began, and `.agents/remote-workflow-instructions.md` instructs the run to work on the `claude/*` branch the action provides. Nothing in the run can choose otherwise.                     | Renaming or re-branching mid-run would orphan the action's push target and the comment it updates. The constitution's branch rule predates the GitHub Action workflow and does not yet name agent-run branches; reconciling the two is its own amendment.                                   |
| A checked-in `baseline.json` of known violations                              | Ten `Use when:` violations and one stale-convention file exist today. Without a baseline the only options are "fail every open PR" or "do not ship the rule".                                                                                                      | Per-rule severity alone cannot express "blocks everywhere except these three known files", so a rule with one legacy violation would have to stay non-blocking for the whole repository. Stale-entry reporting is what stops the file becoming permanent.                                   |
| 11 rule modules rather than a handful of grouped checks                       | Principle II (single clear responsibility) and SC-007 (a rule is added by one self-contained change touching no existing rule). Colocated tests then land one suite per rule, which is what makes SC-004's fires/does-not-fire pair natural rather than bolted on. | Grouping rules into 5 large modules would make each module a monolith that every new rule edits — the exact shape SC-007 exists to prevent — and would put unrelated rules' tests in one file.                                                                                              |
| A Python tool in a pnpm/Nx workspace, required by CI and the hook             | Instructed: _"we were hoping to use this tool as a dependency dont re-write it"._ And correct on the merits — the alternative is hand-writing shingle clustering, a token approximation and a bespoke score, then owning their determinism forever.                | Reimplementing `contextops` in TypeScript is the thing the review rejected. `qlty` is already a non-Node binary that CI and `.husky/pre-commit` both require, so the shape is precedented rather than new.                                                                                  |
| A Sustainable-Use-licensed dependency (not OSI-approved)                      | It is the tool named in the issue and the one the review asked for. Internal CI use falls inside its grant — _"your own internal business operations"_ — and it is never shipped, vendored or installed onto anyone else's machine.                                | Vendoring the source would be redistribution under terms a client deliverable cannot meet. An MIT alternative measuring the same thing was not found, and writing one is the rejected option above. Human sign-off is still required before any client-facing use — [R8](./research.md#r8). |
| A blocking gate that depends on a third party's scoring engine                | The score is the half with an external referent; a number only we compute is comparable with nothing.                                                                                                                                                              | Mitigated rather than avoided: the version is pinned and asserted, the five delegated rules ship non-blocking, everything the dependency touches sits behind one adapter directory, and `--rules-only` runs the correctness half alone.                                                     |

### Divergences found while implementing (recorded 2026-08-17)

Two are corrections to this design, found by running it rather than by reading it. Both are in
`refs/dangling-path` and `skill/section-missing` — the two rules whose measured behaviour disagreed with
what the design predicted.

| Divergence                                                                                                                                                                                                 | Why the design was wrong                                                                                                                                                                                                                                                                                                                                                                         | What shipped instead                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **[R2](./research.md#r2)'s four rules do not produce R2's claimed result.** Implemented exactly as written they gave **80 findings, 70 of them `.specify/extensions.yml`** — against a claim of exactly 1. | R2 lists "runtime-created" as one of its four noise classes and names that very path as the example, but rules 1–4 cannot filter it: `.specify/` **is** a real directory, so rule 3 passes. The same gap admits `.specify/feature.json` ("Persist the resolved path to…"), `specs/003-user-auth` ("for example, …") and `.github/agents/` ("e.g. in …") — three more of R2's own stated classes. | A fifth rule: the reference is not reported when the line does not claim present-tense existence — an existence check, a creational verb, or an illustrative marker. **Lexical, not semantic**, the same bound `conventions/config-mismatch` works under. Result: **2 findings, both the one real defect** (catalog + installed copy), zero false positives. |
| **`skill/section-missing` fired on 8 installed reference documents.**                                                                                                                                      | The catalogue applies it to `IS`, and [data-model](./data-model.md#artifactkind) defines `installed-skill` as the whole installed tree — so the kind conflates a skill _body_ with the reference files it reads. A reference is prose to be consulted, not a procedure with a completion condition.                                                                                              | The rule requires the artifact to be a `SKILL.md`. The alternative — splitting `installed-skill` into body and reference kinds — is the better model and is left as a follow-up, because it changes `appliesTo` for every rule.                                                                                                                              |

A third divergence blocks Phase 6 and is **not** resolved here, because resolving it needs decisions this
run cannot make — see [the Phase 6 note](#phase-6-is-blocked-recorded-2026-08-17).

### Phase 4 divergences (recorded 2026-08-17)

Four came out of building US2. The first is a defect in the fix recorded above, which is the more
interesting kind of finding: the correction to R2 had its own bug, and only running the design's own
acceptance scenario surfaced it.

| Divergence                                                                                                                                                                                                                                               | Why                                                                                                                                                                                                                                                                                                                                              | What shipped                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Rule 5 silenced itself on the paths it most needed to report.** It tested the whole line, so `docs/does-not-exist.md` matched `exist` **inside its own filename**. Found by running quickstart Scenario 4, whose fixture is named `does-not-exist.md`. | Rule 5 asks what the surrounding _sentence_ claims, so the reference must not be part of the text it reads. The words at risk — exist, missing, absent, optional, created — are exactly the ones a placeholder filename uses. Masking _every_ path token then broke the `e.g.` exemption, because the scanner emits `e.g` as a token of its own. | Rule 5 reads the line with **candidate references only** blanked out. Regression tests for four such filenames, plus the case that the prose's own existence check still exempts a reference named `does-not-exist.md`. |
| **A malformed `baseline.json` has no exit code in [contracts/cli.md](./contracts/cli.md#exit-codes).**                                                                                                                                                   | A baseline that fails to load downgrades nothing, which over a red surface is indistinguishable from a clean pass. It is configuration, not a prompt defect.                                                                                                                                                                                     | Exit `3`, decided **before scope resolution**, so FR-036's "no artifact evaluated" holds. A missing file stays legitimate — an empty baseline is the state the file is working towards.                                 |
| **A baseline entry naming a bookkeeping rule is reported stale, not refused at load.**                                                                                                                                                                   | Such an entry exempts nothing, which _is_ the stale condition. Refusing the load would be exit `3` with no artifact evaluated — a report saying nothing about the prompts, over an entry that was already inert. Symmetric with how `applySuppressions` treats an unknown rule id.                                                               | A third stale message, alongside "reported nothing" and "not a registered rule".                                                                                                                                        |
| **[R9](./research.md#r9)'s premise is stale.** It cites the qlty pre-commit block as installing on demand, and contrasts `prompt-lint` with it.                                                                                                          | That variant is not on this branch. It lives on `feature/oxlint-vscode-settings` and was reverted; what landed requires qlty preinstalled. Verified with `git merge-base --is-ancestor` against all four candidate commits.                                                                                                                      | Both gates now behave identically — report, never install. The hook comment claims only that `prompt-lint` installs nothing, which is true either way.                                                                  |

Three smaller notes, none of which changed a decision:

- **`nx affected -t prompt-lint` is inert today.** T046 asked for the target to be appended to the
  affected list, and it was, but `nx show projects --with-target prompt-lint` returns `[]` until T056
  adds the target in Phase 5. The CI comment describing it as the push-event coverage is therefore
  forward-looking rather than currently true.
- **[data-model](./data-model.md) calls the stale-baseline finding `stale-baseline`.** No such rule id
  exists. `suppression/stale`'s registry statement already names baseline entries, and that is what the
  code reuses — the data-model wording is the loose one.
- **The hook uses `prompt-lint:diff`, not `--staged`,** per T047 and
  [contracts/cli.md](./contracts/cli.md)'s integration table, though FR-043's prose says "staged".
  Behaviourally equivalent here, because `listChangedFiles` folds in the index and untracked files. The
  cost is that the hook needs `origin/main` resolvable — exactly as the `qlty:diff` line beside it
  already does.

### Phase 5 divergences and the T058 measurement (recorded 2026-08-17)

The measured surface, all 17 rules, `pnpm prompt-lint --all --no-baseline`, over 93 artifacts:

| Rule                           | Measured  | [Adoption table](#adoption-how-this-lands-without-breaking-every-open-pr) predicted | Encoded as                                 |
| ------------------------------ | --------- | ----------------------------------------------------------------------------------- | ------------------------------------------ |
| `template/placeholder-residue` | 47 errors | not measured                                                                        | 17 baseline entries                        |
| `skill/section-missing`        | 23 errors | not measured                                                                        | 23 baseline entries                        |
| `skill/use-when-trigger`       | 20 warns  | 10                                                                                  | ships `warn`, under the 50 threshold       |
| `conventions/config-mismatch`  | 3 warns   | 1                                                                                   | ships `warn`, under the 50 threshold       |
| `refs/dangling-path`           | 2 errors  | 1                                                                                   | **not baselined** — fixed by T086          |
| `meta/*` (5 rules)             | 0         | 0                                                                                   | —                                          |
| `install/*` (3 rules)          | 0         | 0 (drift verified)                                                                  | `version-bump` not evaluated under `--all` |

**Three predictions were low, and each for the same structural reason: the installed tree doubles a
finding.** `skill/use-when-trigger` applies to `catalog-meta` **and** `agent-pointer`, and the pointer
descriptions are byte-identical copies, so ten offending descriptions produce twenty findings.
`refs/dangling-path`'s single defect has its installed copy, which is the design's own point about
publication. `conventions/config-mismatch`'s "1 pre-existing violation" is one _file_ but three
(line, value) pairs. None of these is a rule behaving wrongly; the counting unit in the adoption table
was files, and the gate counts findings.

[contracts/rules.md](./contracts/rules.md) says `skill/use-when-trigger` has "10 pre-existing
violations" while its own `Applies to` line lists CM **and** AP. Those two statements cannot both hold.
`appliesTo` was followed, because narrowing the rule to `catalog-meta` would leave the pointer —
the file an agent reads first when deciding whether a skill applies — unchecked, which is the rule's
entire purpose.

**One defect found by measuring, in a Phase 3 rule.** `template/placeholder-residue` reported
`$ARGUMENTS` in six `speckit-*` skill bodies. The contract says the rule covers "`$ARGUMENTS` **outside
the one slot where it is meaningful**" and the qualifier had not been implemented — so the rule was
asking six skills to delete the mechanism by which they receive their arguments. The slot is now
recognised structurally: `$ARGUMENTS` as the last token on its line, preceded by nothing or a `label:`.
Used mid-sentence it is still reported, because there it genuinely is ambiguous with prose. 53 → 47.

**Why the two large counts are baselined and the two `warn` rules are not.** The plan's own division
holds: severity handles "this rule is not ready to block anywhere", the baseline handles "this rule
blocks, except for these named files". `use-when-trigger` and `config-mismatch` already ship `warn` by
`defaultSeverity`, and 23 warnings sit under the threshold of 50 — so T058's instruction to add them to
`severities` would have written a no-op, and baselining them would make their later promotion to `error`
a two-step edit instead of one. They stay visible and non-blocking, which is what "ships as `warn`"
means. The 40 baseline entries cover only the two rules that ship `error` with a pre-existing surface.

`refs/dangling-path` is deliberately **not** baselined: the adoption table says "promoted to `error`
immediately — fix the one defect in its own change", and that is T086. Until it lands, a whole-surface
run is red with exactly those two findings, which is the intended state rather than an oversight.

**One defect found by running the gate the way CI runs it.** With the baseline populated, a
diff-scoped run reported all 40 entries as `suppression/stale`. Staleness is a claim about a
file, and it can only be made about a file that was read — under `--diff` and `--staged` the
targets are the changed artifacts, so every entry protecting an untouched file matched nothing
and was reported stale. That is on the exact code path CI and the pre-commit hook take, and it
told contributors to delete entries protecting files their branch never touched. `applyBaseline`
now takes the evaluated paths: an out-of-scope entry is neither applied nor stale, because
nothing was learned about it. An entry naming an unregistered rule is still reported at any
scope, since that is not a claim about a file. Found only because T086 made the surface clean
enough to read the footer.

Two smaller notes:

- **T058 asked for `severities` entries that would be inert.** Recorded above rather than written.
- **The gate's default baseline is this package's own file**, resolved from the module. Once populated,
  every gate test driving a temporary repository saw all 40 entries as stale. The suite now points its
  fixtures at a path that does not exist, which `loadBaseline` treats as an empty baseline. Worth knowing
  before FR-045's deferred target-project adoption: a baseline resolved from the tool rather than from the
  repository under evaluation is the wrong default for any repository but this one.

## Phase 6: the two blockers and how they were resolved (recorded 2026-08-17)

### T060 — licence sign-off: **GRANTED**

Harry Twigg (ht@bluetel.co.uk), who holds the authority to make it, signed off the
[R8](./research.md#r8) reading on 2026-08-17: `contextops` may be used under the Sustainable Use License
for this repository's own CI and pre-commit gate. This resolves the `PASS*` on the
_Dependency Standards — external_ gate for internal use.

The stance R8 records is unchanged and is what keeps the grant sufficient: **`prompt-lint` never installs,
vendors or ships `contextops` anywhere.** It invokes one that is already present and says so when it is not.
A target project that wants the context-economy half installs the dependency under its own terms — which is
route (4) in R8, and the only one that keeps the question where it belongs. Anything client-facing built on
it is a separate decision, not covered by this one.

### FR-050's version assertion — **revised, because the tool cannot satisfy it**

The design says: assert `contextops --version` equals the pin, exit `6` on mismatch. Measured, **no route
reports the pinned version** — `--version` answers `0.1.0` for every distribution and the JSON report's
`metadata.version` answers `0.3.0`. Implemented literally, the assertion fails 100% of correctly-installed
runs.

**Decision (directed 2026-08-17): trust the pin, not the self-report.** The pin moves into the _invocation_
rather than into a post-hoc check:

- Resolution pins the distribution — `uvx --from contextops==0.3.3 contextops`, `pipx run
contextops==0.3.3` — so the resolver guarantees which code runs. That is a **stronger** guarantee than
  asking the binary, because it constrains what executes rather than believing what it says afterwards.
- `--version` is still called, but treated as **advisory**: it proves the binary is executable and is
  recorded in the report as `selfReported` beside the pin. It never fails the run.
- `analyser.version` in the report is the pin — the version that was requested and resolved — with the
  self-reported string carried alongside so the discrepancy is visible rather than smoothed over.
- Exit `6` still fires for the failures that are real: the binary cannot be found, cannot be executed, or a
  payload run fails.
- The `PROMPT_LINT_CONTEXTOPS_BIN` route cannot pin anything, since it names an arbitrary executable. It is
  documented as the one route where the operator owns the version, and the report names it as the resolver.

What is lost is honest to state: a `PATH`-resolved `contextops` of the wrong version can no longer be
detected. What FR-050 actually protects — "the score stops being comparable between machines" — is preserved
for the `uvx`/`pipx` routes CI uses, and CI uses those.

`0.3.4` is also published. The pin stays `0.3.3` because every document here names it; moving it is a
one-line edit to `src/config.ts` plus a re-measurement, per the same rule as any other threshold.

### The remaining divergence — the report shape

Measured on 2026-08-17 with
`uvx --from contextops==0.3.3`. The CLI surface [R9](./research.md#r9) and [R10](./research.md#r10) assume is
real — `inspect --json-output --model --config --profile agent`, plus `check`, `stability`, `diff`. What
differs:

| The design expects                          | `0.3.3` emits                                                                                                                | Consequence                                                                                                                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--version` equal to the pin (FR-050, T061) | `contextops, version 0.1.0` for **every** distribution — 0.3.3 and 0.3.4 alike. `metadata.version` says `0.3.0`              | **No route reports `0.3.3`.** "Assert `--version` equals the pin, else exit 6" fails 100% of correctly-installed runs, and report-schema invariant 9 is unsatisfiable as written          |
| `dimensions: Record<dim, {penalty, max}>`   | `score_breakdown: {redundancy_penalty, …}` — floats, **no maxima in the response**                                           | Asserting maxima 30/30/20/20 can only compare against a constant we hold, so it cannot detect the engine changing them                                                                    |
| `tokenBreakdown.byItem`                     | `token_breakdown.by_type` only — **no per-item counts**                                                                      | `contextops/concentration` cannot name the artifact that dominates a bundle — the design's own worked example. `tokenBudgets.artifact` (FR-024) and `Artifact.tokens` are unimplementable |
| `findings[].items` naming payload items     | `findings` keyed by dimension, entries carry `{issue, type, actual_ratio, threshold, severity, confidence}` — **no `items`** | T065's "translate `findings[].items` back to artifact paths" has no input                                                                                                                 |

Also `density_effect: "shadow"` in 0.3.3, so the density penalty may not reach the score at all.

**Decision (directed 2026-08-17): build it against what the tool returns, and never attribute our own
measurement to it.** The mapping is adjusted rather than the requirement dropped, one rule at a time:

| Rule                             | What ships                                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contextops/redundancy`          | Driven by `findings.redundancy[]` verbatim. Reported at bundle level.                                                                                                                                                                                                                                                        |
| `contextops/density`             | Driven by `findings.density[]` plus `token_breakdown.wasted_tokens`. **`density_effect: "shadow"` is stated in the report**, because a rule whose penalty may not reach the score must not look like one that does.                                                                                                          |
| `contextops/structure-imbalance` | Driven by `findings.structure[]`, which carries `actual_ratio` and `threshold` — enough to say "the system prefix is 100% of this bundle against a 40% threshold", which is exactly the intended finding.                                                                                                                    |
| `contextops/token-budget`        | **Per bundle** from `token_breakdown.total_tokens`, as designed. The **per-artifact** half (FR-024, `tokenBudgets.artifact`) cannot come from the analyser and is **not faked**: it is reported as `notEvaluated` with that reason, and `tokenBudgets.artifact` is dropped from `config.ts` until the tool can populate it.  |
| `contextops/concentration`       | Fires from the analyser's `concentration_penalty`. It **cannot name the dominating artifact from the analyser**, so where it needs a location it reports the bundle and, as a clearly-labelled aid, that artifact's share of the bundle's **characters** — our measurement, named as ours, never presented as a token count. |

Two invariants are kept exactly: the **score passes through verbatim** (no re-weighting, no blend), and the
dimension maxima are asserted against the 30/30/20/20 constants we hold — with a comment recording that the
response publishes no maxima, so the assertion cannot detect the engine changing them. `Artifact.tokens` stays
`null` and is documented as such rather than being filled with an approximation, which is the decision
[R5](./research.md#r5) already made once.

The through-line: where the tool can answer, it answers and we pass it through; where it cannot, we say so in
`notEvaluated` rather than substituting a number of our own and letting the report imply the analyser produced
it. That is the failure [R10](./research.md#r10) is most concerned about, and it is avoided by labelling rather
than by omission.

The adapter boundary did its job: nothing in Phases 1–5 imports or invokes the analyser, so all of this was
contained in work not yet started.

## Post-Design Constitution Re-check

Re-evaluated after Phase 1 ([data-model.md](./data-model.md), [contracts/](./contracts/),
[quickstart.md](./quickstart.md)), and again after the dependency revision. All seven gates still PASS, with the
two recorded deviations. Four things the design surfaced that the pre-Phase-0 check had not yet confirmed:

- **Principle II held under pressure.** The reference-resolution algorithm (research R2) wanted access to git, to
  the filesystem and to parsed markdown at once, which would have collapsed `scope/`, `artifact/` and `rules/`
  into one module. It is instead expressed as a pure function over an artifact plus a pre-built path index that
  `scope/` hands it — so `rules/` stayed pure and `references.test.ts` needs no temp tree.
- **Principle IV's duplication risk is now concrete, not speculative.** `defineRule` and the shared fixture
  builders are load-bearing for the gate, so they are Phase A work rather than a later cleanup.
- **Principle III is satisfiable for every module in the tree above** — checked module by module; no behavioural
  module in the planned layout lacks a colocated suite, and no suite exists without its module. The only files
  without one are the seven `index.ts` barrels, per the exemption stated in the Constitution Check above.
- **Principle II is what makes the dependency survivable.** The barrel rule forced `contextops/` to be a directory
  with one exported surface rather than subprocess calls scattered through `rules/`. That is the difference
  between "we depend on `contextops`" and "we are entangled with `contextops`", and it is the reason the
  Dependency Standards gate passes on a tool nobody in this workspace controls. The revision made the design
  smaller: four modules and their suites left the tree, five joined it, and the net is one fewer module and
  several hundred fewer lines of algorithm we would have had to keep correct.
