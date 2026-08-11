# Specification Quality Checklist: Static prompt-quality validator for AI-authored artifacts

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-11
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) — with the two recorded exceptions below
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders — insofar as the domain permits (see exception 2)
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`.

### Validation record

Validated in a single pass, then re-validated after the `contextops`-as-dependency revision of 2026-08-11. Every
item still passes. The revision added FR-048 – FR-053, changed FR-022 – FR-025, FR-027, FR-046 and SC-002,
SC-005, and introduced one new key entity (context bundle); each of the new requirements is testable, and
scenario 5 in [quickstart.md](../quickstart.md) exercises the ones about the dependency being absent.

One checklist item deserves a second look after the revision — _"no implementation details leak into
specification"_ — because the spec now names a specific third-party tool and a version. The naming is in
**Assumptions** and in the FRs' rationale, not in the requirements themselves: FR-049 – FR-053 are written
against "an external context analyser", so a reader can evaluate the requirement without accepting the choice,
and a future replacement would change the assumption rather than the requirement. That is the honest line
between a constraint the feature accepts and an implementation detail it should not be asserting.

Four further observations are recorded rather than treated as failures, because each is a property of the
subject matter rather than a defect in the writing.

1. **The spec names concrete file paths throughout** — `tooling/skills/catalog/`, `.agents/skills.config`,
   `.claude/skills/<name>/SKILL.md`, `.specify/templates/*.md`. This is a deliberate exception to "no
   implementation details". Those paths **are the subject** of the feature: the thing being validated is a
   specific set of files at specific locations, and FR-002 would be untestable if it described them abstractly
   ("the agent guidance documents"). The paths are also externally visible — a target project installing skills
   sees exactly these locations — so naming them describes a public surface, not an internal structure. No
   requirement names a language, framework, library, or module boundary.

2. **"Non-technical stakeholder" has a narrow meaning here.** The users of this feature are the maintainers and
   agents that write this repository's prompts; there is no non-technical user of a lint gate. The spec is
   written so that someone who has never opened this repository can follow _why_ each rule exists and _what_
   breaks without it — which is the reachable form of that criterion for developer tooling. It does not assume
   familiarity with TypeScript, Nx, or the validator's internals.

3. **FR-014 names the `Use when:` string literally**, and FR-012/FR-021 name `skill.meta` keys (`name`,
   `version`, `description`, `requires`, `assets`, `next_step`). These are data-format identifiers in an
   existing published contract that other projects already consume, not implementation choices this feature is
   free to make. A requirement that said "the description should indicate applicability" would not be checkable
   against the convention that actually exists.

4. **One functional requirement is deliberately bounded rather than fully specified.** FR-026 (contradiction
   detection) restricts itself to "mechanically decidable contradictions" instead of enumerating them. Full
   enumeration would either be arbitrary or would smuggle in the semantic judgement the whole spec excludes; the
   bound is the honest form of the requirement, and the acceptance scenarios it needs are supplied by example
   (conflicting metadata values, a rule and its negation) rather than exhaustively.

### Clarifications not asked

This spec was produced in a non-interactive CI run where asking is not possible, so the three decisions that
would otherwise have been clarification questions were resolved as informed guesses and recorded in
**Assumptions** instead:

| Decision                                                  | Taken as                                                                                     |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Does "quality" include semantic/LLM-judged evaluation?    | No — deterministic only; semantic evaluation is a separate later feature                     |
| Do we adopt `contextops` itself, or only its shape?       | ~~Shape only~~ → **the tool itself, pinned at `0.3.3`**. Answered by the reviewer; see below |
| Is the gate blocking from day one on existing violations? | No — staged adoption via FR-035; SC-003/SC-011 are the end state, not a precondition         |

### Resolution of the `contextops` guess — 2026-08-11

The second guess was **wrong**, and the correction is the most useful thing this checklist records. It was
resolved on [PR #28](https://github.com/bluetel/bluetel-ai/pull/28): _"we were hoping to use this tool as a
dependency dont re-write it"._

What the guess got wrong, in order of how much it cost:

1. **It treated "no new dependency" as a virtue rather than a trade.** The price of that virtue was hand-writing
   shingle clustering, a token approximation and a bespoke scoring scheme — three algorithms to specify, test,
   calibrate and keep correct, replacing three that already existed with a published determinism guarantee.
2. **It over-read the licence.** The Sustainable Use License permits use for internal business operations, which
   is what a CI gate in this repository is. The real constraint is narrower and was missed: it restricts
   _providing_ the software to third parties, which bears on shipping it to client projects — a question the
   design now answers by never shipping it at all ([research.md](../research.md#r8)).
3. **It over-read the fit objection.** "It knows nothing of `skill.meta`" is true and irrelevant: those checks
   were always going to be ours. The half it does know about is the half we were about to rebuild.
4. **It dropped a dimension it should have kept.** `concentration` was rejected as having no referent for
   hand-authored documents. It has an excellent one — a single reference file dominating a skill's context — and
   the design would have shipped without measuring it.

Recorded rather than quietly amended, because "the agent's informed guess, and then what a human who knew the
context actually wanted" is the useful artifact here.

**One clarification remains open, and it needs a human**: whether Bluetel's use of a Sustainable-Use-licensed
tool is acceptable beyond this repository's own CI. The design is deliberately arranged so the answer is only
needed to unblock new work — nothing is shipped, vendored or installed onto anyone else's machine (FR-052) — but
it should not be treated as settled by an agent reading a licence file.
