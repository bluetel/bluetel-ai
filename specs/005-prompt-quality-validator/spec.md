# Feature Specification: Static prompt-quality validator for AI-authored artifacts

**Feature Branch**: `claude/issue-15-20260811-1041` (spec directory `005-prompt-quality-validator`)

**Created**: 2026-08-11

**Status**: Draft

**Input**: Issue [#15](https://github.com/bluetel/bluetel-ai/issues/15) — "[Feature] Static validator for prompt quality": _"We should probably have some more static mechanisms for evaluating the quality of AI generated tooling in this repo."_ Prior art named in the thread: [contextops](https://github.com/Abhijeet777ui/contextops).

## Why This Change

This repository's most load-bearing artifacts are not code. `tooling/skills/catalog/` holds seventeen skills that
other projects install and execute verbatim; `AGENTS.md`, `CLAUDE.md`, `.claude/rules/*.md` and
`.agents/remote-workflow-instructions.md` are read at the start of every agent run; `.specify/templates/*.md`
shape every spec, plan and task list the repo produces. All of it is markdown, most of it is written by an agent,
and **none of it is checked by anything.**

Every other class of artifact here is gated. Code passes ESLint, Prettier, `strict` typecheck, colocated Vitest,
`qlty:diff` for health, and `knip:orphans` for reachability. A prompt passes review, and then only by whoever
happens to read it closely. The failure modes that follow are not hypothetical — they are what an unchecked
prompt surface actually does:

- A `SKILL.md` tells the agent to read `.agents/skills/<name>/references/foo.md`. The reference was renamed. The
  agent silently proceeds without the half of the procedure that file held.
- `.agents/remote-workflow-instructions.md` names `URM` as the ticket prefix and
  `harrytwigg/universal-react-monorepo` as the repo, while `.agents/skills.config` — the file the skills actually
  read — says the prefix is unused and the repo is `bluetel/bluetel-ai`. Two sources of truth, one of them wrong,
  no check that notices.
- A catalog skill is edited without bumping `version` in its `skill.meta`, so no installed copy anywhere ever
  learns there is an update.
- A spec ships with a `[NEEDS CLARIFICATION]` marker or a `[FEATURE NAME]` placeholder still in it, and the next
  agent treats the placeholder as content.
- Two skills grow a near-identical 40-line block. It gets fixed in one of them.

A human reviewer catches these inconsistently, because catching them means holding a dozen files in mind at once
and following every path in every one. That is precisely the kind of work a deterministic checker does perfectly
and for free.

So: **a static validator for the prompt surface, run the same way `qlty:diff` is run** — deterministic,
model-independent, diff-scoped, blocking.

It is two halves, and the split follows from a single question: _who is better placed to know this?_

- **The repository's own invariants** — do the references resolve, is the metadata complete, has the installed
  copy drifted from the catalog, was the version bumped, does this file contradict `.agents/skills.config` —
  are things only this repository knows. They are specified here and built here.
- **Context economy** — redundancy, density, structure, concentration, token cost, a bounded health score — is
  what [`contextops`](https://github.com/Abhijeet777ui/contextops) already does, deterministically and offline.
  It is taken as a **pinned dependency and called**, not reimplemented. The validator's job there is to hand it
  the right input: this repository's files assembled into the context bundles an agent actually loads.

That second point was decided the other way in the first revision of this spec, which treated `contextops` as
prior art to imitate. Reviewer instruction on [PR #28](https://github.com/bluetel/bluetel-ai/pull/28) — _"we were
hoping to use this tool as a dependency dont re-write it"_ — reversed it, and reversing it deleted three
hand-written algorithms, a set of invented scoring weights, and the obligation to keep all of them correct.

It is worth being blunt about what this **cannot** do, since the issue title says "quality". It cannot tell you
whether a prompt elicits good behaviour from a model. It makes no model calls and forms no opinion about wording.
It checks the properties of an instruction document that are mechanically decidable — that its references resolve,
that its metadata is complete and consistent, that it does not contradict the repo's own configuration, that it
has not been left half-written, and that it is not bloated or duplicated. Those properties are a floor, not a
ceiling. A prompt can pass every rule here and still be a bad prompt. But no prompt that fails these rules is a
good one.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - A contributor edits a skill and learns immediately that it is broken (Priority: P1)

Someone — a person or an agent — edits `tooling/skills/catalog/review/SKILL.md`, adding a step that reads a new
reference file, and renames an existing reference while they are there. Before the change can be committed, the
validator runs over the artifacts the branch touched, reports that one referenced path does not exist and that
`skill.meta`'s `version` was not bumped, and names the file, the line, the rule, and the fix for each. They fix
both and the run passes.

**Why this priority**: This is the entire value proposition, and it is the only story that changes what lands in
the repository at the moment it is cheapest to change. Every other story is a safety net for a defect this story
would have prevented. A validator that only runs in CI still lets the broken prompt exist, be committed, be
pushed, and be read by an agent on the way. Delivered alone, this story is a usable product: a contributor gets a
correct, actionable verdict on their own changes in seconds, with no CI round-trip.

**Independent Test**: On a branch, break a reference path in one artifact and omit a required metadata field in
another. Run the validator diff-scoped against the base branch. Confirm it exits non-zero, reports exactly those
two findings with file, line, rule identifier and remediation, and reports nothing about the hundreds of
artifacts the branch did not touch. Fix both; confirm it exits zero.

**Acceptance Scenarios**:

1. **Given** a branch whose diff adds a `SKILL.md` line referencing a path that does not exist, **When** the
   validator runs diff-scoped against the base ref, **Then** it reports one finding naming the artifact, the line
   number, the unresolved path and the rule, and exits non-zero.
2. **Given** a branch whose diff modifies a catalog `SKILL.md` without changing its `skill.meta` `version`,
   **When** the validator runs diff-scoped, **Then** it reports a finding stating that a content change requires a
   version bump, and names the current version.
3. **Given** a branch whose diff touches only source code and no AI-authored artifact, **When** the validator
   runs diff-scoped, **Then** it evaluates no artifacts, states that there was nothing in scope, and exits zero.
4. **Given** a branch whose diff **deletes** an artifact that another artifact references, **When** the validator
   runs diff-scoped, **Then** the finding is reported against the surviving artifact that now has a dangling
   reference, even though that artifact is not itself in the diff.
5. **Given** a finding, **When** it is reported, **Then** its message states what is wrong and what to do about
   it, without requiring the reader to open the validator's source to interpret the rule identifier.

---

### User Story 2 - CI refuses to merge a pull request that degrades the prompt surface (Priority: P2)

A pull request is opened. Alongside the existing code-health gate, a prompt-quality gate runs against the PR's
diff, applies thresholds that live in one central place, and reports a pass or fail with the full finding list in
its output. A PR that introduces an error-severity finding cannot be merged green.

**Why this priority**: A local check that can be skipped is advice; the gate is what makes it a rule. It ranks
below US1 only because it is strictly later in the timeline — by the time CI speaks, the bad prompt is already
pushed. It is not optional: the repository's own constitution states that quality signals are gates and that
thresholds must not be weakened to make a change land, and a prompt surface with no gate is the one surface where
that principle currently does not apply.

**Independent Test**: Open a pull request containing exactly one error-severity prompt defect. Confirm the gate
job fails, that its log names the finding, and that the failure is attributable to this gate rather than to lint,
typecheck, tests or the code-health gate. Remove the defect; confirm the job passes.

**Acceptance Scenarios**:

1. **Given** a pull request whose diff introduces one error-severity finding, **When** CI runs, **Then** the
   prompt-quality gate fails, and its output lists the finding with artifact, line, rule and remediation.
2. **Given** a pull request whose diff introduces only warning-severity findings, **When** CI runs, **Then** the
   gate reports them and passes, because the configured budget for warnings has not been exceeded.
3. **Given** a pull request that touches no AI-authored artifact, **When** CI runs, **Then** the gate passes
   without evaluating any artifact and says so.
4. **Given** an attempt to make a failing pull request pass by lowering a threshold, **When** the diff is
   reviewed, **Then** the threshold change is visible as an edit to the single central configuration and is
   reviewable as a deliberate act, not buried in a per-invocation flag or an environment variable set in CI.
5. **Given** the base ref is not available locally (a shallow checkout), **When** the gate runs diff-scoped,
   **Then** it fails with a message naming the missing ref and how to make it available, rather than silently
   evaluating zero artifacts and passing.

---

### User Story 3 - A skill cannot be published to other projects broken (Priority: P3)

A maintainer adds or edits a skill in `tooling/skills/catalog/` and publishes by pushing. Because the catalog
_is_ the distribution mechanism — a target project installs the file verbatim and executes it — the validator
covers the catalog-specific invariants that no other check knows about: every `skill.meta` field present and
well-formed, `assets=` naming a bundle that exists, `next_step=` lines shaped correctly, `requires=` naming
skills that exist, the installed copies under `.agents/skills/` and `.claude/skills/` not drifting from the
catalog, and the `.claude/` pointer actually pointing at the shared file it claims to.

**Why this priority**: The blast radius here is the largest in the repository — a broken catalog entry is copied
into every project that installs it, and the hash-based update model means a target has no way to tell a
deliberate edit from a defect. It ranks third only because the existing `pnpm nx test skills` suite already
validates part of the `skill.meta` contract from the shell side, so this is hardening a partially-covered surface
rather than an uncovered one.

**Independent Test**: For each catalog invariant, construct a violating catalog entry in a scratch copy, run the
validator over it, and confirm exactly the corresponding rule fires. Then confirm a clean catalog produces no
findings.

**Acceptance Scenarios**:

1. **Given** a catalog skill whose `skill.meta` declares `assets=` naming a bundle directory that does not
   exist, **When** the validator runs over the catalog, **Then** it reports the missing bundle.
2. **Given** a catalog skill whose `skill.meta` omits `description`, or whose `description` lacks the
   `Use when:` trigger clause that makes the skill discoverable, **When** the validator runs, **Then** it reports
   each as a separate finding against the metadata file.
3. **Given** a catalog skill whose installed copy under `.agents/skills/<name>/SKILL.md` differs from the
   catalog content, **When** the validator runs over the whole repository, **Then** it reports the drift, naming
   both paths.
4. **Given** a `.claude/skills/<name>/SKILL.md` pointer whose frontmatter `name` or `description` disagrees with
   the catalog `skill.meta`, or which does not reference the shared `.agents/skills/<name>/SKILL.md` file,
   **When** the validator runs, **Then** it reports the inconsistency.
5. **Given** a `skill.meta` `next_step=` line with fewer than the two mandatory `|`-separated fields, **When**
   the validator runs, **Then** it reports the malformed line rather than accepting a recommendation that will
   render as an empty rationale in the installer.

---

### User Story 4 - Anyone can see the whole prompt surface's health, and an agent can consume it (Priority: P4)

Someone runs the validator over every artifact in the repository, without a diff. They get a bounded health score
for each context bundle — the guidance every run loads, and each skill as an agent actually receives it — and for
the repository as a whole, broken into the dimensions that produced it, plus the ranked finding list. Passing a
flag yields the same report as structured data, so an agent asked to "clean up our prompts" can read it directly
instead of parsing human prose.

**Why this priority**: This is the reporting and triage half, valuable for planning work rather than blocking it.
It is genuinely last: the gate stories deliver value with nothing but a pass/fail and a finding list, and a score
that nothing blocks on is a metric, not a control. It earns its place because the score is what makes the surface
comparable over time and across repositories — and because the agents that write most of these artifacts are also
the most efficient consumers of the fix list.

**Independent Test**: Run the validator in all-files mode over this repository. Confirm it produces a per-bundle
and aggregate score with a per-dimension breakdown, that the same run with the machine-readable flag emits valid
structured output carrying every field the human output showed, and that two runs over an unchanged tree produce
byte-identical results.

**Acceptance Scenarios**:

1. **Given** the repository as it stands, **When** the validator runs in all-files mode, **Then** it reports a
   score in the range 0–100 for each context bundle and for the repository, with the contribution of each scoring
   dimension shown, and names the analyser and version that computed it.
2. **Given** any run, **When** the machine-readable flag is passed, **Then** the output is valid structured data
   against a documented schema, containing every finding with artifact, line, rule, severity and remediation, and
   the scores.
3. **Given** an unchanged working tree, **When** the validator runs twice, **Then** both runs produce identical
   findings, identical scores and the same exit code — no ordering instability, no timestamps, no machine-specific
   paths in the report body.
4. **Given** two artifacts loaded together in one bundle that share a substantial identical instruction block,
   **When** the validator runs over both, **Then** it reports the redundancy once, naming both locations, rather
   than once per file.
5. **Given** an artifact whose content is far above the configured token budget, **When** the validator runs,
   **Then** it reports the budget breach with the measured and permitted sizes, so the finding is arguable on
   numbers rather than taste.
6. **Given** the external analyser is not available on the machine, **When** the validator runs, **Then** it
   fails with its own exit code and names each supported way to provide it — and does not report a score, a pass,
   or a repository that looks clean because half the checks did not run.

---

### Edge Cases

- **The base ref is missing or the checkout is shallow.** The diff cannot be computed. The run fails loudly
  naming the ref, rather than treating "no changed files" as success (US2 scenario 5).
- **An artifact is unparseable** — malformed frontmatter, invalid `key=value` metadata, a broken code fence. The
  parse failure is itself a finding at error severity, and the rules that depend on parsing are reported as
  not-evaluated for that artifact rather than silently passing.
- **An artifact is deleted in the diff.** It is not evaluated, but artifacts referencing it are (US1 scenario 4).
- **A path is referenced that exists only at agent runtime** — a directory created by a step earlier in the
  procedure, or a path inside a target project rather than this repo. This must be expressible as a suppression
  so the rule stays useful; unsuppressed, it is a false positive that would train people to ignore the gate.
- **A rule fires on the validator's own documentation.** Its own rule catalogue quotes the placeholder tokens and
  bad examples it detects. The tool must not be structurally unable to describe itself.
- **The `.claude/` pointer files are near-identical by design** (one sentence plus frontmatter, seventeen times
  over). Redundancy detection must not report the intended shape of the installer as a defect.
- **A generated or vendored artifact** — a third-party skill carrying its own `LICENSE.txt`, an `AGENTS.md`
  region owned by an external tool and marked as auto-maintained. These are not ours to rewrite, and must be
  excludable by path or region without disabling the rule everywhere.
- **Two thresholds disagree with each other** — a per-artifact minimum score that no artifact could reach given
  the maximum permitted findings. Contradictory configuration must be rejected at startup, not resolved
  arbitrarily at the end of a run.
- **A rule is newly added to the catalogue.** Every pre-existing artifact that violates it would fail the gate on
  the next unrelated pull request that touches them. Adoption of a new rule must be stageable — introducible at a
  non-blocking severity, or with a recorded set of known pre-existing violations — so adding a rule is not the
  same act as breaking the build.
- **An artifact is empty, or is a symlink, or is not valid UTF-8.** Each is reported as a finding rather than
  crashing the run or being skipped in silence.
- **The external analyser is absent, or is the wrong version.** A developer machine without Python, a CI job whose
  setup step was removed, a version that drifted from the pin. The run fails with its own exit code and a message
  naming the ways to provide it. It must not report a pass on half the checks, and must not fall back to an
  internal approximation — a score computed by a different engine than the pinned one is not comparable with the
  one in the last report, which is the whole point of pinning it.
- **The analyser is present but cannot run** — no cached tokenizer vocabulary and no network, or it exits
  non-zero on a payload. Reported as a run failure naming the bundle and the analyser's own message, never as a
  clean bundle.
- **A skill has no references and is short.** Its context bundle is nearly all fixed guidance prefix. Structure
  and concentration will say so, correctly — that is a real property of what the agent receives — but it must be
  reported in a way that names the guidance documents as the cost, not the small skill as the offender.
- **No artifacts exist at all** (the validator adopted by a fresh project). The run succeeds, states that it found
  no artifacts, and does not report a perfect score for an empty set.

## Requirements _(mandatory)_

### Functional Requirements

**Artifact discovery and classification**

- **FR-001**: The validator MUST identify which files are AI-authored artifacts from a declared, inspectable set
  of location patterns, and MUST NOT evaluate files outside that set.
- **FR-002**: The declared set MUST cover, at minimum: the skill catalog (`SKILL.md` and `skill.meta` per skill),
  the installed shared skills (`.agents/skills/*/**`), the agent-facing pointers (`.claude/skills/*/SKILL.md`),
  repo-level agent guidance (`AGENTS.md`, `CLAUDE.md`, `.claude/rules/*.md`, `.agents/*.md`), and the Spec Kit
  prompt surface (`.specify/templates/*.md`, `.specify/memory/constitution.md`).
- **FR-003**: Each artifact MUST be classified into a kind, and the rules that apply MUST be a function of that
  kind — a catalog `skill.meta` rule MUST NOT be applied to `AGENTS.md`.
- **FR-004**: A file matching a declared location but of an unrecognised kind MUST be reported as unclassified
  rather than skipped silently, so the artifact set cannot grow a blind spot by accident.
- **FR-005**: The validator MUST support excluding paths and marking regions of an artifact as not-ours
  (generated, vendored, externally maintained), and MUST report what it excluded.

**Rules, findings and severity**

- **FR-006**: Every check MUST be a named rule with a stable identifier, a severity, a one-line statement of what
  it enforces, and a rationale — all discoverable from the tool itself, not only from source.
- **FR-007**: A finding MUST carry: the artifact path, the line (and where meaningful the column or region), the
  rule identifier, the severity, what is wrong, and what to do about it.
- **FR-008**: Severity MUST have at least three levels: one that fails the gate, one that is reported without
  failing, and one informational.
- **FR-009**: A rule MUST be suppressible for a specific occurrence, in-artifact, with a required reason; a
  suppression without a reason MUST itself be a finding.
- **FR-010**: Suppressions MUST be reported in the run summary, and a suppression that no longer matches anything
  MUST be reported as stale.
- **FR-011**: The rule set MUST be extensible by adding one self-contained rule, without modifying the other
  rules, and a new rule MUST be introducible at a non-blocking severity (see FR-035).

**Rules that must exist**

- **FR-012**: **Metadata completeness** — required metadata fields present and non-empty for the artifact's kind
  (`name`, `version`, `description` in `skill.meta`; `name` and `description` in `.claude/` frontmatter).
- **FR-013**: **Metadata well-formedness** — no duplicated keys, `version` a valid semantic version, no unparsed
  or stray lines.
- **FR-014**: **Trigger clause** — a skill description states when to use the skill (the `Use when:` convention),
  because a description without it is not discoverable by the agent that needs it.
- **FR-015**: **Reference resolution** — every repo-relative path and every relative markdown link a prompt tells
  an agent to read MUST resolve to an existing file, evaluated across the whole repository so that deleting a
  referenced file fails the run.
- **FR-016**: **Section presence** — an artifact of a kind that requires named sections (e.g. a skill's
  completion criteria) MUST have them.
- **FR-017**: **Placeholder residue** — no unresolved authoring tokens (bracketed template slots such as the
  feature-name and date placeholders, clarification markers, `$ARGUMENTS` outside its intended slot, `TODO`) in
  an artifact that is not itself a template.
- **FR-018**: **Convention agreement** — an artifact MUST NOT state a convention that contradicts
  `.agents/skills.config` or the constitution: ticket prefix, branch pattern, commit format, base and staging
  branch, repository owner and name.
- **FR-019**: **Catalog/installed drift** — the installed copy of a skill MUST match its catalog source, except
  for the data files the installer's model deliberately leaves per-project (the config file and asset bundles).
- **FR-020**: **Version bump on content change** — a change to a catalog skill's hashed content within a diff
  MUST be accompanied by a `version` change in its `skill.meta`.
- **FR-021**: **Declared dependencies exist** — `requires=` names installable skills, `assets=` names an existing
  bundle, `next_step=` lines carry their mandatory fields.
- **FR-022**: **Redundancy** — substantially duplicated instruction between the artifacts an agent loads together
  MUST be reported once, naming every location, with the duplicated size measured.
- **FR-023**: **Density** — token waste from formatting and structural bloat within a loaded context MUST be
  measured and reported against a threshold.
- **FR-024**: **Token cost** — the token cost of an artifact and of a whole context bundle MUST be measured and
  reported against a configured budget, with measured and permitted sizes named.
- **FR-025**: **Structure** — an artifact MUST be reported when its shape is degenerate for its kind: no headings,
  a single undifferentiated block, or a heading hierarchy that skips levels. A context bundle MUST be reported
  when the distribution between its components is imbalanced, or when a single artifact dominates it.
- **FR-026**: **Contradiction within an artifact** — a directive that both requires and forbids the same
  mechanically-comparable thing (e.g. two metadata fields with conflicting values, or a stated rule and its
  negation in the same artifact) MUST be reported. Scope is limited to mechanically decidable contradictions.

**Scoring**

- **FR-027**: The validator MUST report a bounded health score (0–100) per context bundle and for the whole run,
  derived only from the measurements of that run.
- **FR-028**: The score MUST decompose into named dimensions, each with a maximum contribution, and the
  decomposition MUST be shown wherever the score is shown.
- **FR-029**: Scoring MUST be deterministic: identical input produces an identical score, with no dependence on
  file ordering, wall-clock time, machine, or working directory.
- **FR-030**: A run over an empty artifact set MUST NOT report a score, and MUST state that the set was empty.
- **FR-048**: The score MUST be reported exactly as the tool that computes it produces it — not re-weighted, not
  reduced by dropping a dimension, and not blended with findings from other rules. Correctness findings MUST be
  reported alongside the score, never folded into it.

**Depending on an external analyser**

- **FR-049**: The measurements in FR-022 – FR-025 and the score in FR-027 MUST be obtained from an existing,
  deterministic, offline context analyser rather than reimplemented. The validator's own responsibility for them
  is limited to assembling the input and mapping the results into its finding and reporting model.
- **FR-050**: The external analyser's version MUST be pinned exactly in the same central configuration as the
  thresholds, and MUST be verified at startup. A version other than the pinned one MUST fail the run naming both
  versions, because a different engine silently produces different scores.
- **FR-051**: When the analyser cannot be found or run, the validator MUST fail with a distinct, documented exit
  code and a message naming each supported way to provide it. It MUST NOT skip those checks and report a pass,
  and MUST NOT silently substitute an internal approximation.
- **FR-052**: The validator MUST NOT install, vendor, bundle or redistribute the analyser. Making it available is
  the operator's decision, on the operator's machine, under the analyser's own licence.
- **FR-053**: Everything that depends on the analyser MUST be isolated behind a single internal boundary, so that
  replacing it, or running without it, is a bounded change. A documented mode MUST exist that runs the
  repository's own rules alone, states in its output that the delegated checks were not evaluated, and MUST NOT
  be usable to satisfy the pull-request gate.

**Invocation, scope and gating**

- **FR-031**: The validator MUST run diff-scoped against a base ref by default, and MUST support an all-files
  mode.
- **FR-032**: The validator MUST fail with an actionable message when the requested base ref cannot be resolved,
  rather than reporting an empty scope as success.
- **FR-033**: The validator MUST exit non-zero exactly when a configured threshold is breached, and its exit
  codes MUST form a documented, stable contract that distinguishes a gate failure from a usage error, an
  unreadable artifact set, and an internal failure.
- **FR-034**: All thresholds MUST live in a single, centrally-located configuration, so lowering one is a
  reviewable edit to that file. Per-invocation overrides MAY exist for local investigation only and MUST be
  documented as such, and the run output MUST state when an override is in effect.
- **FR-035**: The validator MUST support staged adoption of a new rule — introducing it non-blocking, or
  recording the set of known pre-existing violations — so that adding a rule does not fail unrelated changes.
- **FR-036**: Contradictory or unparseable configuration MUST be rejected before any artifact is evaluated, with
  a message naming the conflicting settings.

**Output**

- **FR-037**: Human-readable output MUST lead with the verdict and the counts by severity, then the findings
  ordered by severity and path, and MUST cap an unbounded finding list with a stated count of what was omitted.
- **FR-038**: A machine-readable output mode MUST emit the complete report — every finding field, the scores and
  their dimensions, the scope, the thresholds in effect, and the suppressions — against a documented schema.
- **FR-039**: Output MUST NOT contain absolute machine-specific paths, timestamps, or any other value that varies
  between runs over identical input.
- **FR-040**: When nothing is in scope, the output MUST say so explicitly rather than printing an empty report
  that reads identically to a clean pass.

**Integration**

- **FR-041**: The validator MUST be runnable through the workspace's task orchestrator from the repository root,
  and MUST be runnable in isolation from its own project directory.
- **FR-042**: The validator MUST run as a blocking check on every pull request, scoped to that pull request's
  diff.
- **FR-043**: The validator MUST be runnable in the existing pre-commit path over the staged artifacts, fast
  enough that skipping it is never worth it.
- **FR-044**: The catalog invariants (FR-012 – FR-014, FR-016, FR-020, FR-021) MUST be verifiable as part of the
  skills project's own checks, so a skill cannot be published broken.
- **FR-045**: The validator MUST be adoptable by a project that installs skills from this repository, without
  requiring that project to adopt this repository's toolchain beyond what installing skills already requires.
- **FR-046**: The validator MUST make no model or inference calls, and MUST make no network request whose result
  could change a finding, a score or a verdict. The one permitted exception is the one-time, cached download of a
  tokenizer vocabulary by the external analyser on a machine that has never run it; the run MUST work offline
  once that cache exists, and MUST fail with an actionable message rather than degrade when it does not.
- **FR-047**: Every rule MUST be documented in a single human-readable catalogue that states its identifier,
  severity, rationale, and how to fix a violation — and that catalogue MUST be verified against the implemented
  rule set, so a rule cannot exist undocumented and a documented rule cannot cease to exist.

### Key Entities

- **Artifact**: A file whose audience is an LLM. Has a path, a kind, raw content, a parsed representation where
  its kind defines one, and a measured size.
- **Artifact kind**: The classification that decides which rules apply and which budgets and required sections
  hold — catalog skill body, catalog skill metadata, installed shared skill, agent pointer, repo guidance
  document, Spec Kit template, constitution.
- **Context bundle**: A set of artifacts an agent loads together for one run — the repository-wide guidance, plus
  one bundle per skill consisting of that guidance and the skill's own body and references. The unit the
  context-economy measurements and the score are computed over, because it is the unit an agent experiences.
- **Rule**: A named, deterministic check over one artifact, over the artifact set, or over a context bundle. Has a
  stable identifier, a default severity, an enforcement statement, a rationale, the kinds it applies to, and
  whether it is evaluated here or delegated to the external analyser.
- **Finding**: One violation. Carries artifact, location, rule identifier, severity, what is wrong, and the
  remediation. Ordered deterministically.
- **Severity**: Blocking, reported-but-passing, or informational. Configurable per rule.
- **Suppression**: An in-artifact, reasoned exemption of one rule at one location. Reported, and reported again
  when it goes stale.
- **Scorecard**: The bounded score for a context bundle or a run, decomposed into named dimensions with maximum
  contributions, and attributed to the analyser and version that produced it.
- **Scope**: The artifact set a run evaluates — the diff against a base ref, the staged set, or everything —
  together with what was excluded and why.
- **Thresholds**: The single central set of limits that decide pass or fail: permitted counts by severity,
  minimum scores, size budgets, redundancy and density limits.
- **Report**: A run's complete result — verdict, scope, findings, scorecards, thresholds in effect, suppressions
  — rendered either for a human or as structured data.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: Every one of the failure modes listed in "Why This Change" is caught by a named rule, demonstrated
  by a test that reproduces the failure and asserts the rule fires.
- **SC-002**: A diff-scoped run over a typical branch (fewer than 20 changed artifacts) completes in under 10
  seconds on a developer machine, and a whole-repository run in under 60 seconds. The repository's own rules
  account for under 2 seconds of either; the remainder is the external analyser, and the mode that skips it
  returns the run to under 2 seconds.
- **SC-003**: The validator reports zero error-severity findings against this repository's artifacts once
  adoption is complete — the surface it gates is a surface it passes.
- **SC-004**: Every rule has at least one test proving it fires on a violating artifact and one proving it does
  not fire on a compliant one; the second is what keeps the gate from being ignored.
- **SC-005**: Two runs over an identical tree produce byte-identical reports in both output modes — including the
  delegated measurements and the score, and including a run on a different machine with the pinned analyser
  version.
- **SC-006**: A contributor can go from a failing run to a fixed artifact using only the run's output — no rule
  requires reading the validator's source to understand what to change. Verified by review against the rule
  catalogue.
- **SC-007**: A new rule can be added by one self-contained change to the rule set plus its tests and catalogue
  entry, touching no existing rule.
- **SC-008**: The blocking pull-request check fails for a pull request containing exactly one error-severity
  prompt defect and no other defect, and passes for the same pull request with that defect removed.
- **SC-009**: No threshold can be relaxed without an edit to the single central configuration file appearing in
  the diff.
- **SC-010**: The rule catalogue and the implemented rule set cannot disagree — a rule added without a catalogue
  entry, or an entry without a rule, fails the validator's own checks.
- **SC-011**: The false-positive rate on this repository's existing artifacts, measured at adoption, is zero at
  error severity: every error-severity finding at adoption is either fixed or has a reasoned suppression, and no
  rule is disabled wholesale to reach that state.

## Assumptions

Recorded because the request was made in a non-interactive run with no opportunity to ask.

- **Deterministic only, and honest about it.** No model calls, no network, no judgement of whether a prompt
  works. "Quality" in the issue title is scoped to the mechanically decidable properties enumerated in FR-012 –
  FR-026. Semantic prompt evaluation (LLM-as-judge over skill behaviour) is a separate, later feature and is out
  of scope here.
- **`contextops` is a dependency, pinned at `0.3.3`.** Decided by reviewer instruction on
  [PR #28](https://github.com/bluetel/bluetel-ai/pull/28), and it is the right call: it computes redundancy,
  density, structure, concentration, token cost and the 0–100 score, guarantees determinism, runs offline, and
  ships a command that verifies its own stability. The validator calls it rather than imitating it. What the
  validator still owns is the half `contextops` cannot know — `skill.meta`, `.agents/skills.config`, the
  catalog-to-target install model — and the input: turning this repository's files into the context bundles an
  agent actually loads.
- **Nothing about the dependency is installed, shipped or vendored by this feature.** `contextops` is Python under
  the Sustainable Use License, whose grant covers _"your own internal business operations"_ but not provision to
  third parties as part of a commercial offering. Running it in this repository's CI is inside that grant;
  shipping it to a client project is not, so the validator never does. **This reading was made by an agent from
  the licence text and needs a human to confirm it before anything client-facing depends on it.** The
  never-ship stance means that confirmation is only ever needed to unblock new work, never to undo shipped work.
- **The dependency being absent is a failure, not a downgrade.** A run without `contextops` reports what it could
  not evaluate and exits with its own code. A gate that quietly checks less when a tool is missing is worse than
  no gate, because it reads identically to a clean pass.
- **Artifact set is fixed at what exists today**, per FR-002. `apps/` and `packages/` currently hold no
  AI-authored prompt artifacts; when they do, they are added to the declared set rather than discovered by
  heuristic.
- **Token counts are exact for an OpenAI encoding, and a consistent proxy for a Claude one.** They come from the
  analyser's `tiktoken`-backed breakdown under a named encoding, which the report states. The absolute number is
  not what an Anthropic model would charge; the comparison between artifacts, and against a budget calibrated on
  the same scale, is sound.
- **Snapshot comparison between two reports is deferred, not out of scope.** The analyser already provides it as
  a command. Wiring it is a decision to take once two reports worth comparing exist, rather than work to plan.
- **Adoption is staged.** The gate is introduced with existing violations either fixed or explicitly recorded
  (FR-035), so turning it on does not fail every unrelated pull request in flight. SC-003 and SC-011 are the
  end-state of that staging, not preconditions for merging the validator.
- **Existing coverage is not duplicated.** `pnpm nx test skills` already asserts part of the `skill.meta`
  contract from the shell side; where a rule overlaps, the validator is the authority for the artifact's
  _content_ and the shell tests remain the authority for the _installer's behaviour_.
- **Redundancy across the two installed trees is expected, not a defect.** The installer's model deliberately
  produces a shared `.agents/skills/<name>/SKILL.md` plus a near-identical thin `.claude/skills/<name>/SKILL.md`
  pointer for every skill; the redundancy rule is calibrated against that shape from the start.
- **This repository is the first adopter and the reference implementation.** FR-045 requires that a target
  project _can_ adopt it; shipping it into targets, and the installer work that would entail, is not part of this
  feature.
