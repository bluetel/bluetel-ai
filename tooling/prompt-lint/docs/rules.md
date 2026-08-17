<!--
  This file is machine-checked by `src/rules/registry.test.ts` (FR-047, SC-010). The parse is
  deliberately simple, which makes the convention mandatory rather than stylistic:

    - every rule is a level-3 heading whose text is exactly the rule id in backticks, and no
      level-3 heading is anything else;
    - each entry's shipped severity is the first `**Ships as**` line after it, in backticks;
    - the `**Coverage**` line below is asserted against the registry too, so the summary cannot
      drift from the entries.

  Adding a rule means adding its entry here in the same change. The cross-check fails both ways:
  a registered rule with no entry, and an entry naming no registered rule.
-->

# `prompt-lint` rule catalogue

The FR-047 catalogue: every rule this repository ships, its permanent identifier, the severity it
ships at, what it enforces, why, and how to fix a violation.

This is the copy the cross-check reads and the copy a contributor is pointed at. The design
record — which also carries the rules that are not implemented yet — is
[`contracts/rules.md`](../../../specs/005-prompt-quality-validator/contracts/rules.md). Where the
two disagree, the registry wins and this file follows it.

**Identifiers are permanent.** A suppression comment and a `baseline.json` entry both name a rule by
id, so renaming one silently disables it. Retire, never rename.

**Ships as** is the severity at adoption, not the severity forever. Promotion or demotion is a
reviewable edit to `severities` in `src/config.ts` — never an environment variable, because changing
_what_ is checked has to appear in a diff (FR-034, SC-009). The bookkeeping rules are the exception:
their severity is not configurable and they cannot be baselined.

**Coverage**: 11 rules · 6 families · 7 configurable · 4 bookkeeping

Kind abbreviations: `CS` catalog-skill, `CM` catalog-meta, `CR` catalog-reference, `IS`
installed-skill, `AP` agent-pointer, `G` guidance, `ST` speckit-template, `C` constitution, `UN`
unclassified.

---

## `meta/` — metadata integrity

### `meta/required-field`

**Ships as** `error` · **Applies to** CM, AP · **Dimension** correctness · **Scope** artifact

Every field the kind requires is present and non-empty: `name`, `version` and `description` for
`skill.meta`; `name` and `description` for a pointer’s frontmatter.

_Why_: the installer treats a missing `description` as a catalog error (exit 2) — a skill in that
state cannot be listed or installed at all. An agent pointer without a `description` is invisible to
skill selection.

_Fix_: add the field. For `description`, write one sentence of what the skill does plus a
`Use when:` clause naming the situations it applies to.

### `meta/duplicate-key`

**Ships as** `error` · **Applies to** CM, AP · **Dimension** correctness · **Scope** artifact

No key appears twice unless the format permits repetition. Only `next_step` is repeatable.

_Why_: `skills.sh`’s `meta_get` returns the first match, so a duplicated `version` means the value a
reader sees and the value the installer uses can differ. That is the worst kind of defect —
invisible on inspection.

_Fix_: delete the redundant line, or merge the two values if both were intended.

### `meta/version-semver`

**Ships as** `error` · **Applies to** CM · **Dimension** correctness · **Scope** artifact

`version` parses as `MAJOR.MINOR.PATCH`.

_Why_: the whole update mechanism is a version comparison. A value that does not parse makes "update
available" undecidable for every target that installed the skill.

_Fix_: use three dot-separated integers, for example `1.0.0`.

_Not reported_: an absent or empty `version`, which is `meta/required-field`’s finding. Two rules
reporting one missing field is how a report starts getting skimmed.

### `meta/stray-line`

**Ships as** `warn` · **Applies to** CM, AP · **Dimension** correctness · **Scope** artifact

Every line in the metadata block is a comment or a well-formed `key=value` / `key: value` pair.

_Why_: a mistyped key — a missing `=`, a wrapped long `description` — is silently ignored by a
line-oriented reader rather than rejected. The field looks set and is not.

_Fix_: repair the line, or move prose into the `SKILL.md` body where it belongs. A long value must
stay on one line.

---

## `refs/` — do the references resolve

### `refs/dangling-path`

**Ships as** `error` · **Applies to** CS, CR, IS, AP, G, C · **Dimension** correctness · **Scope**
artifact

Every literal, path-shaped reference resolves against one of three roots: the artifact’s directory,
its skill root, or the repository root.

_Why_: this is the defect class with the worst failure mode — the agent follows the instruction,
cannot read the file, and continues without the content. Nothing errors; the procedure just silently
loses a step.

_Fix_: correct the path, create the file, or remove the reference. If it is created at runtime or
lives in a target project, suppress it with a reason:
`<!-- prompt-lint-disable-next-line refs/dangling-path — created by step 3 at runtime -->`.

