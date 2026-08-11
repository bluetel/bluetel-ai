# Quickstart: validating the prompt-quality validator

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-08-11

How to prove the feature works, end to end, once it is implemented. Every scenario below maps to a spec acceptance
scenario or success criterion, and each is runnable by hand — a reviewer should be able to work down this page and
reach a verdict without reading the implementation.

Nothing here is implementation code; the rule bodies and their unit suites belong to `tasks.md` and the
implementation phase.

## Prerequisites

```sh
pnpm install --frozen-lockfile
git fetch origin main          # the diff-scoped runs need a resolvable base ref
```

No `qlty`, no network, no credentials, no model access. If any scenario below needs one of those, the
implementation has diverged from FR-046.

## Scenario 1 — The tool runs and describes itself (FR-006, FR-047)

```sh
pnpm prompt-lint --list-rules
pnpm prompt-lint --explain refs/dangling-path
```

**Expect**: 23 rules listed with id, ships-as severity and one-line statement; the `--explain` output gives the
statement, rationale, applicable kinds and the fix. Exit `0` in both cases, no artifacts evaluated.

**Fails if**: any rule prints an empty statement or rationale — `rules/registry.test.ts` should have caught that
before you got here (SC-010).

## Scenario 2 — Whole-repository run over the real surface (US4, SC-002, SC-003)

```sh
time pnpm prompt-lint
```

