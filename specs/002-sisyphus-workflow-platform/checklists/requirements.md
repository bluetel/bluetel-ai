# Specification Quality Checklist: Sisyphus — Supervised & Autonomous Agentic Delivery Platform

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-05
**Last updated**: 2026-08-06 (second `/speckit-clarify` session: 5 clarifications integrated — navigation
shell and root route, notification-preference surfaces, filtered strict typecheck, three-file deployment
config split, infrastructure de-abstraction)
**Feature**: [spec.md](../spec.md)

## Content Quality

- [~] No implementation details (languages, frameworks, APIs) — **documented exception, see Notes**
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [~] Success criteria are technology-agnostic (no implementation details) — SC-015 references the
  design-token/primitive audit, which is inherent to the mandated design requirement
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [~] No implementation details leak into specification — **as above**

## Coverage Cross-Check

Each user story traces to functional requirements and at least one success criterion. Delivery order is by
priority, not story number: US7 + US12 + US13 (together) → US1 → US9 → US11 → US2 → US3 → US10 → US8 → US4 → US5 → US6.

| Story                                 | Priority | Requirements                                           | Success criteria                       |
| ------------------------------------- | -------- | ------------------------------------------------------ | -------------------------------------- |
| US7 Register a setup bundle           | P1       | FR-043, FR-075, FR-083..FR-093, FR-147, FR-148         | SC-020, SC-021, SC-022, SC-038         |
| US12 Administer users & roles         | P1       | FR-166..FR-178                                         | SC-046..SC-050                         |
| US13 Scoped access by profile         | P1       | FR-012, FR-013, FR-097, FR-127, FR-129, FR-179..FR-191 | SC-051..SC-055                         |
| US1 Delegated delegation              | P1       | FR-011..FR-019, FR-035..FR-041, FR-060, FR-153         | SC-001, SC-002, SC-007, SC-009, SC-040 |
| US9 Launch from an execution profile  | P1       | FR-016, FR-121..FR-129                                 | SC-027, SC-028, SC-029, SC-030         |
| US11 Be told when you are needed      | P1       | FR-132..FR-144, FR-145, FR-146                         | SC-034..SC-037, SC-042, SC-059         |
| US2 Pause and correct                 | P1       | FR-044, FR-049, FR-081                                 | SC-003, SC-004                         |
| US3 Resume on a fresh instance        | P2       | FR-050..FR-054, FR-082, FR-149..FR-152                 | SC-005, SC-008, SC-019, SC-039         |
| US10 Multi-repository workspace       | P2       | FR-109..FR-120                                         | SC-031, SC-032, SC-033                 |
| US8 Configure a Jira integration      | P2       | FR-074, FR-094..FR-108, FR-130, FR-131, FR-154, FR-155 | SC-023..SC-026, SC-041                 |
| US4 Autonomous loop                   | P2       | FR-057..FR-059, FR-061, FR-062, FR-076..FR-079         | SC-010, SC-016, SC-018                 |
| US5 Standalone review                 | P3       | FR-063, FR-080, FR-119                                 | SC-016, SC-018                         |
| US6 Operate and audit                 | P3       | FR-012..FR-014, FR-064, FR-065, FR-105, FR-156         | SC-011..SC-014, SC-026                 |
| Prompt assembly (cross-cutting)       | —        | FR-157..FR-165                                         | SC-043, SC-044, SC-045                 |
| Design system (cross-cutting on US1)  | —        | FR-020..FR-034, FR-201                                 | SC-015                                 |
| Infrastructure & delivery             | —        | FR-066..FR-072, FR-198..FR-200, FR-202                 | SC-007, SC-017, SC-060, SC-061         |
| Assembly & verification integrity     | —        | FR-003, FR-004, FR-203, FR-204, FR-205                 | SC-062..SC-065                         |
| Application shell & entry (US1, US13) | —        | FR-193..FR-197                                         | SC-056, SC-057, SC-058                 |

