# fr.md template

Write `spike-to-epic/<EPIC-KEY>/interrogate/fr.md` with exactly these sections in this order. Pipe tables only. Empty sections keep their heading and a single line "none".

Vocabularies are closed:

- FR Status: `done` | `partial` | `todo` | `deferred`
- Finding Category: `coverage-gap` | `duplicate-coverage` | `misplaced-criterion` | `contradiction` | `ordering` | `status-drift` | `placeholder` | `oversized`
- Severity: `CRITICAL` | `HIGH` | `MEDIUM` | `LOW`
- Ask: `W<wave>-Q<n>` for a planned question, or `no (<severity>)` when not asked
- Decision: the option label chosen, `leave as is`, or blank until asked

Example values use a made-up epic ABC-100 Rate Limiting with tickets ABC-101 to ABC-105.

```markdown
# Functional requirements — <EPIC-KEY>

- **Spike:** [../current/spike.md](../current/spike.md)
- **Epic:** [../current/epic.md](../current/epic.md)
- **Generated:** <YYYY-MM-DD>

## Summary

<one paragraph: what the spike is trying to achieve, what the PRs prove, what remains>

## Requirements

| ID    | Requirement                         | Source                  | Status   | Evidence                                                                     | Ticket(s) |
| ----- | ----------------------------------- | ----------------------- | -------- | ---------------------------------------------------------------------------- | --------- |
| FR-01 | <one buildable outcome, imperative> | spike.md#<heading>      | partial  | prs/<file>.md: <files or hunk>; subagent: partially implemented, missing <x> | ABC-101   |
| FR-02 | <...>                               | spike.md#Next steps (6) | deferred | spike marks low priority                                                     |           |

## Coverage

| Ticket  | Status | FRs          | Oversized? | Open findings |
| ------- | ------ | ------------ | ---------- | ------------- |
| ABC-101 | Ready  | FR-01, FR-03 | no         | M1            |

## Findings

| ID  | Category            | Severity | Ask         | Location                                    | Summary                                              | Suggested fix                | Decision |
| --- | ------------------- | -------- | ----------- | ------------------------------------------- | ---------------------------------------------------- | ---------------------------- | -------- |
| C1  | coverage-gap        | CRITICAL | W2-Q1       | spike.md#Next steps (6)                     | Quota dashboard has no ticket                        | New ticket "Quota dashboard" |          |
| M1  | misplaced-criterion | HIGH     | W3-Q1       | tickets/abc-101-<slug>.md#<heading or line> | API key header rule belongs to worker ticket ABC-103 | Move work item to ABC-103    |          |
| G1  | placeholder         | MEDIUM   | no (MEDIUM) | tickets/abc-101-<slug>.md:L52               | `acme-web: <link>`                                   | Fill or remove               |          |

## Self-check

<the Phase 4 checklist with every box ticked; list any item that needed a fix and what was changed>

## Question plan

Written in full before the first question is asked. A wave runs only with at least one CRITICAL or HIGH finding.

| Order | Wave | Finding | Severity | Header     | Question (final wording) | Options (label -> effect)                                                                                                           |
| ----- | ---- | ------- | -------- | ---------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1     | 2    | C1      | CRITICAL | New ticket | <plain-English question> | Create a ticket for the quota dashboard -> one new child ticket; Add it to ABC-104 -> extends that ticket; Leave as is -> no change |

Skipped waves: <wave 1: no CRITICAL or HIGH findings> or none

## Questions and answers

1. **W2-Q1 (C1):** <question text exactly as asked>
   **A:** <option label chosen> — <its stated effect>
```

Notes:

- Requirement IDs are `FR-` plus a two-digit counter in extraction order and never renumbered.
- Source is `file#heading`; add `(n)` for an item in a numbered list.
- Evidence for `todo` and `deferred` says why in a few words. Evidence for `done` and `partial` names a PR file.
- Location in Findings is a file plus heading or line, so plan can jump to it.
- Finding IDs, severities and waves appear only in the tables and the Q&A labels, never in the question text itself.
- The Questions and answers section records questions verbatim as asked, in order, including "leave as is" answers.