_Not reported_ — five filters, each one a measured noise class ([research
R2](../../../specs/005-prompt-quality-validator/research.md#r2)):

1. a reference with no `/` in it, a bare protocol (`://`) or an anchor — there is no way to tell
   "the file next to this one" from "a file in this repository", and a fenced or commented reference
   is not a claim either;
2. anything carrying variable syntax, which is a template rather than a path;
3. a reference whose first segment is not a real directory under any of the three roots — that is a
   claim about somewhere else, most often a target project's tree;
4. a reference that does resolve under one of those roots;
5. **a reference on a line that does not assert the path is there right now** — an existence check
   ("skip silently if it does not exist"), the procedure creating the file, or an illustration ("for
   example", "e.g."). This filter is not in the design record's algorithm, and the rule needs it:
   implementing rules 1–4 alone produced 80 findings on this tree, 70 of them one runtime-created
   path quoted inside its own existence check. The test is lexical, not semantic, so the cost is a
   missed defect on a line that happens to contain "for example".

---

## `skill/` — skill body contract

### `skill/section-missing`

**Ships as** `error` · **Applies to** CS, IS · **Dimension** correctness · **Scope** artifact

A skill body carries a completion-criteria section — `## Done When` or equivalent. `Completion
Criteria`, `Acceptance Criteria`, `Definition of Done` and `Success Criteria` all satisfy it.

_Why_: a procedure with no stated completion condition is a procedure an agent stops executing at an
arbitrary point. The `Done When` checklist is what makes "did the skill finish" answerable.

_Fix_: add a `## Done When` section. Each item should be checkable by reading the repository, not by
remembering the run.

_Not reported_: any installed file that is not a `SKILL.md`. The `IS` kind sweeps in the reference
documents a skill reads, and a reference is prose to be consulted rather than a procedure with a
completion condition.

---

## `template/` — is it finished

### `template/placeholder-residue`

**Ships as** `error` · **Applies to** CS, CR, IS, AP, G, C, ST · **Dimension** correctness ·
**Scope** artifact

No unresolved authoring token survives outside a code span, a fenced block or an HTML comment:
bracketed template slots (`[` + SCREAMING_SNAKE or Title Case + `]`), clarification markers,
`TODO`, and `$ARGUMENTS`.

_Why_: an agent reading a placeholder treats it as content. A `next_step` in this repository already
checks for exactly this condition in prose, because there was no linter to hold it.

_Fix_: replace the token with real content. If it is being quoted as an example, put it in
backticks — which is also how this catalogue quotes every token it detects.

_Inverted for_ `ST` (speckit-template): there the tokens are the template's _content_, so the rule
instead requires that they are still **present**. A template filled in place and shipped would
produce one repository's document for every future feature.

---

## Bookkeeping rules

These four describe the run rather than an artifact's content, so `gate.ts` emits their findings and
their check bodies are empty by construction. Their severity is **not configurable** and they
**cannot be baselined** — a report that cannot say "I could not read this file" is worse than a red
one.

### `artifact/unclassified`

**Ships as** `warn` (bookkeeping) · **Applies to** UN · **Dimension** correctness · **Scope**
artifact

A file matched a declared artifact location but fits no kind (FR-004).

_Why_: the artifact set has grown a blind spot. No rule claims this file, so the gate would otherwise
report a clean pass over something it never looked at.

_Fix_: give the file a kind in `src/scope/classify.ts`, narrow the location glob in
`src/scope/patterns.ts`, or exclude the path in `src/config.ts` with a reason (FR-005).

### `artifact/unreadable`

**Ships as** `error` (bookkeeping) · **Applies to** every kind · **Dimension** correctness ·
**Scope** artifact

Every artifact in scope is readable UTF-8 text, is not a symlink, and is not empty.

_Why_: rules that needed this file’s content are reported not-evaluated rather than passing. A
dropped artifact is indistinguishable from a clean one.

_Fix_: make the file readable UTF-8 text — replace a symlink with the file it points at, fill or
delete an empty stub — or exclude the path in `src/config.ts` with a reason.

### `suppression/unreasoned`

**Ships as** `error` (bookkeeping) · **Applies to** every kind · **Dimension** correctness ·
**Scope** artifact

Every suppression comment carries a reason (FR-009).

_Why_: an exemption nobody has to justify is not one.

_Fix_: state the reason after the rule id —
`<!-- prompt-lint-disable-next-line <rule> — <why> -->` in markdown,
`# prompt-lint-disable-next-line <rule> — <why>` in `skill.meta` — or delete the suppression and fix
the finding it was hiding.

### `suppression/stale`

**Ships as** `warn` (bookkeeping) · **Applies to** every kind · **Dimension** correctness · **Scope**
artifact

Every suppression, and every `baseline.json` entry, still matches something (FR-010).

_Why_: a suppression that has stopped matching is an exemption for a defect that is already fixed,
and a baseline that never drains becomes permanent.

_Fix_: delete the suppression comment, or the `baseline.json` entry. The finding it covered is gone,
which is the outcome the entry existed to reach.