## Resolved Clarifications

**From the initial validation pass** — both `[NEEDS CLARIFICATION]` markers closed:

1. **FR-074 — autonomous pipeline entry.** Resolved: an **explicit label on the ticket**, discovered by an
   enabled integration on its next scheduled poll. Ticket creation alone starts nothing, so the human
   applying the label is the opt-in and the spend bound.
2. **FR-075 — agent credential model.** Resolved by generalising it into **setup bundles** (FR-083..FR-093)
   rather than choosing one platform-wide credential. Credentials arrive via a versioned archive whose
   `setup.sh` installs them. One consequence is recorded rather than hidden: spend-cap enforceability now
   depends on the credential a bundle installs, so FR-093 requires a bundle to declare whether caps are
   enforceable under it and the panel to surface that where a cap is set.

**From the `/speckit-clarify` session** — see `## Clarifications` in the spec:

3. **Terminology.** The bootstrap archive is a **Setup Bundle**; the launch preset is an **Execution Profile**.
   Applied throughout; the two words are not interchangeable. This closes the naming collision previously logged
   here as outstanding.
4. **Prompt assembly (FR-157..FR-165).** Layered: execution profile preamble (codebase context) → integration
   prompt intro (how work from this board is approached) → ticket title, URL, description, comments. Sisyphus's
   own ticket comments are excluded so its write-back cannot become its own input, and the assembled prompt is
   recorded as sent because tickets change afterwards.
5. **Admin role (FR-166..FR-178).** Two roles — engineer and admin. Only admins register, replace, enable or
   disable a setup bundle. Adds admin-only user management, first-admin-from-configuration bootstrap, and a
   never-zero-admins invariant.
6. **Profile-scoped access (FR-179..FR-191).** The execution profile is the unit of access control: admins
   configure everything and see all runs; engineers launch and see only within granted profiles, plus any
   workflow they own or initiated. This superseded the earlier "supervision by initiator and leads" rule, which
   referenced a role that never existed and an identity that is frequently not the owner.

## Notes

**Deliberate deviation — named technologies in the spec.** The standard bar is that a spec names no
technologies. This spec names several (the project and package names, Claude Code, Jira, GitHub, Google
OAuth, GitHub Actions, shadcn-style primitives, Archivo / IBM Plex Mono, literal design-token hex values, and the
`tar.gz` + `setup.sh` profile format). Every one was specified by the requester as a hard constraint rather
than inferred, so removing them would lose requirement content rather than clean the document up. They are
recorded as requirements, not as design decisions deferred to planning. Genuine implementation choices —
schema shape, streaming transport, snapshot format, provisioning mechanics, and which scheduling primitive
backs integration crons — remain for `plan.md`.

**Naming collision — resolved.** Previously logged here as outstanding; closed by clarification 3. The bootstrap
archive is a **setup bundle**, the launch preset an **execution profile**, and the spec now uses each
consistently.

**Friction-review outcomes (all committed).** A pass over the spec from the perspective of a Bluetel employee
using the system surfaced eleven frictions; nine were addressed by requirement changes and two were decisions:

| Friction                                                | Resolution                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------- |
| Eleven fields per launch                                | Execution profiles — prompt is the only required input     |
| No basis to choose instance size, caps, setup bundle    | Encoded in the execution profile by someone who knows      |
| Setup bundle could mismatch the repositories            | FR-124 validation gate before a profile can be enabled     |
| One repo per run, and per integration                   | Workspaces (multi-entry) + integration profile mappings    |
| No notifications anywhere                               | Slack direct message only (FR-136..FR-141)                 |
| Integration-started workflows had no owner              | FR-132..FR-135, integration default owner mandatory        |
| Labelled tickets failed silently                        | Ticket write-back on pickup, skip and outcome              |
| Opaque multi-minute "provisioning" state                | Named bootstrap phases with per-phase timeouts             |
| Blind upload-fail-fix loop for setup bundles            | Validation runs that stop short of the agent               |
| Immutable job spec blocked raising a cap **(decision)** | Linked successor workflows, immutability preserved         |
| Per-person spend visibility **(decision)**              | Default aggregation by client/workspace, not a leaderboard |