**Expect**: ~140 artifacts evaluated in well under 30 seconds. A score out of 100 with all four dimensions shown.
Exactly the findings the adoption table in [plan.md](./plan.md#adoption-how-this-lands-without-breaking-every-open-pr)
predicts — most importantly **one** `refs/dangling-path` error at
`tooling/skills/catalog/copywriting/references/natural-transitions.md:276`, and no other error-severity finding
that is not either fixed or baselined.

**Fails if**: `refs/dangling-path` reports more than the known instance. That is the false-positive condition
research [R2](./research.md#r2) exists to prevent, and SC-011 forbids reaching adoption with it unresolved.

## Scenario 3 — Deterministic output (FR-029, FR-039, SC-005)

```sh
pnpm prompt-lint --json > /tmp/a.json
pnpm prompt-lint --json > /tmp/b.json
diff /tmp/a.json /tmp/b.json && echo "byte-identical"

# and the property that makes it portable
grep -c "$(pwd)" /tmp/a.json || echo "no absolute paths — correct"
```

**Expect**: `byte-identical`, and zero occurrences of the absolute working directory. Also check by eye that there
is no timestamp and no duration field.

## Scenario 4 — A contributor's broken edit is caught locally (US1, all five scenarios)

Work on a scratch branch so nothing here is committed.

```sh
git switch -c scratch/prompt-lint-validation

# (1) a dangling reference, inside a directory that really exists
printf '\nSee `references/does-not-exist.md` for the rest.\n' \
  >> tooling/skills/catalog/review/SKILL.md

# (2) content changed with no version bump
#     (the edit above is the content change; skill.meta is left alone)

# (3) a required field removed
sed -i.bak '/^description=/d' tooling/skills/catalog/merging/skill.meta

pnpm prompt-lint:diff origin/main
```

**Expect** exit `1`, and three findings: `refs/dangling-path` at the new line in `review/SKILL.md`,
`install/version-bump` naming `review`'s current version, and `meta/required-field` on
`merging/skill.meta`. Each names a file, a line, a rule and a `→` fix (US1 scenarios 1, 2, 5).

Then check the two negative cases:

```sh
git stash                                   # restore the tree
echo '// noise' >> tooling/qlty-diff/src/parse.ts
pnpm prompt-lint:diff origin/main           # US1 scenario 3
```

**Expect**: exit `0` with `no AI-authored artifacts in scope` — explicitly, not an empty report (FR-040).

And the deletion case (US1 scenario 4):

```sh
git checkout . && rm tooling/skills/catalog/review/references/diff-scope.md
pnpm prompt-lint:diff origin/main
```

**Expect**: a `refs/dangling-path` finding against `review/SKILL.md` and
`review/references/subagent-template.md` — artifacts the diff did **not** touch. This is the
`targets` vs `universe` distinction in [data-model.md](./data-model.md#scope-and-configuration); if it reports
nothing, the rule is running over the wrong set.

Clean up: `git checkout . && git switch - && git branch -D scratch/prompt-lint-validation`.

## Scenario 5 — The gate blocks a pull request, and only for the right reason (US2, SC-008)

```sh
pnpm prompt-lint:diff "origin/main"; echo "exit=$?"
```

Verify the exit-code contract from [contracts/cli.md](./contracts/cli.md#exit-codes) by provoking each code:

| Provoke                                | Command                                       | Expect exit |
| -------------------------------------- | --------------------------------------------- | ----------- |
| Clean tree                             | `pnpm prompt-lint:diff`                       | `0`         |
| One error-severity defect (Scenario 4) | `pnpm prompt-lint:diff`                       | `1`         |
| Unknown flag                           | `pnpm prompt-lint --nope`                     | `2`         |
| Mutually exclusive scopes              | `pnpm prompt-lint --all --staged`             | `2`         |
| Contradictory config                   | `PROMPT_LINT_MIN_SCORE=101 pnpm prompt-lint`  | `3`         |
| Unresolvable base ref                  | `pnpm prompt-lint:diff origin/does-not-exist` | `4`         |

The `4` case is the one to test deliberately: it is US2 scenario 5, and the whole point is that a shallow CI
checkout must **fail** rather than evaluate zero artifacts and pass. The message must name the ref.

**Also verify the override is visible**:

```sh
PROMPT_LINT_MAX_WARNINGS=9999 pnpm prompt-lint | head -5
```

**Expect**: the header names `PROMPT_LINT_MAX_WARNINGS` as an override in effect (FR-034). A CI log must never be
able to look clean under relaxed thresholds.

## Scenario 6 — A skill cannot be published broken (US3, FR-044)

```sh
pnpm nx run skills:prompt-lint          # the catalog-scoped target
pnpm nx test skills                     # the existing shell contract still passes
```

Then break each catalog invariant in turn and confirm exactly one rule fires per break:

| Break                                             | Expect                             |
| ------------------------------------------------- | ---------------------------------- | ---------------------------------- |
| `assets=nonexistent` in a `skill.meta`            | `meta/declared-dependency-missing` |
| `next_step=do a thing` (no `                      | why`)                              | `meta/declared-dependency-missing` |
| `version=1.0` in a `skill.meta`                   | `meta/version-semver`              |
| Edit `.agents/skills/review/SKILL.md` only        | `install/catalog-drift`            |
| Change a pointer's frontmatter `description`      | `install/pointer-mismatch`         |
| Delete a skill body's completion-criteria section | `skill/section-missing`            |

**Expect**: one rule per break, naming both paths for the two set-scoped ones (US3 scenarios 1–5).

## Scenario 7 — Suppressions and the baseline behave (FR-009, FR-010, FR-035)

```sh
# an unreasoned suppression is itself a finding
printf '\n<!-- prompt-lint-disable-next-line refs/dangling-path -->\nSee `references/nope.md`.\n' \
  >> tooling/skills/catalog/review/SKILL.md
pnpm prompt-lint --all
```

**Expect**: `suppression/unreasoned` at `error`, and the dangling reference still reported — an exemption nobody
justified does not exempt anything.

Add the reason (`… refs/dangling-path — created at runtime by step 3 -->`) and re-run: both findings gone,
`suppressions: 1 used` in the footer.

```sh
# the baseline drains rather than accumulating
pnpm prompt-lint --all --no-baseline    # the true state of the surface
pnpm prompt-lint --all                  # the gated state
```

**Expect**: the first shows the 10 `skill/use-when-trigger` warnings and the stale-convention finding; the second
shows them as `note` with `baselined: true` and reports `baseline: 10 applied`. Fix one `Use when:` description
without removing its baseline entry and re-run: that entry is reported **stale** (FR-010), which is the mechanism
that keeps the file shrinking.

## Scenario 8 — The gates it must not break

```sh
pnpm nx affected -t lint typecheck test --base=origin/main
pnpm knip:orphans
pnpm qlty:diff origin/main          # requires qlty installed locally
pnpm format:check
```

**Expect**: all green with no `QLTY_*` or `PROMPT_LINT_*` override. Two specific things to check rather than
assume:

- **`knip:orphans`** — `@bluetel-ai/prompt-lint` must be in `knip.json`'s `ignoreDependencies`, exactly as
  `@bluetel-ai/qlty-diff` is. Without it, a root devDependency consumed only by a script reads as unused and this
  blocking step fails.
- **`qlty:diff` duplication** — 13 rule modules of similar shape is how a diff crosses the 10% duplication limit.
  If it fails here, the fix is `defineRule` and shared test fixtures, not a threshold override
  ([plan.md](./plan.md#constitution-check), Principle IV).

## Scenario 9 — Pre-commit path (FR-043)

```sh
git switch -c scratch/hook-check
printf '\nSee `references/does-not-exist.md`.\n' >> tooling/skills/catalog/review/SKILL.md
git add -A && git commit -m 'scratch: check the hook fires'
```

**Expect**: the commit is refused by `.husky/pre-commit` with the `refs/dangling-path` finding, before the qlty
gate runs. Time the hook: the prompt-lint step should add well under a second (SC-002), because a hook slow enough
to be worth skipping is a hook that gets skipped.

Clean up: `git reset --hard HEAD && git switch - && git branch -D scratch/hook-check`.

## Traceability

| Scenario | Covers                                                   |
| -------- | -------------------------------------------------------- |
| 1        | FR-006, FR-047, SC-010                                   |
| 2        | US4 §1, FR-027–FR-030, SC-002, SC-003, SC-011            |
| 3        | FR-029, FR-038, FR-039, SC-005                           |
| 4        | US1 §1–5, FR-015, FR-020, FR-031, FR-040, SC-001, SC-006 |
| 5        | US2 §1–5, FR-032–FR-034, FR-042, SC-008, SC-009          |
| 6        | US3 §1–5, FR-012–FR-021, FR-044                          |
| 7        | FR-009, FR-010, FR-035, SC-011                           |
| 8        | Constitution I–IV                                        |
| 9        | FR-043                                                   |

Not covered here, by design: `content/density` calibration (waits on the first measurement — see
[research.md](./research.md)) and target-project adoption (deferred, [research.md](./research.md#r8)).
