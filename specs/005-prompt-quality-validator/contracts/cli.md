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
| `--rules-only`           | Run this repository's rules alone; skip `contextops` entirely (FR-053)                                 | both halves run         |
| `--bundle=<id>`          | Restrict the delegated half to one context bundle (`guidance`, `skill:review`, `speckit`)              | every bundle in scope   |

`--rules-only` exists for two real situations — a contributor without Python who wants the correctness findings
now, and investigating a slow run — and for neither of them is it a way to pass. It reports every delegated rule
as **not evaluated**, names itself in the report header, and is rejected outright when `minScore > 0` (exit `3`).
CI does not pass it; a pull request whose gate ran with it is a pull request whose gate did not run.

`--all`, `--staged` and a positional base ref are mutually exclusive; passing two is a usage error (exit 2), not a
silently-resolved precedence. Unknown flags are a usage error — never ignored, because an ignored `--json` in CI
looks like a tool that produces the wrong output rather than one that was called wrong.

## Environment overrides

Every threshold in `src/config.ts` carries a documented `[PROMPT_LINT_*]` override, following the `QLTY_*`
convention in `tooling/qlty-diff/src/config.ts`. **These exist for local investigation only and must not be used
to pass CI** (FR-034, Constitution Principle IV). Any override in effect is named in the report header, so a
passing CI log cannot conceal a relaxed threshold.

| Variable                     | Overrides                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `PROMPT_LINT_MAX_ERRORS`     | `config.maxErrors`                                                             |
| `PROMPT_LINT_MAX_WARNINGS`   | `config.maxWarnings`                                                           |
| `PROMPT_LINT_MIN_SCORE`      | `config.minScore`                                                              |
| `PROMPT_LINT_BASE_REF`       | `config.defaultBaseRef`                                                        |
| `PROMPT_LINT_CONTEXTOPS_BIN` | Path to the `contextops` executable — first in the resolution order of R9      |
| `TIKTOKEN_CACHE_DIR`         | Read, not owned: passed through to the subprocess so a cold machine has a home |

There is deliberately **no** environment override for a per-rule severity or for the exclusion list. Those change
what is checked rather than how strictly, and FR-034/SC-009 require such a change to appear in a diff.

**`PROMPT_LINT_CONTEXTOPS_BIN` is the exception that proves the rule**: it changes _where_ the analyser is found,
never _which version counts_. The pinned version in `src/config.ts` is asserted against whatever it resolves to,
so pointing it at a different build fails the run rather than silently rescoring the repository. There is no
environment override for the pin itself.

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
| `6`  | The external analyser is unavailable, is the wrong version, or failed on a payload (FR-051)      |

The distinction between `1` and `3`/`4`/`5`/`6` is the point: a red CI step must be attributable to "the prompts
are wrong" versus "the tool could not run". Exit `4` in particular exists because a shallow checkout silently
evaluating zero artifacts and exiting `0` is the failure this contract most needs to prevent (US2 scenario 5).

Exit `6` exists for the same reason one level out, and its message is part of the contract — a bare "command not
found" would be a worse failure than the one it replaces:

```text
prompt-lint: contextops 0.3.3 is required and was not found.

  It computes the redundancy, density, structure and concentration measurements and the
  health score. Without it those checks cannot run, and prompt-lint will not report a pass
  on the ones that did.

  Provide it in any one of these ways:
    uv      — install uv (https://docs.astral.sh/uv/); prompt-lint will run `uvx contextops@0.3.3`
    pipx    — pipx install contextops==0.3.3
    pip     — pip install contextops==0.3.3   (in a virtualenv; needs Python >= 3.10)
    explicit — PROMPT_LINT_CONTEXTOPS_BIN=/path/to/contextops

  Or run the repository's own rules alone, which is not a substitute for the gate:
    pnpm prompt-lint:diff --rules-only

  contextops is licensed under the Sustainable Use License. prompt-lint does not install it
  for you — that is your decision to make. https://github.com/Abhijeet777ui/contextops
```

The version-mismatch variant names both versions, and the payload-failure variant names the bundle and quotes
the analyser's own stderr. Neither ever downgrades to a warning: a score from an unpinned engine is not
comparable with the last one, and an unscored bundle reported as clean is a lie the report would be telling.

## Human output shape

Verdict first, then counts, then findings, then the score block. Modelled on `qlty:diff`'s summary so the two
gates read alike in a CI log.

```text
prompt-lint (diff vs origin/main): 6 artifacts, 2 excluded, 2 bundles
  errors:   1  (max 0)
  warnings: 3  (max 50)
  notes:    2
  context:  74/100 mean  (contextops 0.3.3, gpt-4o, profile agent)
              redundancy 22/30 · density 19/30 · structure 18/20 · concentration 15/20
              skill:review 71 (18,402 tok) · guidance 78 (6,110 tok)

✖ refs/dangling-path
    tooling/skills/catalog/copywriting/references/natural-transitions.md:276
    References `references/ai-writing-detection.md`, which does not exist relative to this
    artifact, its skill root, or the repository root. No `seo-audit` skill exists in the catalog.
    → Point at an existing reference, or remove the sentence. If the file is created at runtime,
      suppress with a reason: <!-- prompt-lint-disable-next-line refs/dangling-path — … -->

⚠ contextops/concentration                                    [bundle skill:review]
    tooling/skills/catalog/review/references/subagent-template.md
    Accounts for 61% of this skill's context (11,224 of 18,402 tokens). One document dominating
    a bundle means the procedure competes with it for attention.
    → Split it, or move the part the procedure does not always need behind a step that reads it.

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
- Paths are repo-relative; no timestamps, no absolute paths, no run duration (FR-039, SC-005). The temp payload
  path handed to the analyser never appears.
- When scope is empty the body is replaced by one line — `no AI-authored artifacts in scope` — and the exit is `0`
  (FR-040). It must not be possible to confuse that with a clean pass over a populated set.
- The score block is absent entirely before Phase D, whenever the artifact set is empty (FR-030), and under
  `--rules-only` — where it is replaced by an explicit `context: not evaluated (--rules-only)` line and every
  delegated rule is listed as not evaluated. Absence is always stated, never merely absent.
- The score line names the analyser, its version, the encoding and the profile. A number whose engine is not
  identified cannot be compared with the number in the last report, which is most of what a score is for.
- A delegated finding is tagged with its bundle, because its location is a relationship rather than a line.

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

CI runs a separate preceding step that makes `contextops==0.3.3` available and restores the `TIKTOKEN_CACHE_DIR`
cache. Keeping it a distinct step is the point: when it fails, the log says the environment is wrong rather than
implying the prompts are.
