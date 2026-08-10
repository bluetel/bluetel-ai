# Specification Quality Checklist: Agent Credential Pool

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-07
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
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

### Validation iteration 1 — findings and resolutions

- **Vendor naming.** The user's phrasing ("Claude provider") named the agent vendor. Carried into the data model
  it would have contradicted the platform's swappable-agent adapter boundary, so the entity is specified as
  **agent credential** with the vendor confined to configuration. Recorded in Clarifications and FR-003.
- **Technology leakage in success criteria.** SC-004, SC-007 and SC-008 originally referenced instance stop/start
  and EC2 billing directly. Rewritten as user-facing outcomes (billed compute is zero, resume is 5× faster).
  The mechanism now appears only in Assumptions, where it belongs as a stated design premise.
- **Superseded requirements.** This specification changes behaviour the platform specification states otherwise
  (notably `002/FR-043`, `002/FR-049`, `002/FR-072`, `002/FR-075`). Left implicit, a planner would have
  implemented both. Now tabulated in [Relationship to 002](../spec.md#relationship-to-002) and cited inline at
  FR-013, FR-039 and FR-048.
- **Unfalsifiable liveness criterion.** An earlier SC-009 asserted seats "do not expire", which cannot be
  observed. Restated as zero expiry-through-idleness events over 30 days including a credential with no workflow
  traffic — the condition that actually exercises the mechanism.

### Validation iteration 2 — pool partitioning resolved

The single outstanding marker (shared pool vs per-profile partitioning) was answered: **credential groups**,
with credentials in exactly one group and execution profiles attached to an ordered list of groups. Added US2,
FR-060–FR-068, SC-016, SC-017, two entities, four edge cases, and scoping changes to FR-024, FR-026, FR-029,
FR-034, FR-053 and FR-054. No markers remain.

Two consequences were followed through rather than left implicit:

- **Preference ordering starves lower-preference groups**, so least-recently-used selection no longer
  guarantees liveness on its own — it only rotates within the group being drawn from. FR-035 now carries that
  burden explicitly, which changes keep-alive from an optimisation into the mechanism the design depends on.
- **The waiting queue is no longer global.** FR-026 grants a released credential to the longest-waiting
  workflow that can reach it, and FR-029/FR-054 report exhaustion per group — otherwise "waiting for a seat"
  would not tell an operator which group to grow.

FR-060–FR-068 sit in a thematically correct position (immediately after credential identity) but are numbered
out of document order. This is deliberate: requirement ids are treated as stable identifiers, and renumbering
would invalidate the supersession citations at FR-013, FR-039 and FR-048 as well as every reference from this
checklist.

### Validation iteration 3 — `/speckit-clarify` session 2026-08-07

Five questions asked and answered; all 16 checklist items still pass (16/16 → 16/16, no state changes). Added
FR-069–FR-079, SC-018–SC-020, and removed User Story 10 along with the exclusive/non-exclusive distinction it
existed to describe. Two corrections worth recording:

- **A contradictory clarification bullet survived a rejected edit.** An earlier draft answer ("the execution
  environment owns the credential for its own lifetime, so a parked workflow releases it") was superseded
  mid-session by the opposite decision, but its bullet remained in the file alongside the accepted one. Found by
  a duplicate-question sweep of the Clarifications block, not by reading — worth repeating as a check after any
  reversed decision.
- **FR-018 was wrong in the original draft** and is now restored to its correct form: the lease belongs to the
  workflow, not the execution environment. FR-019, FR-023, FR-044, FR-046 and User Story 6 were all written
  against the wrong model and have been rewritten.

The session block carries six bullets for five questions. The sixth is a derived corollary — what bounds an
abandoned parked workflow that never releases its seat — recorded because the accepted answer is unsafe without
it, not because a sixth question was asked.

### Naming decisions recorded in the spec rather than adopted verbatim

Two terms from the request were deliberately not carried into the model, each for a stated reason in
Clarifications: "Claude provider" (vendor naming vs. the swappable agent adapter boundary) and "session"
(collides with 002's `session_id` / `session_snapshots`, an unrelated concept). Both remain usable as
user-facing wording. Flagged here because they are visible deviations from the request, not oversights.

### Deliberately deferred to planning, not defects in this specification

The two agent-credential OAuth unknowns recorded in Assumptions — rotation invalidation semantics and the
idle-expiry window — are **research tasks, not specification gaps**. This document states the behaviour required
of the platform in either case; the empirical answers set thresholds and error handling during design. They are
flagged here so they are not mistaken for oversights.
