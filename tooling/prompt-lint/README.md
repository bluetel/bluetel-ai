# @bluetel-ai/prompt-lint

A correctness gate over this repository's **AI-authored artifacts** — the skill catalog, the installed
skill trees, the agent guidance files and the Spec Kit templates. Those files are executed by an agent
much as code is executed by a runtime, and until this package existed nothing checked them: a broken
path, a missing `description` or a leftover template slot reached `main` as easily as a typo in prose.

It reports **findings**, never a rewrite. Every finding names what is wrong and what to do about it,
and the run's exit code says whether the prompts are wrong or the tool could not run.

## What it gates

The artifact set is a declared table in [`src/scope/patterns.ts`](./src/scope/patterns.ts), not a
heuristic — a file is in scope because it is listed:

| Location                                 | Why it is in the set                                           |
| ---------------------------------------- | -------------------------------------------------------------- |
| `tooling/skills/catalog/*/SKILL.md`      | the published skill body, executed verbatim by every installer |
| `tooling/skills/catalog/*/skill.meta`    | the installer reads this to list, install and version a skill  |
| `tooling/skills/catalog/*/references/**` | read mid-procedure, so a broken one silently drops a step      |
| `.agents/skills/*/**/*.md`               | this repository's installed copy                               |
| `.claude/skills/*/SKILL.md`              | the pointer an agent reads first                               |
| `AGENTS.md`, `CLAUDE.md`                 | loaded at the start of every agent run                         |
| `.claude/rules/*.md`, `.agents/*.md`     | project rules and shared agent guidance                        |
| `.specify/templates/*.md`                | the templates every Spec Kit command fills in                  |
| `.specify/memory/constitution.md`        | the gate every plan checks itself against                      |

`specs/**` is deliberately absent: a spec is a record, not something an agent acts on at runtime.

The rules themselves are catalogued in [`docs/rules.md`](./docs/rules.md) — id, shipped severity,
statement, rationale and fix, one entry per rule. That file is cross-checked against the registry by
`src/rules/registry.test.ts`, so it cannot fall behind the code.

## Running it

From the repository root:

```sh
pnpm prompt-lint:diff                  # artifacts changed vs origin/main — the CI and pre-commit path
pnpm prompt-lint:diff origin/staging   # ... vs an explicit base ref
pnpm prompt-lint                       # every declared artifact (--all)
```

From this directory (Principle I — the package runs in isolation):

```sh
pnpm exec tsx src/cli.ts --all
pnpm exec tsx src/cli.ts --list-rules
pnpm exec tsx src/cli.ts --explain=refs/dangling-path
npx vitest run                         # this package's own suite
```

Flags, all of which are implemented today:

| Flag                     | Effect                                                                         |
| ------------------------ | ------------------------------------------------------------------------------ |
| `<baseRef>` (positional) | Diff scope: evaluate artifacts changed against this ref                        |
| `--all`                  | Evaluate every artifact in the declared set; ignores `<baseRef>`               |
| `--staged`               | Evaluate the staged set — the pre-commit path                                  |
| `--scope=<name>`         | One subset of the locations: `catalog`, `installed`, `guidance`, `speckit`     |
| `--list-rules`           | Print the catalogue and exit `0`, evaluating no artifacts                      |
| `--explain=<ruleId>`     | Print one rule's statement, rationale, kinds and fix, then exit `0`            |
| `--no-baseline`          | Ignore `baseline.json` — the true state of the surface, without failing anyone |
| `--max-findings=<n>`     | Cap the printed list; the omitted count is always stated (default `25`)        |

`--all`, `--staged` and a positional base ref are mutually exclusive; passing two is a usage error
rather than a silently-resolved precedence. An unknown flag is a usage error too, never ignored — an
ignored flag in CI looks like a tool that produces the wrong output rather than one that was called
wrong.

Output is verdict first, then counts, then findings, each with a `→` remediation:

```text
prompt-lint (diff vs origin/main): 6 artifacts, 0 excluded
  errors:   1  (max 0)
  warnings: 0  (max 50)
  notes:    0

✖ refs/dangling-path
    tooling/skills/catalog/copywriting/references/natural-transitions.md:276
    References `references/seo-audit.md`, which does not exist relative to this artifact, its
    skill root, or the repository root.
    → Correct the path, create the file, or remove the reference.
```

Paths are repo-relative and nothing timestamped or machine-specific is printed, so two runs over the
same tree produce identical output.

## Exit codes

A stable contract; callers may branch on it. The point of the split is that a red step is attributable
to "the prompts are wrong" versus "the tool could not run".