Two frictions remain accepted trade-offs rather than fixed: cron-poll latency (a labelled ticket waits up to
one interval), and the inherent cost of reviewing a diff someone else wrote — mitigated by the reviewer summary
(FR-153) but not eliminated.

**Residual risks to carry into planning, not blockers:**

- **Setup bundles run arbitrary administrator-authored shell with instance privileges.** The spec scopes
  validation to archive verification and exit code (FR-088) and explicitly excludes inspecting what the
  script does (Out of Scope). That is a deliberate trust boundary — profiles are administrator-authored, not
  user-supplied — and it should be restated in the plan's security section rather than rediscovered.
- **Cron-poll latency.** Poll-based discovery means a labelled ticket waits up to one interval before a run
  starts. This is a deliberate trade for self-healing after missed ticks (Assumptions), but the interval is
  now a user-visible latency figure worth agreeing on.
- **Claim-record placement.** FR-102's exactly-once guarantee assumes the claim lives in the platform
  database, not in the tracker. The plan should make that explicit, since putting it in the tracker would
  break the guarantee across a tracker-side change.

Ready for `/speckit-plan`. The multi-turn-stdin spike (Story 2's correction mechanism) is the highest-risk
unknown and belongs first in the plan.

**Second clarification session (2026-08-06) — what it changed and what it obliges.** Five decisions were
integrated as FR-193..FR-201 and SC-056..SC-061. Three of them invalidate parts of the existing `plan.md`
and `tasks.md` rather than merely extending them, and must be reflected there before further implementation:

- **`plan.md` Technical Context** states the typecheck gate is plain `strict` `tsc`. FR-198 changes the
  target's command for four of the six members and adds two committed config files to each.
- **`plan.md` Project Structure** lists `sisyphus-infra` primitives as provider-injected factories and shows
  one deployment config per deployable. FR-066 (amended), FR-199 and FR-200 replace both.
- **`plan.md` Constitution Check gate III** claims colocated tests for every planned module. FR-200 makes
  that deliberately untrue for the resource-creating primitives and true for the pure helpers they call;
  the gate note needs restating rather than silently failing.
- **`tasks.md`** has no task for the application shell, the sign-in screen, the root route, the route
  boundaries, or the notification settings screen — the five gaps FR-193..FR-197 and the FR-138 amendment
  now cover. T034 and T137 describe the superseded infrastructure shape.

**Post-implementation audit (2026-08-06) — the decomposition's blind spot.** Three sub-agent reviews of the
built tree were verified file-by-file before being recorded. Their common finding is not a list of small
misses but one structural flaw in how this task list was written: **every story's components were tasked and
the assembly of them was tasked nowhere.** The executor's entry point is a 22-line scaffold, the control
plane's declared Lambda handler names a file that does not exist, there is no delegated-run orchestrator, and
`notifyWorkflowEvent`, `runAutonomousWorkflow` and the `watchForInterruption`→`suspend()` chain each have no
production caller. Two tables — `skill_references` and `external_actions` — are written by nothing, so their
tested read paths can only ever return empty and the exactly-once guarantee the spec attributes to a unique
index is not what the implementation does.

None of this was visible to the gate: every unit suite passes, typecheck passes, lint passes, and
`.github/workflows/ci.yml` provides no Postgres and never sets `SISYPHUS_TEST_DATABASE_URL`, so roughly a
third of the assertions do not execute in CI at all. FR-203..FR-205 and SC-062..SC-065 exist to make each of
those conditions a stated failure rather than a silence, and Phase 18 (T172..T193) is the remediation. The
lesson for future decompositions: a story is not done when its parts are tested — it is done when the path a
user takes through it runs, and that path needs a task of its own.
