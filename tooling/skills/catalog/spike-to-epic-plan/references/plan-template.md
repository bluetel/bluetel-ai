# plan.md template

Write `spike-to-epic/<KEY>/plan/plan.md` with exactly these sections in this order. Pipe tables only. Empty sections keep their heading and a single line "none".

Vocabularies are closed:

- Action: `create` | `update` | `none`
- Coverage: `ticketed` | `done` | `deferred`
- Conventions source: `template` | `sample` | `none`
- Step kind: `create epic` | `create ticket` | `update epic` | `update ticket` | `link` | `sprint`

Example values use a made-up project `ABC`, an epic ABC-100 Rate Limiting, and repositories prefixed `acme-`.

```markdown
# Plan - <KEY>

- **Spike:** [../current/spike.md](../current/spike.md) - <confluence url>
- **Requirements:** [../interrogate/fr.md](../interrogate/fr.md) or [../propose/fr.md](../propose/fr.md)
- **Epic:** [epic.md](epic.md) - <jira url, or "new">
- **Project:** <key> | **Site:** <jira site>
- **Writing guide:** <client guide url, or "shared templates">
- **Generated:** <YYYY-MM-DD>

## Summary

<one paragraph: what the epic delivers, how many tickets are created, updated and unchanged, and what a reviewer should look at first>

## Project conventions

Read from Jira in Phase 1, per writing-guide.md. Source is `template` when the project exposes an issue template, `sample` when recent tickets were read, `none` when neither gave a usable shape.

| Type  | Source | Sections (in order)                              | Summary pattern   | Keys read              |
| ----- | ------ | ------------------------------------------------ | ----------------- | ---------------------- |
| Task  | sample | CoS, Notes, Resolution, UAT Steps, Pull Requests | "<Epic> - <Need>" | ABC-97, ABC-95, ABC-92 |
| Story | none   |                                                  |                   |                        |
| Epic  | sample | Goal, Scope, Acceptance Criteria, Notes          | "<Capability>"    | ABC-100, ABC-80        |

## Epic

| Key     | Summary       | Action | Changes                                                 |
| ------- | ------------- | ------ | ------------------------------------------------------- |
| ABC-100 | Rate Limiting | update | child list gains new-01; Scope bullets given full stops |

## Tickets

In execution order: a ticket appears after every ticket it is blocked by.

| Order | File                                                                                                       | Key     | Action | Type | Summary                            | FRs   | Estimate | Issue links           | PRs                                         |
| ----- | ---------------------------------------------------------------------------------------------------------- | ------- | ------ | ---- | ---------------------------------- | ----- | -------- | --------------------- | ------------------------------------------- |
| 1     | [tickets/abc-102-rate-limiting-secrets-management.md](tickets/abc-102-rate-limiting-secrets-management.md) | ABC-102 | update | Task | Rate Limiting - Secrets Management | FR-02 | 2        | blocks ABC-104        | none                                        |
| 2     | [tickets/new-01-rate-limiting-quota-dashboard.md](tickets/new-01-rate-limiting-quota-dashboard.md)         | new-01  | create | Task | Rate Limiting - Quota Dashboard    | FR-07 | 2        | is blocked by ABC-104 | https://github.com/acme/acme-admin/pull/175 |

## Plan of action

One Jira operation per row, executed top to bottom. Implement replaces placeholder keys with the keys Jira returns and carries them into later rows.

| Step | Kind          | Target   | Values                                                                                                               |
| ---- | ------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| 1    | create epic   | new-epic | type Epic; project ABC; summary "<summary>"; description from epic.md                                                |
| 2    | create ticket | new-01   | type Task; project ABC; parent new-epic; summary "<summary>"; description from tickets/new-01-<slug>.md; sprint none |
| 3    | update ticket | ABC-103  | description from tickets/abc-103-<slug>.md                                                                           |
| 4    | update epic   | ABC-100  | description from epic.md                                                                                             |
| 5    | link          | new-01   | is blocked by ABC-104                                                                                                |
| 6    | sprint        | new-01   | active sprint (jira_create_into=sprint)                                                                              |

Implement carries out every row through the Atlassian MCP server. A description is the extract in ticket-formats.md, sent as markdown:

    sed -n '/^## Description$/,$p' plan/tickets/<file>.md | tail -n +2

The epic's description comes from epic.md the same way. A link row names its relation as written: blocks, is blocked by, or relates to.

## Requirement coverage

| FR    | Status   | Coverage | Ticket | Note                            |
| ----- | -------- | -------- | ------ | ------------------------------- |
| FR-01 | todo     | ticketed | new-01 |                                 |
| FR-02 | done     | done     |        | acme-base-images PR #17, merged |
| FR-03 | deferred | deferred |        | spike marks it low priority     |

## Not applied

Findings in fr.md that were not asked and are not applied here. The reviewer decides.

| Finding | Severity | Location                                             | Suggested fix               |
| ------- | -------- | ---------------------------------------------------- | --------------------------- |
| E2      | MEDIUM   | tickets/abc-104-rate-limiting-api-gateway-rollout.md | add "is blocked by ABC-102" |

## Review notes

- R1: <file> - <what a human should look at and why>

## Self-check

<the Phase 5 checklist with every box ticked, the extract check result per ticket, and any item that needed a fix with what was changed>
```

Notes:

- The Tickets table and the Plan of action list the same tickets; the plan of action adds the epic, links and sprint moves as their own rows.
- Sprint rows exist only when a sprint changes: a decision moved an existing ticket, or `jira_create_into=sprint` sends new tickets to the active sprint.
- Not applied is only meaningful with `interrogate/fr.md`; with `propose/fr.md` it reads "none".
