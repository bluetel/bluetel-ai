# Contract: `prompt-lint` command surface

**Feature**: [../spec.md](../spec.md) | **Plan**: [../plan.md](../plan.md) | **Date**: 2026-08-11

The CLI is the only interface this feature exposes; there is no HTTP surface and no importable API beyond the
barrel's `runPromptLintGate`. This document is the contract, and it is what the CLI tests assert against.

## Invocation

```sh
# From the repository root (the normal path)
pnpm prompt-lint:diff                  # diff vs config.defaultBaseRef (origin/main)
pnpm prompt-lint:diff origin/staging   # diff vs an explicit base ref
pnpm prompt-lint                       # whole repository (--all)

# From the project directory (Principle I — runnable in isolation)
pnpm exec tsx src/cli.ts --all

# Through Nx (the catalog-scoped target on tooling/skills)
pnpm nx run skills:prompt-lint
```

Mirrors `qlty:diff` exactly: the first positional argument is the base ref, `--all` switches to whole-repository
scope. That symmetry is deliberate — see [../plan.md](../plan.md#summary).

## Arguments and flags

| Argument / flag          | Effect                                                                                                 | Default                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | ----------------------- |
| `<baseRef>` (positional) | Diff scope: evaluate artifacts changed vs this ref                                                     | `config.defaultBaseRef` |
| `--all`                  | Evaluate every artifact in the declared set; ignores `<baseRef>`                                       | off                     |
| `--staged`               | Evaluate the staged set — the pre-commit path (FR-043)                                                 | off                     |
| `--scope=<name>`         | Restrict to one named subset of the declared locations (`catalog`, `installed`, `guidance`, `speckit`) | all locations           |
| `--json`                 | Emit the machine-readable report instead of the human one (FR-038)                                     | human output            |
| `--list-rules`           | Print the rule catalogue (id, severity, statement) and exit 0 — no artifacts evaluated (FR-006)        | off                     |
| `--explain=<ruleId>`     | Print one rule's statement, rationale, applicable kinds and fix guidance, then exit 0                  | off                     |
| `--no-baseline`          | Ignore `baseline.json` — shows the true state of the surface without failing anyone's build            | baseline applied        |
| `--max-findings=<n>`     | Cap the human-readable list; the omitted count is always stated (FR-037)                               | 25                      |

`--all`, `--staged` and a positional base ref are mutually exclusive; passing two is a usage error (exit 2), not a
silently-resolved precedence. Unknown flags are a usage error — never ignored, because an ignored `--json` in CI
looks like a tool that produces the wrong output rather than one that was called wrong.

## Environment overrides

Every threshold in `src/config.ts` carries a documented `[PROMPT_LINT_*]` override, following the `QLTY_*`
convention in `tooling/qlty-diff/src/config.ts`. **These exist for local investigation only and must not be used
to pass CI** (FR-034, Constitution Principle IV). Any override in effect is named in the report header, so a
passing CI log cannot conceal a relaxed threshold.

| Variable                   | Overrides               |
| -------------------------- | ----------------------- |
| `PROMPT_LINT_MAX_ERRORS`   | `config.maxErrors`      |
| `PROMPT_LINT_MAX_WARNINGS` | `config.maxWarnings`    |
| `PROMPT_LINT_MIN_SCORE`    | `config.minScore`       |
| `PROMPT_LINT_BASE_REF`     | `config.defaultBaseRef` |

There is deliberately **no** environment override for a per-rule severity or for the exclusion list. Those change
what is checked rather than how strictly, and FR-034/SC-009 require such a change to appear in a diff.

## Exit codes

A stable contract, in the spirit of `skills.sh`'s documented codes. Callers may branch on these.

| Code | Meaning                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------ |
| `0`  | Within thresholds — including the "nothing in scope" case, which says so explicitly (FR-040)     |
| `1`  | A threshold was breached: too many errors or warnings, or (Phase D) a score below `minScore`     |
| `2`  | Usage error — unknown flag, mutually exclusive flags, unknown `--scope` or `--explain` target    |
| `3`  | Configuration invalid — contradictory or unparseable; **no artifact was evaluated** (FR-036)     |
| `4`  | Scope could not be established — base ref unresolvable, not a git repository (FR-032)            |
| `5`  | Internal failure — a rule threw. The rule and artifact are named; never reported as a clean pass |

The distinction between `1` and `3`/`4`/`5` is the point: a red CI step must be attributable to "the prompts are
wrong" versus "the tool could not run". Exit `4` in particular exists because a shallow checkout silently
evaluating zero artifacts and exiting `0` is the failure this contract most needs to prevent (US2 scenario 5).

## Human output shape

Verdict first, then counts, then findings, then the score block. Modelled on `qlty:diff`'s summary so the two
gates read alike in a CI log.

```text
prompt-lint (diff vs origin/main): 6 artifacts, 2 excluded
  errors:   1  (max 0)
  warnings: 3  (max 50)
  notes:    2
  score:    87/100  (correctness 34/40, redundancy 23/25, density 18/20, structure 12/15)

✖ refs/dangling-path
    tooling/skills/catalog/copywriting/references/natural-transitions.md:276
    References `references/ai-writing-detection.md`, which does not exist relative to this
    artifact, its skill root, or the repository root. No `seo-audit` skill exists in the catalog.
    → Point at an existing reference, or remove the sentence. If the file is created at runtime,
      suppress with a reason: <!-- prompt-lint-disable-next-line refs/dangling-path — … -->

⚠ skill/use-when-trigger
    tooling/skills/catalog/speckit-plan/skill.meta:3
    `description` has no `Use when:` clause, so the agent cannot tell when this skill applies.
    → Append `Use when: <situation>` to the description.  [baselined: pre-existing at adoption]

  …and 2 more (raise with --max-findings)

suppressions: 3 used, 0 stale     baseline: 10 applied, 1 stale
✖ thresholds breached — see above
```

Rules for this output, each traceable to a requirement:

- The verdict line is the **first and last** thing printed, because CI logs are read from both ends.
- Every finding prints `what is wrong` and a `→ what to do`, and the remediation is never omitted (FR-007, SC-006).
- The list is capped and the omission is counted, never silent (FR-037).
- Paths are repo-relative; no timestamps, no absolute paths, no run duration (FR-039, SC-005).
- When scope is empty the body is replaced by one line — `no AI-authored artifacts in scope` — and the exit is `0`
  (FR-040). It must not be possible to confuse that with a clean pass over a populated set.
- The score block is absent entirely before Phase D and absent whenever the artifact set is empty (FR-030).

## `--json` output

Full schema in [report.schema.md](./report.schema.md). Contract properties: one JSON object on stdout, nothing
else on stdout (diagnostics go to stderr), every field the human output showed plus the thresholds and the
suppression/baseline bookkeeping, and byte-identical across runs over an identical tree.

## Integration invocations

| Caller                                  | Invocation                                      | Failure means                                       |
| --------------------------------------- | ----------------------------------------------- | --------------------------------------------------- |
| `.husky/pre-commit`                     | `pnpm prompt-lint:diff`                         | Commit blocked, before the qlty gate                |
| `.github/workflows/ci.yml` (`main` job) | `pnpm prompt-lint:diff "origin/$BASE_REF"`      | Pull request not mergeable (FR-042)                 |
| `nx affected`                           | `nx run skills:prompt-lint` (`--scope=catalog`) | A changed skill breaks a catalog invariant (FR-044) |
| An agent                                | `pnpm prompt-lint --json`                       | Consumed as data, not as a gate (FR-038)            |