| Code | Meaning                                                                                       |
| ---- | --------------------------------------------------------------------------------------------- |
| `0`  | Within thresholds — including the nothing-in-scope case, which says so explicitly             |
| `1`  | A threshold was breached: too many errors or warnings                                         |
| `2`  | Usage error — unknown flag, mutually exclusive flags, unknown `--scope` or `--explain` target |
| `3`  | Configuration invalid; **no artifact was evaluated**                                          |
| `4`  | Scope could not be established — base ref unresolvable, or not a git repository               |
| `5`  | Internal failure — a rule threw. The rule and artifact are named, never a clean pass          |
| `6`  | Reserved for the external analyser being unavailable or the wrong version (see below)         |

Exit `4` exists because a shallow checkout silently evaluating zero artifacts and exiting `0` is the
failure this contract most needs to prevent.

## Not implemented yet

Only the correctness half of the design exists. The delegated half — the pinned `contextops` analyser
that measures redundancy, density, structure and concentration and produces the context score — is
Phase 6, and with it `--json`, `--rules-only`, `--bundle=<id>` and exit `6`. **The CLI rejects those
three flags as usage errors (exit `2`) on purpose**: a flag accepted and ignored is worse than a flag
refused. `minScore` is present in the config and inert at `0` until the first real measurement.

## Thresholds and environment overrides

Every threshold lives in [`src/config.ts`](./src/config.ts) — `maxErrors` (0), `maxWarnings` (50),
`minScore` (0, inert), the per-rule `severities` override and the `exclude` list, each exclusion
carrying a reason. Each threshold also has a `PROMPT_LINT_*` override, named in the report header when
in effect, and those exist **for local investigation only — never to pass CI**.

There is deliberately no environment override for a per-rule severity or for the exclusion list: those
change _what_ is checked rather than how strictly, so they have to appear in a diff.

## Suppressing one finding

Next-line scope only, and the reason is mandatory — `suppression/unreasoned` is itself an `error`,
because an exemption nobody has to justify is not one:

```text
<!-- prompt-lint-disable-next-line refs/dangling-path — created by step 3 at runtime -->
# prompt-lint-disable-next-line meta/stray-line — the value is a URL and cannot be wrapped
```

The markdown form goes in a `.md` body, the `#` form in a `skill.meta`. There is no file-wide
suppression: "this whole file is exempt" is a decision that belongs in `src/config.ts` where a
reviewer sees it, not in the file being exempted. A suppression that stops matching is reported as
`suppression/stale`.

## The baseline

[`baseline.json`](./baseline.json) is the adoption lever: it lets a rule be switched on without
failing every pull request already in flight. An entry names a **rule** and a **path** — deliberately
not a line number, which would churn on every unrelated edit — plus a reason, and downgrades that
pair's findings to `note`, marked as baselined in the report.

To add one, add an object to `entries`:

```json
{
  "rule": "refs/dangling-path",
  "path": "tooling/skills/catalog/copywriting/references/natural-transitions.md",
  "reason": "pre-existing at adoption — names a skill that is not in this catalog; drained separately"
}
```

Two things follow from that shape. An entry exempts **every** occurrence of that rule in that file, so
it is a coarser instrument than a suppression comment; and an entry that matches nothing is reported
as `suppression/stale`, so the file drains rather than quietly becoming the standard. Never add an
entry to make a red run green — fix the finding, or suppress the one line with a reason.

`pnpm prompt-lint --all --no-baseline` shows the true state of the surface at any time.

## Adding a rule

Three files, and the third is not optional:

1. **The rule.** One `defineRule` call in `src/rules/<family>.ts`, exported through
   `src/rules/index.ts` and added to `RULES` in `src/rules/registry.ts`. It declares its id,
   `defaultSeverity`, `statement`, `rationale`, `appliesTo`, `dimension`, `scope` and the parsed views
   it `needs`; the check body returns drafts — a `message` and a `remediation` — and `defineRule`
   supplies the rest. A finding with an empty remediation throws rather than shipping.
2. **Its colocated suite**, `src/rules/<family>.test.ts`, covering what it reports _and_ what it
   deliberately does not. A rule's noise class is part of its contract: the measurement in
   `docs/rules.md` under `refs/dangling-path` is what a rule looks like when that is taken seriously.
3. **Its catalogue entry** in [`docs/rules.md`](./docs/rules.md) — id, ships-as severity, statement,
   rationale and fix, plus a bump to the `**Coverage**` line. You cannot forget this one: the
   cross-check in `src/rules/registry.test.ts` fails when a registered rule has no entry, when an
   entry names no registered rule, and when an entry's stated severity disagrees with the registry.

Rule ids are **permanent**. A suppression comment and a baseline entry both name a rule by id, so
renaming one silently disables it — retire a rule instead of renaming it. Shipping a rule
non-blocking is a `severities` entry in `src/config.ts`, and promoting it later is a reviewable edit
to that one file.

## Where it runs

`.husky/pre-commit` runs `pnpm prompt-lint:diff` before the qlty block, and CI runs it against the
pull request's base ref. Neither installs anything: the correctness half needs nothing but this
repository's own toolchain.
