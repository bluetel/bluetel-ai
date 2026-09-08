---
name: spike-to-epic-interrogate
description: "Cross-checks a fetched Confluence spike, its pull requests and the Jira epic's child tickets for coverage gaps, duplicated or misplaced criteria, contradictions, ordering and status drift, then interrogates the user on each finding and records the decisions in spike-to-epic/<EPIC-KEY>/interrogate/fr.md. Use when: /spike-to-epic-fetch has run and the tickets need checking against the spike before /spike-to-epic-plan."
argument-hint: '[EPIC-KEY] (optional when only one folder exists under spike-to-epic/)'
disable-model-invocation: true
allowed-tools: mcp__atlassian, mcp__rovo, AskUserQuestion, Agent, Read, Glob, Grep, TodoWrite, Write(spike-to-epic/*/interrogate/**), Edit(spike-to-epic/*/interrogate/**), Bash(find spike-to-epic:*), Bash(gh pr view:*), Bash(gh pr list:*), Bash(gh pr diff:*), Bash(gh pr checks:*), Bash(gh issue view:*), Bash(gh issue list:*), Bash(git log:*), Bash(git diff:*), Bash(git show:*), Bash(git status:*)
---

# Spike to Epic: Interrogate

Read-only against remote systems: never modify Jira or Confluence through the MCP server. Never edit anything under `current/`; the only files you write are under `spike-to-epic/<EPIC-KEY>/interrogate/`. Angle brackets in paths are placeholders.

## When to Use

Second stage of the pipeline: fetch -> interrogate or propose -> plan -> implement. Interrogate is for a spike that already has an epic; `/spike-to-epic-propose` is its sister for one that does not. It answers one question: do the epic's tickets, taken together, implement what the spike proposes, no more and no less, given what the PRs have already done? Everything it learns lands in `interrogate/fr.md` for `/spike-to-epic-plan`, which turns the tickets and decisions into a reviewable Jira plan.

## Arguments

`$ARGUMENTS` is an optional `<EPIC-KEY>`. When empty, list `spike-to-epic/*/current/epic.md`; exactly one match selects that key, otherwise ask with `AskUserQuestion`.

## Inputs and output

Inputs, all under `spike-to-epic/<EPIC-KEY>/current/`: `manifest.md`, `spike.md`, `epic.md`, `tickets/`, `prs/`. Read the manifest first; it already maps spike headings to PRs, tickets to PRs, PR Jira keys, and placeholders. Only the metadata header of each document is fixed by fetch; ticket bodies are verbatim Jira text with no guaranteed structure, so treat a body purely as a source of work items.

Output: `spike-to-epic/<EPIC-KEY>/interrogate/fr.md`, in the exact structure of [references/fr-template.md](references/fr-template.md). PR verification prompts come from [references/pr-verification-subagent.md](references/pr-verification-subagent.md). Question wording rules and worked examples are in [references/question-design.md](references/question-design.md).

## Progress checklist

Copy this into your first response and tick items as you go:

```
Interrogate progress:
- [ ] Phase 0: prerequisites
- [ ] Phase 1: requirement extraction
- [ ] Phase 2: PR verification
- [ ] Phase 3: detection passes
- [ ] Phase 4: self-check
- [ ] Phase 5: question plan
- [ ] Phase 6: ask and record
```

## Phase 0: Prerequisites

If any check fails, reply with the missing precondition and halt.

- `<EPIC-KEY>` resolves to exactly one folder.
- `current/manifest.md`, `current/spike.md` and `current/epic.md` all exist. A missing manifest means the fetch predates this version: ask the user to remove the folder and re-run `/spike-to-epic-fetch`.
- `interrogate/fr.md` does not exist. If it does, ask the user to remove it first. Never delete anything yourself.

## Phase 1: Requirement extraction

Read `spike.md`, the PR descriptions, and the manifest. Do not read ticket bodies yet; requirements come from the spike and the PRs, not from the tickets that are being checked.

Write the Summary and Requirements sections of `fr.md`:

- One FR per discrete, buildable outcome. Be exhaustive and pedantic: an "in order of precedence" list of ten next steps is ten FRs, and a PR description's "needs significant improvement" list is one FR per bullet.
- Sources, in priority order: the spike's solution sections, its "Next steps" or equivalent, its "Further optimisations" and "Considerations", then PR descriptions. Every FR cites `file#heading`.
- Status uses exactly one of `done`, `partial`, `todo`, `deferred`, assigned by the rubric below. Evidence names the PR file and, for done or partial, the changed files or diff hunks that show it.

**Status rubric:**

| Status     | Assign when                                                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `done`     | A MERGED PR implements it, or the spike states it is complete in production                                                               |
| `partial`  | An OPEN PR implements some or all of it, including PRs the spike marks deployed to staging or sandbox. A prototype is partial, never done |
| `todo`     | No PR touches it                                                                                                                          |
| `deferred` | No PR touches it and the spike itself marks it low priority, "possibly", future, or out of this round                                     |

Leave the Ticket(s) column empty for now.

## Phase 2: PR verification

Status for `partial` FRs must rest on the diff, not on the PR description. Spawn one subagent per PR that has at least one FR pointing at it, passing every FR for that PR in one prompt built from references/pr-verification-subagent.md. Subagents read the diff with `gh pr diff` and return one verdict per FR: `implemented`, `partially implemented`, `absent`, with file-level evidence.

Apply the verdicts: `absent` on an OPEN PR moves the FR to `todo` with a note; `partially implemented` keeps `partial` and records what is missing in Evidence. Never verify diffs in the main context; the infrastructure PRs run to thousands of lines.

## Phase 3: Detection passes

Now read every ticket under `current/tickets/`. Ticket descriptions follow no fixed template and change between fetches, so never depend on their headings or bullet structure: extract the work items each description states, in whatever form (acceptance criteria, conditions of satisfaction, notes, prose), and map each to an FR to fill the Ticket(s) column. Then run these passes and write one row per hit in the Findings table. Stable IDs: category initial plus a counter (`C1`, `D1`, `M1`...).

| Pass | Category              | What to flag                                                                                                                                                                                 |
| ---- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | `coverage-gap`        | An FR with status `todo` or `partial` and no ticket. Skip `deferred` FRs and `done` FRs                                                                                                      |
| B    | `duplicate-coverage`  | The same FR mapped to two or more tickets                                                                                                                                                    |
| C    | `misplaced-criterion` | A work item in one ticket that maps to an FR owned by a different ticket's subject (for example a worker rule inside the infrastructure ticket)                                              |
| D    | `contradiction`       | Two tickets that require opposite things, or a ticket that contradicts the spike (do X versus do not do X)                                                                                   |
| E    | `ordering`            | A ticket that depends on another ticket's output (secrets, infrastructure, credentials) with no `is blocked by` issue link, or a ticket order that contradicts the spike's stated precedence |
| F    | `status-drift`        | A ticket whose work items re-implement an FR marked `done`, a ticket that builds on an OPEN PR without referencing it, or a PR whose Jira key matches no child ticket                        |
| G    | `placeholder`         | Every row in the manifest Placeholders section, carried over verbatim                                                                                                                        |
| H    | `oversized`           | A ticket whose work items map to FRs from two or more unrelated spike headings, or that mixes productionising with new scope                                                                 |

**Severity:**

| Severity | Assign to                                                                                                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRITICAL | `coverage-gap` on an FR the spike lists among its first next steps, any `contradiction`, `ordering` with no link where the dependency blocks a sprint |
| HIGH     | `duplicate-coverage`, `misplaced-criterion`, `status-drift`, `oversized`                                                                              |
| MEDIUM   | `placeholder`, `ordering` where the link is merely missing, `coverage-gap` on lower-precedence FRs                                                    |
| LOW      | wording, naming drift between spike and ticket for the same concept                                                                                   |

Also fill the Coverage table: one row per ticket with its FR IDs, whether it is oversized, and its open findings.

## Phase 4: Self-check

Run this list against `fr.md` and fix every failure before asking a single question. Repeat until clean.

```
Self-check:
- [ ] every FR has a Source of the form file#heading
- [ ] every FR marked done or partial has Evidence naming a PR file
- [ ] every partial FR has a subagent verdict recorded
- [ ] no FR is both done and unassigned in a finding (done FRs are never coverage gaps)
- [ ] every work item in every ticket maps to an FR or has a misplaced-criterion or contradiction finding
- [ ] every finding cites a Location (file, and heading or line)
- [ ] every ticket appears in the Coverage table
```

## Phase 5: Question plan

Questions are the only part of this stage the user sees, so every one is planned and written down in `fr.md` before any is asked. Read [references/question-design.md](references/question-design.md) first: questions are plain English about tickets, spike sections and PRs, and never mention FR IDs, finding IDs, categories or severities.

**Ask priority** is fixed from the Findings table, never judged at question time:

| Severity    | Ask priority                                    |
| ----------- | ----------------------------------------------- |
| CRITICAL    | 1: always asked, first in its wave              |
| HIGH        | 2: asked after every CRITICAL in its wave       |
| MEDIUM, LOW | never asked; recorded for `/spike-to-epic-plan` |

Waves, in order:

| Wave | Draws from                                                         | What it is about, in the user's terms                                                |
| ---- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| 1    | `oversized`                                                        | Tickets trying to do more than one job                                               |
| 2    | `coverage-gap`, `duplicate-coverage`                               | Work the spike calls for that has no ticket, or sits in two tickets                  |
| 3    | `contradiction`, `misplaced-criterion`, `ordering`, `status-drift` | Tickets that conflict, belong elsewhere, depend on each other, or redo finished work |

**Gate:** a wave runs only if it has at least one CRITICAL or HIGH finding. Otherwise skip the whole wave and say so in one line in the final summary. `placeholder` findings are never asked.

Within a wave, order by ask priority, then by the spike's own precedence (a finding tied to the spike's first next step comes before one tied to its sixth), then by finding ID.

Write the Question plan table in `fr.md` with every question in its final wording, then fill the Ask column of the Findings table (`W2-Q1`, or `no (MEDIUM)`). Only then move on.

## Phase 6: Ask and record

Ask with `AskUserQuestion` in the planned order, at most four questions per call, never mixing waves in one call. After each call, write the answers into the Questions and answers section and the Decision column before the next call, so an interrupted run loses nothing.

Where a decision assigns work to a ticket (existing, or "new ticket: <working title>"), update that FR's Ticket(s) column so plan can act on the table alone.

Finish with a short summary: FR counts by status, findings by severity, how many questions were asked, and which waves were skipped and why. Suggest `/compact`, then `/spike-to-epic-plan <EPIC-KEY>`. Then stop.
