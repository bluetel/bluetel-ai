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

**Coverage**: 17 rules · 8 families · 13 configurable · 4 bookkeeping

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

### `meta/declared-dependency-missing`

**Ships as** `error` · **Applies to** CM · **Dimension** correctness · **Scope** artifact

`requires=` names skills that exist in the catalog; `assets=` names a bundle directory under
`assets/`; each `next_step=` line carries its two mandatory `|`-separated fields — `action` and
`why` — with an optional third, `when`.

_Why_: `skills.sh`'s `verify` already gates all three and exits 2, so this rule is that gate moved
earlier — before the push, rather than in a target's install. A `next_step` missing its `why`
renders as a bare instruction with no rationale, which is precisely what the field exists to
prevent.

_Fix_: correct the name to match the catalog directory, add the bundle under `assets/`, or supply
the missing `|`-separated field. `requires` and `assets` are space-separated, so a stray word is a
declared dependency the installer cannot resolve — one finding per offending word, so the message
names which of three declared names is the broken one.

_Not reported_:

1. an absent **or empty** `requires=`, `assets=` or `next_step=`. Empty and absent are the same
   thing to the shell — zero iterations, no check — and every skill in the catalog today ships a
   literal `requires=` with nothing after it, so a rule that fired on emptiness would fire
   seventeen times on a clean catalog;
2. anything but the **first** `requires=` or `assets=` line, because `meta_get` returns the first
   match and a later line is a value nothing reads. That duplication is `meta/duplicate-key`'s
   finding. `next_step` is the one repeatable key, so every line of it is checked;
3. a `next_step` whose optional third field is empty or absent, or which carries extra `|`s. A
   trailing bare `|` is well-formed, and `emit_next_steps` renders everything after the second
   separator rather than swallowing it.

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

### `skill/use-when-trigger`

**Ships as** `warn` · **Applies to** CM, AP · **Dimension** correctness · **Scope** artifact

The `description` contains a `Use when:` clause naming the situations the skill applies to.

_Why_: the description is the only thing an agent sees when deciding whether to invoke a skill —
the body is not read until after the decision is made. A description that says only what a skill
does therefore gets it selected by name rather than by need. The ten `speckit-*` skills are in
exactly that state today.

_Fix_: append `Use when: <situation>, <situation>` to the description. Describe the user's
situation — what they are doing or asking for — rather than the command's mechanics.

_Accepted, deliberately looser than the literal_ `Use when:`: the match is case-insensitive, the
colon is optional, `whenever` counts as well as `when`, and an intervening `this` or `it` is
allowed, so `Also use when the user says …` passes. A rule that reported that clause would teach
authors to satisfy punctuation rather than to name a situation. Still rejected, and intentionally:
`Useful when` (a different word), a bare `When:` with no `use` (a section label, not a trigger),
and near-synonyms such as `Triggers on:` or `Applies to:`.

_Reported separately_: a marker that is present but followed by fewer than three words, which is a
different finding with a different message. `Use when: needed.` satisfies any substring test while
naming nothing; three words is the shortest span that can carry a verb and its object — `creating a
ticket`, `reviewing code changes` — and the shortest real clause in the catalog runs to six, so the
threshold has clearance against the corpus rather than being tuned to it.

_Not reported_: an absent or empty `description`, which is `meta/required-field`'s finding — and
whose remediation already asks for the `Use when:` clause. Two rules reporting one missing field is
how a report starts getting skimmed.

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

## `conventions/` — does it agree with the repository

### `conventions/config-mismatch`

**Ships as** `warn` · **Applies to** CS, IS, G · **Dimension** correctness · **Scope** artifact

No artifact asserts a repository slug, ticket prefix, or base/staging branch that contradicts
`.agents/skills.config`.

_Why_: two sources of truth for a convention is the defect. This repository's own remote-workflow
instructions name a ticket prefix that does not exist here and a repository that is not this one —
under a heading that says "Never invent them" — while `.agents/skills.config`, the file the skills
actually read, says otherwise. An agent that believes the instructions works to a ticket prefix that
does not exist and pushes somewhere else.

