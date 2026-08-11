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

Validated in a single pass. Every item passed; no spec revision was required. Four observations are recorded
rather than treated as failures, because each is a property of the subject matter rather than a defect in the
writing.

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

| Decision                                                  | Taken as                                                                               |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Does "quality" include semantic/LLM-judged evaluation?    | No — deterministic only; semantic evaluation is a separate later feature               |
| Do we adopt `contextops` itself, or only its shape?       | Shape only — licence (Sustainable Use) and fit (no `skill.meta` awareness) rule it out |
| Is the gate blocking from day one on existing violations? | No — staged adoption via FR-035; SC-003/SC-011 are the end state, not a precondition   |
