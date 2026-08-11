# Contract: the rule catalogue

**Feature**: [../spec.md](../spec.md) | **Data model**: [../data-model.md](../data-model.md) | **Date**: 2026-08-11

This is the FR-047 catalogue: every rule, its stable identifier, the severity it ships at, what it enforces, why,
and how to fix a violation. `rules/registry.test.ts` cross-checks it against the implemented set, so a rule cannot
exist without an entry here and an entry cannot survive its rule's removal (SC-010). At implementation time this
document is mirrored into `tooling/prompt-lint/docs/rules.md`, which is the copy the cross-check reads; this copy
is the design record.

**Identifiers are permanent.** A suppression comment and a `baseline.json` entry both name a rule by id, so
renaming one silently disables it. Retire, never rename.

**Ships as** is the severity at adoption, from the measured baseline in
[../plan.md](../plan.md#adoption-how-this-lands-without-breaking-every-open-pr). It is not the severity forever —
promotion is a reviewable edit to `src/config.ts`.

Kind abbreviations: `CS` catalog-skill, `CM` catalog-meta, `CR` catalog-reference, `IS` installed-skill,
`AP` agent-pointer, `G` guidance, `ST` speckit-template, `C` constitution.

---

## `meta/` — metadata integrity

### `meta/required-field`

**Ships as** `error` · **Applies to** CM, AP · **Dimension** correctness · **Scope** artifact

Every field the kind requires is present and non-empty: `name`, `version`, `description` for `skill.meta`;
`name`, `description` for a `.claude/` pointer's frontmatter.

_Why_: the installer treats a missing `description` as a catalog error (exit 2) — a skill that reaches that state
cannot be listed or installed at all. An agent pointer without a `description` is invisible to skill selection.

_Fix_: add the field. For `description`, write one sentence of what the skill does plus a `Use when:` clause.

### `meta/duplicate-key`

**Ships as** `error` · **Applies to** CM, AP · **Dimension** correctness · **Scope** artifact

No key appears twice unless the format permits repetition. Only `next_step` is repeatable.

_Why_: `skills.sh`'s `meta_get` returns the first match; a duplicated `version` therefore means the value a reader
sees and the value the installer uses can differ. That is the worst kind of defect — invisible on inspection.

_Fix_: delete the redundant line, or merge the two values if both were intended.

### `meta/version-semver`

**Ships as** `error` · **Applies to** CM · **Dimension** correctness · **Scope** artifact

`version` parses as `MAJOR.MINOR.PATCH`.

_Why_: the whole update mechanism is a version comparison. A value that does not parse makes "update available"
undecidable for every target that installed the skill.

_Fix_: use three dot-separated integers.

### `meta/stray-line`

**Ships as** `warn` · **Applies to** CM, AP · **Dimension** correctness · **Scope** artifact

Every line in the metadata block is a comment or a well-formed `key=value` / `key: value` pair.

_Why_: a mistyped key (a missing `=`, a wrapped long `description`) is silently ignored by a line-oriented reader
rather than rejected. The field looks set and is not.

_Fix_: repair the line, or move prose into the `SKILL.md` body where it belongs.

### `meta/declared-dependency-missing`

**Ships as** `error` · **Applies to** CM · **Dimension** correctness · **Scope** artifact

`requires=` names skills that exist in the catalog; `assets=` names a bundle directory under `assets/`;
each `next_step=` line carries its two mandatory `|`-separated fields (`action`, `why`), with an optional third
(`when`).

_Why_: `tooling/skills/README.md` already states that a declared bundle that does not exist is a catalog error
(exit 2) — this catches it before the push rather than in a target's install. A `next_step` missing its `why`
renders as a bare instruction with no rationale, which is precisely what that field exists to prevent.

_Fix_: correct the name, add the bundle, or supply the missing field.

---

## `skill/` — skill body contract

### `skill/use-when-trigger`

**Ships as** `warn` (10 pre-existing violations: every `speckit-*`) · **Applies to** CM, AP · **Dimension** correctness · **Scope** artifact

The `description` contains a `Use when:` clause naming the situations the skill applies to.

_Why_: the description is the only thing an agent sees when deciding whether to invoke a skill. Seven of the
seventeen catalog skills do this today (`review`, `merging`, `pr-creation`, `copywriting`, `jira-ticket`,
`skills-install`, `frontend-design`); the ten `speckit-*` skills describe what they do but never when, which is
why they get selected by name rather than by need.

_Fix_: append `Use when: <situation>, <situation>` to the description. Describe the user's situation, not the
command's mechanics.

### `skill/section-missing`

**Ships as** `error` · **Applies to** CS, IS · **Dimension** correctness · **Scope** artifact

A skill body carries the sections its kind requires — at minimum a completion criteria section (`## Done When`
or equivalent), which the `speckit-*` skills already model.

_Why_: a procedure with no stated completion condition is a procedure an agent stops executing at an arbitrary
point. The `Done When` checklist is what makes "did the skill finish" answerable.

_Fix_: add the section. Each item should be checkable by reading the repository, not by remembering the run.

---

## `refs/` — do the references resolve

### `refs/dangling-path`

**Ships as** `error` (1 pre-existing violation) · **Applies to** CS, CR, IS, AP, G, C · **Dimension** correctness · **Scope** artifact

Every literal, path-shaped reference resolves against one of three roots: the artifact's directory, its skill
root, or the repository root. Full algorithm and the measurement that motivated it:
[../research.md](../research.md#r2).

_Why_: this is the defect class with the worst failure mode — the agent follows the instruction, cannot read the
file, and continues without the content. Nothing errors; the procedure just silently loses a step. One live
instance exists today:
`tooling/skills/catalog/copywriting/references/natural-transitions.md:276` points at a `seo-audit` skill that is
not in this catalog.

_Fix_: correct the path, create the file, or remove the reference. If the path is created at runtime or lives in a
target project, suppress it with a reason:
`<!-- prompt-lint-disable-next-line refs/dangling-path — created by step 3 at runtime -->`.

_Not reported_: bare filenames without a `/`, anything carrying variable syntax, and any path whose first segment
is not a real directory in one of the three roots. Those are references to somewhere else, not broken references.

---

## `template/` — is it finished

### `template/placeholder-residue`

**Ships as** `error` · **Applies to** CS, CR, IS, AP, G, C · **Dimension** correctness · **Scope** artifact

No unresolved authoring token survives outside a code span, a fenced block, or an HTML comment: bracketed
template slots (`[` + SCREAMING_SNAKE or Title-Case + `]`), clarification markers, `TODO`, and `$ARGUMENTS`
outside the one slot where it is meaningful.

_Why_: an agent reading a placeholder treats it as content. A `skill.meta` `next_step` in this very repository
checks for exactly this condition — "`.specify/memory/constitution.md` still contains bracketed placeholder
tokens" — which is a rule expressed as prose because there was no linter to hold it.

_Fix_: replace the token with real content. If it is being quoted as an example, put it in backticks — which is
also how this catalogue quotes them.

_Inverted for_ `ST` (speckit-template): placeholder tokens are a template's _content_. On those artifacts the rule
instead checks that the tokens are **present**, so a template cannot be accidentally filled in place and shipped
as a template that produces one repo's spec for every feature.

---

## `conventions/` — does it agree with the repo

### `conventions/config-mismatch`

**Ships as** `warn` (1 pre-existing violation) · **Applies to** CS, IS, G · **Dimension** correctness · **Scope** artifact

An artifact does not assert a convention that contradicts `.agents/skills.config`: a GitHub `owner/repo` slug that
is not the configured one, a ticket prefix that is not the configured prefix, or a base/staging branch name that
is not the configured branch.

_Why_: the live example is the strongest argument for the whole feature.
`.agents/remote-workflow-instructions.md` tells the agent, in a section headed "Never invent them", that the
ticket prefix is `URM` and the repo is `harrytwigg/universal-react-monorepo`. `.agents/skills.config` — the file
the skills actually read — says the repo is `bluetel/bluetel-ai` and that there is no ticket board. An agent that
believes the instructions file names a ticket prefix that does not exist and pushes to a repository that is not
this one.

_Fix_: delete the hardcoded value and point at `.agents/skills.config`, or correct it. Prefer deletion: two
sources of truth is the defect, and correcting one of them leaves the defect in place.

_Only mechanical comparisons_: recognisable owner/repo slugs, `PREFIX-<digits>` ticket tokens, and the exact
branch names in the config. It does not attempt to read the meaning of a sentence.

---

## `install/` — the catalog-to-target contract

All four are `scope: 'set'` — properties of the collection, invisible to a per-file linter.

### `install/catalog-drift`

**Ships as** `error` (0 pre-existing violations — verified) · **Applies to** CS, IS · **Dimension** correctness

`.agents/skills/<name>/` matches `tooling/skills/catalog/<name>/` byte for byte, excluding the files the
installer's model deliberately leaves per-project: `.skill`, `.agents/skills.config`, and anything from an asset
bundle.

_Why_: the installer's update model is a content hash. When the installed copy diverges, `skills.sh status`
reports the skill `locally-modified` and `update` refuses to touch it without `--on-conflict`. A drift introduced
by editing the installed copy instead of the catalog therefore freezes that skill's updates — in this repo, and in
every target that later hits the same conflict.

_Fix_: make the edit in `catalog/<name>/` and re-run the installer, or accept the installed copy as the new
catalog content. Never both.

### `install/version-bump`

**Ships as** `error` · **Applies to** CS, CM · **Dimension** correctness

When a diff changes a catalog skill's hashed content, that skill's `skill.meta` `version` also changes.

_Why_: the version is the only signal a target has. Content changed without a bump means no installed copy
anywhere will ever learn there is an update — the change is published and invisible at the same time.

_Fix_: bump `version` in the same commit. Patch for wording, minor for a new capability, major for a changed
contract.

_Diff-scoped by nature_: it compares against the base ref, so `--all` cannot evaluate it and reports it as
not-evaluated rather than passing.

### `install/pointer-mismatch`

**Ships as** `error` · **Applies to** AP · **Dimension** correctness

A `.claude/skills/<name>/SKILL.md` pointer's frontmatter `name` and `description` match the catalog `skill.meta`,
and its body references the shared `.agents/skills/<name>/SKILL.md` file.

_Why_: the pointer is what the agent reads first. If its `description` has drifted from the catalog's, skill
selection is made on stale information; if it stops naming the shared file, the agent runs a one-sentence stub as
if it were the whole procedure.

_Fix_: regenerate the pointer through the installer rather than editing it by hand.

---

## `content/` — cost and coherence

### `content/cross-artifact-duplication`

**Ships as** `warn` (unmeasured until implemented) · **Applies to** CS, CR, G, C · **Dimension** redundancy · **Scope** set

No substantial instruction block is duplicated across artifacts. Shingle clustering, window and calibration in
[../research.md](../research.md#r6).

_Why_: a duplicated block gets fixed in one copy. It is also paid for twice in every context window that loads
both.

_Fix_: extract to a reference file and point both artifacts at it — the mechanism `review`'s
`references/` directory already uses.

_Excluded by design_: `AP` pointers (17 near-identical files are the installer's intended shape) and the
catalog↔installed boundary (identity there is what installation _means_).

### `content/density`

**Ships as** `warn` · **Applies to** CS, CR, IS, G · **Dimension** density · **Scope** artifact

The ratio of distinct directive-bearing lines to total non-blank lines stays above a threshold.

_Why_: restated instructions and filler consume the context window that the actual procedure needs, and an
instruction repeated in three slightly different forms is three things to keep consistent.

_Fix_: delete the restatement. Threshold calibration waits on the first whole-repository measurement rather than
being invented now — recorded as an open question in [../research.md](../research.md).

### `content/size-budget`

**Ships as** `warn` · **Applies to** all · **Dimension** density · **Scope** artifact

An artifact stays within its kind's `approxTokens` budget, measured by the deterministic approximation of
[../research.md](../research.md#r5).

_Why_: every guidance artifact is loaded on every run, so its size is a fixed tax on all work. A budget makes
"this skill is too long" an argument about a number rather than about taste.

_Fix_: split the procedure into a `references/` file the skill reads when it needs it — the same lever
`content/cross-artifact-duplication` recommends.

### `content/self-contradiction`

**Ships as** `warn` · **Applies to** CS, IS, G, C · **Dimension** correctness · **Scope** artifact

An artifact does not both require and forbid the same mechanically-comparable thing.

_Why_: a contradiction resolves to whichever instruction the model weighted higher — which is not a decision
anyone made. The failure is silent and varies between runs.

_Fix_: decide, and delete the other one.

_Bounded deliberately_ (FR-026): mechanically decidable cases only — conflicting metadata values, an explicit
rule and its literal negation. It does not attempt semantic contradiction, which is the LLM-judged territory this
feature excludes.

---

## `structure/` — is it shaped like a document

### `structure/degenerate`

**Ships as** `warn` · **Applies to** CS, CR, IS, G, C · **Dimension** structure · **Scope** artifact

An artifact above a trivial size has headings, and is not one undifferentiated block.

_Why_: headings are how an agent navigates to the part of a procedure it needs, and how a human reviews one
section without re-reading all of it.

_Fix_: add headings at the boundaries the content already has.

### `structure/heading-skip`

**Ships as** `note` · **Applies to** CS, CR, IS, G, C · **Dimension** structure · **Scope** artifact

Heading levels do not skip (no `h2` directly followed by `h4`).

_Why_: nesting is what tells a reader whether a step belongs to the section above it or replaces it. A skipped
level makes that ambiguous.

_Fix_: use the next level down, or promote the heading.

---

## Bookkeeping rules

These four describe the run, not the content. They have no configurable severity and cannot be baselined — a
report that cannot say "I could not read this file" is worse than a red one.

| Rule                     | Severity | Meaning                                                                                                |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------ |
| `artifact/unclassified`  | `warn`   | A file matched a declared location but fits no kind (FR-004) — the artifact set has grown a blind spot |
| `artifact/unreadable`    | `error`  | Not UTF-8, a symlink, or empty. Dependent rules are reported not-evaluated, never as passing           |
| `suppression/unreasoned` | `error`  | A suppression comment without a reason (FR-009) — an exemption nobody has to justify is not one        |
| `suppression/stale`      | `warn`   | A suppression, or a `baseline.json` entry, that no longer matches anything (FR-010)                    |