_Fix_: delete the hardcoded value and point at `.agents/skills.config`, or correct it to the
configured one. Prefer deletion: two sources of truth is the defect, and correcting one of them
leaves the other in place.

_Only mechanical comparisons against a configured value_: it never reads the meaning of a sentence,
and that bound is the design rather than modesty. All three compared values are shaped like ordinary
text — `owner/repo` is shaped exactly like a relative path, a branch name is an English word, and
`PREFIX-123` is the shape of half the acronyms in technical prose — so each needs an anchor before
it counts as a claim: the token inside a code span (or carrying its own `github.com/…` context) with
a word that assigns it the role immediately before it (`repo`, `remote`, `origin`, `--repo`,
`gh -R`, `base branch`, `default branch`, `staging branch`, `targets`, `against`), or a
ticket-convention word on the line. Anchors are tested against the text _before_ the token, so a
token containing the word `repo` cannot vouch for itself.

_Not reported_:

1. a line that is pointing **at** the config rather than setting up a second source of truth — one
   that names a `lower_snake_case` config key, names `skills.config`, or flags itself as an
   illustration ("for example", "for instance", "e.g."). Six of the first nine findings over this
   tree were that: a table of config keys and their example values, and a sentence describing how a
   branch name is assembled from the configured prefix. The test is lexical, so it costs a real
   defect written as "set `ticket_prefix` to …";
2. anything inside a fenced block or an HTML comment. A command transcript or an author's note is
   not a claim the prose is making, and `refs/dangling-path` draws the same line;
3. a two-segment token whose owner is a git ref word (`origin`, `upstream`, `refs`, `heads`) or a
   real directory in this tree, and a `PREFIX-` token whose prefix is a standard or a
   requirement-id prefix (`UTF-8`, `SHA-256`, `RFC-2119`, `FR-007`, `SC-004`). The cost of that
   list is a project whose real ticket prefix is one of them;
4. everything, when `.agents/skills.config` is absent or the compared key is blank. That is
   **silence**, not not-evaluated: a convention nobody configured is a convention no artifact can
   contradict, so there is nothing to compare against rather than a comparison that failed to run.

---

## `install/` — the catalog-to-target contract

All three are **Scope** `set` — properties of the collection, invisible to a per-file linter — and
the only rules that reason about two trees at once. Each pairs a file in one tree with a file in
another, so every finding names both paths: a drift finding that names one side tells the reader
nothing about what to compare. Each is silent when the run hands it half a pair, because
`--scope=catalog` and `--scope=installed` do exactly that.

### `install/catalog-drift`

**Ships as** `error` · **Applies to** CS, CR, IS · **Dimension** correctness · **Scope** set

`.agents/skills/<name>/` matches `tooling/skills/catalog/<name>/` byte for byte, excluding the two
files the installer deliberately leaves per-project: `skill.meta`, which it never copies, and
`.skill`, which it generates.

_Why_: the installer's update model is a content hash. When the installed copy diverges,
`skills.sh status` reports the skill locally-modified and `update` refuses to touch it without
`--on-conflict`. A drift introduced by editing the installed copy instead of the catalog therefore
freezes that skill's updates — in this repository, and in every target that later hits the same
conflict.

_Fix_: for a file that differs, make the edit in `tooling/skills/catalog/<name>/` and re-run the
installer, or accept the installed copy as the new catalog content — never both. For a file present
on only one side the fix is different: re-run the installer so the installed copy carries every
catalog file, or add the file to the catalog if the installed copy needs it. Installed content is
replaced wholesale, never merged, so a file in the installed copy and in no catalog entry is deleted
by the next `update`.

_Not reported_:

