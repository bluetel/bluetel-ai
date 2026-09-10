# fr.md template

Write `spike-to-epic/<KEY>/propose/fr.md` with exactly these sections in this order. Pipe tables only. Empty sections keep their heading and a single line "none"; Research reads "not run" when Phase 3 was skipped.

Vocabularies are closed:

- FR Status: `done` | `partial` | `todo` | `deferred`
- Ambiguity Type: `scope` | `choice` | `status` | `conflict`
- Research Finding: `present` | `partial` | `absent`
- Resolved by: `research` | `confluence: <page url>` | `Q<n>` | blank until settled
- Decision: the option label chosen, or the settling fact in a few words, or blank until settled

Example values use a made-up rate limiting spike for a client whose repositories are prefixed `acme-`.

```markdown
# Functional requirements — <KEY>

- **Spike:** [../current/spike.md](../current/spike.md)
- **Generated:** <YYYY-MM-DD>
- **Research:** run | not run

## Summary

<one paragraph: what the spike is trying to achieve, what the PRs and research prove already exists, what remains>

## Requirements

| ID    | Requirement                         | Source                  | Status   | Evidence                                                                     | Ticket(s) |
| ----- | ----------------------------------- | ----------------------- | -------- | ---------------------------------------------------------------------------- | --------- |
| FR-01 | <one buildable outcome, imperative> | spike.md#<heading>      | partial  | prs/<file>.md: <files or hunk>; subagent: partially implemented, missing <x> |           |
| FR-02 | <...>                               | spike.md#Next steps (3) | done     | research: acme-worker src/limiter/client.ts                                  |           |
| FR-03 | <...>                               | spike.md#Next steps (6) | deferred | spike marks low priority                                                     |           |

## Research

### Repositories

| Repository       | Found on              | Kept? | Reason                              |
| ---------------- | --------------------- | ----- | ----------------------------------- |
| acme/acme-worker | spike.md (PR #65)     | yes   | linked on the spike                 |
| acme/acme-infra  | <confluence page url> | yes   | owner and `acme-` prefix match      |
| redis/node-redis | spike.md              | no    | third-party library the spike cites |

### Findings

| FR    | Repository       | Term                 | Finding | Files                                       | Raised |
| ----- | ---------------- | -------------------- | ------- | ------------------------------------------- | ------ |
| FR-02 | acme/acme-worker | RATE_LIMIT_REDIS_URL | present | src/limiter/client.ts, .env.example         |        |
| FR-04 | acme/acme-web    | limit header         | partial | src/middleware/limits.ts (flag exists, off) | A3     |

## Ambiguities

| ID  | Type   | Location                | Summary                                         | Resolved by            | Decision                                      |
| --- | ------ | ----------------------- | ----------------------------------------------- | ---------------------- | --------------------------------------------- |
| A1  | scope  | spike.md#Next steps (2) | "remaining services" is not enumerated          | Q1                     | API and worker only                           |
| A2  | status | spike.md#Worker         | says request counting "was partly added"; no PR | research               | present in acme-worker src/limiter/count.ts   |
| A3  | choice | spike.md#Algorithm      | sliding window or token bucket left open        | confluence: <page url> | token bucket, per the platform standards page |

## Question plan

Written in full before the first question is asked.

| Order | Ambiguity | Header | Question (final wording) | Options (label -> effect)                                                                                                                              |
| ----- | --------- | ------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | A1        | Spike  | <plain-English question> | API and worker only -> one piece of work each for the API and the worker; All four services -> one piece of work per service; Leave as is -> no change |

## Questions and answers

1. **Q1 (A1):** <question text exactly as asked>
   **A:** <option label chosen> — <its stated effect>

## Self-check

<the Phase 5 checklist with every box ticked; list any item that needed a fix and what was changed>
```

Notes:

- Requirement IDs are `FR-` plus a two-digit counter in extraction order and never renumbered. A requirement dropped by a decision is deleted and its number is not reused; the Questions and answers section records why.
- Source is `file#heading`; add `(n)` for an item in a numbered list.
- Evidence for `todo` and `deferred` says why in a few words. Evidence for `done` and `partial` names a PR file, a repository file (prefixed `research: <repo>`), or the spike statement.
- Ticket(s) stays blank. `/spike-to-epic-plan` fills it.
- Ambiguity IDs and types appear only in the tables and the Q&A labels, never in the question text itself.
- The Questions and answers section records questions verbatim as asked, in order, including "Leave as is" answers.