1. `skill.meta` and `.skill`. The exclusion list is the installer's, read off `skills.sh` rather
   than taken from the design record: `stage_and_commit` copies
   `find . -type f ! -name skill.meta`, and `skill_hash` digests the same minus `.skill`. The
   config file and the asset bundles the design record also names live outside both compared
   directories entirely, so excluding them by name would be dead code;
2. a **content** difference in a file the artifact set does not carry. File lists are compared over
   every tracked path, contents only over declared artifacts, so a script or a JSON schema present
   on both sides is checked for presence and not for content. Widening that is a change to
   `src/scope/patterns.ts`, not to this rule;
3. a skill present in only one tree — which is also what `--scope=catalog` and `--scope=installed`
   hand this rule, half a pair each. A catalog publishes to many targets and each installs the
   subset it wants: `frontend-design` is published here and installed nowhere;
4. any comparison in which one side could not be read. That is reported not-evaluated, naming the
   comparison that did not happen, alongside `artifact/unreadable` naming the file. A rule may not
   report "these files differ" on the strength of bytes it never saw.

### `install/version-bump`

**Ships as** `error` · **Applies to** CS, CM, CR · **Dimension** correctness · **Scope** set

When a diff changes a catalog skill's hashed content, that skill's `skill.meta` `version` also
changes.

_Why_: the version is the only signal a target has. Content changed without a bump means no
installed copy anywhere will ever learn there is an update — the change is published and invisible
at the same time.

_Fix_: bump `version` in the same commit. Patch for wording, minor for a new capability, major for a
changed contract.

_Diff-scoped by nature_: it is a comparison between two revisions, so under `--all` there is no base
ref and the rule is reported **not evaluated** — never as passing. Say that distinction plainly,
because it is the whole point: a whole-surface run that showed this rule green would be claiming
every version in the catalog is bumped correctly on the strength of a comparison it never made.

_Not reported_:

1. a skill that did not exist at the base ref. A first published version is not a bump;
2. a **modification** to a file the artifact set does not carry, such as a script or a JSON schema.
   Additions and deletions of those are still visible, because deciding them needs no current
   bytes; deciding a modification needs bytes to compare and there are none. A missed bump on a
   changed `scripts/jira-sprint.sh` is the one case this rule cannot see, and it is stated rather
   than hidden;
3. an absent `version` on either side, or a catalog entry with no `skill.meta` in scope at all —
   both `meta/required-field`'s finding.

### `install/pointer-mismatch`

**Ships as** `error` · **Applies to** AP, CM · **Dimension** correctness · **Scope** set

A `.claude/skills/<name>/SKILL.md` pointer's frontmatter `name` and `description` match the catalog
`skill.meta`, and its body references the shared `.agents/skills/<name>/SKILL.md` file. One finding
per disagreeing field, each naming the `skill.meta` line it disagrees with: `name`, `description`
and the body reference have three different fixes, and a combined message would have to carry all
three.

_Why_: the pointer is what the agent reads first. If its `description` has drifted from the
catalog's, skill selection is made on stale information; if it stops naming the shared file, the
agent runs a one-sentence stub as if it were the whole procedure.

_Fix_: regenerate the pointer through the installer rather than editing it by hand. The pointer is
generated from `skill.meta`, so the catalog is where the value belongs — and `generate_stub` is what
writes the one line naming the shared file.

_Not reported_:

1. a `''` doubling in the pointer's `description`. The installer writes the value as a
   single-quoted YAML scalar and doubles every `'`, so undoing that before comparing is the
   difference between reporting drift and reporting the installer working correctly;
2. an absent `name` or `description` on either side, which is `meta/required-field`'s finding, or a
   metadata block that would not parse, which is `meta/stray-line`'s and `artifact/unreadable`'s;
3. a pointer with no catalog `skill.meta` in scope. It may name a skill published by another
   catalog, and under `--scope=installed` there is no `skill.meta` in scope at all. A missing
   installed copy or a missing pointer is likewise silence: `skills.sh status` owns the installer's
   own states (stub-missing, not-installed), and `prompt-lint` owns the content of the artifacts
   that are there.

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
