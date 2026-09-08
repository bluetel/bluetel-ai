---
name: spike-to-epic-plan
description: "Turns a spike-to-epic requirements document (fr.md from interrogate or propose) into a reviewable Jira plan: an epic and one candidate ticket per piece of work, written to the team's Jira ticket writing guide in the same layout fetch uses, plus a plan of action that /spike-to-epic-implement follows verbatim to create and update them. Writes nothing to Jira. Use when: fr.md exists and the tickets need drafting for human review before anything is created."
argument-hint: '[KEY] (optional when only one folder exists under spike-to-epic/)'
disable-model-invocation: true
allowed-tools: mcp__atlassian__getAccessibleAtlassianResources, mcp__atlassian__searchJiraIssuesUsingJql, mcp__atlassian__getJiraIssue, mcp__atlassian__searchConfluence, mcp__atlassian__getConfluenceContent, mcp__atlassian__discover, mcp__atlassian__executeRead, AskUserQuestion, Read, Glob, Grep, TodoWrite, Write(spike-to-epic/*/plan/**), Edit(spike-to-epic/*/plan/**), Bash(find spike-to-epic:*), Bash(sed -n:*), Bash(git status:*)
---

# Spike to Epic: Plan

Read-only against remote systems: never create, update or link anything in Jira, Confluence or GitHub. Jira and Confluence are read through search and get operations only; the MCP write and destructive tools are not in this skill's tool list and are never called. Never edit anything under `current/`, `interrogate/` or `propose/`; the only files you write are under `spike-to-epic/<KEY>/plan/`. Angle brackets in paths are placeholders.

## When to Use

Third stage of the pipeline: fetch -> interrogate or propose -> plan -> implement. Plan turns `fr.md` into the tickets a developer would pick up: one epic and one ticket per piece of work, each written to the team's Jira ticket writing guide and laid out the way fetch lays out a fetched ticket, so a reviewer can read a plan ticket next to its Jira original. It also writes the plan of action `/spike-to-epic-implement` carries out. Implement does nothing but execute that plan, so every value it needs is decided here and nothing is left to judgement there.

With an epic in `current/`, the plan is a mirror of that epic and its tickets with the interrogate decisions applied and the wording corrected. Without one, the plan proposes the epic and every ticket from the propose requirements.

## Arguments

`$ARGUMENTS` is an optional `<KEY>`. When empty, list `spike-to-epic/*/current/spike.md`; exactly one match selects that key, otherwise ask with `AskUserQuestion`.

## Inputs and output

| Input               | Where                                                                                                | Used for                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Requirements        | exactly one of `interrogate/fr.md` or `propose/fr.md`                                                | the work to ticket, statuses, decisions     |
| Fetched documents   | `current/manifest.md`, `spike.md`, `prs/`, and `epic.md` plus `tickets/` when present                | mirror source, links, pull requests         |
| Writing guide       | jira-ticket skill references, `.agents/jira-ticket-context.md`, the client guide (writing-guide.md)  | templates, standard criteria, wording rules |
| Project conventions | Jira, read-only: the project's issue template when it exposes one, else its recent tickets and epics | section labels and order, summary pattern   |
| Jira config         | `.agents/skills.config`                                                                              | `jira_project_key`, `jira_create_into`      |

Output, all under `spike-to-epic/<KEY>/plan/`, in the formats in [references/ticket-formats.md](references/ticket-formats.md) and [references/plan-template.md](references/plan-template.md):

```
plan/
  plan.md                              plan of action: what implement creates, updates and links, in order
  epic.md                              the epic as it should read after implement
  tickets/<key>-<kebab-summary>.md     one per ticket; an existing ticket keeps its file name from current/, a new one is new-01, new-02...
```

Every ticket file is the ticket as it should read in Jira. The text after its `## Description` heading is the description implement sends, verbatim, so nothing in it may depend on this folder: absolute URLs only, no local paths, no pipeline vocabulary, no template residue beyond the placeholders the template itself keeps.

## Progress checklist

Copy this into your first response and tick items as you go:

```
Plan progress:
- [ ] Phase 0: prerequisites
- [ ] Phase 1: guide and inputs
- [ ] Phase 2: ticket set
- [ ] Phase 3: epic and ticket documents
- [ ] Phase 4: plan of action
- [ ] Phase 5: self-check and extract check
```

## Phase 0: Prerequisites

If any check fails, reply with the missing precondition and halt.

- `<KEY>` resolves to exactly one folder under `spike-to-epic/`.
- Exactly one of `interrogate/fr.md` and `propose/fr.md` exists. Neither: there are no requirements to plan from; name the stage to run. Both: the source is ambiguous; ask the user to remove the stale one, then halt.
- `fr.md` is finished: its Self-check section has every box ticked, and every question in its Questions and answers section has an answer. Otherwise the previous stage was interrupted; say so and halt.
- `current/manifest.md` and `current/spike.md` exist. With `interrogate/fr.md`, `current/epic.md` and `current/tickets/` exist too.
- `plan/` does not exist. If it does, ask the user to remove it first. Never delete anything yourself.
- The jira-ticket skill is present: `references/ticket-types.md` is readable under `.agents/skills/jira-ticket/` or, in the source repo, `tooling/skills/catalog/jira-ticket/`.
- The Atlassian MCP server is available. This stage reads Jira and Confluence and writes to neither.
- The Jira project key resolves: the epic's Project field when `current/epic.md` exists, else `jira_project_key` or `ticket_prefix` from `.agents/skills.config` when the value matches `[A-Z][A-Z0-9]+`. Otherwise ask once with `AskUserQuestion`, then continue.

## Phase 1: Guide and inputs

Read, in this order, and keep them to hand for Phase 3:

1. [references/writing-guide.md](references/writing-guide.md), then the jira-ticket skill's `references/ticket-types.md` and `references/workflow.md`, then `.agents/jira-ticket-context.md`. The project file wins where it disagrees with the shared templates.
2. The project's conventions from Jira, before any template is used for writing: follow "Project conventions from Jira" in writing-guide.md. Try for the project's own issue template through `discover` and `executeRead`; for each type that gives none, sample its recent tickets and epics through JQL search and get. Read-only, nothing is created or changed. Record the result in the Project conventions table of plan.md. This runs on every plan: with no sibling tickets it is the shape every new ticket takes, and with siblings it supplies any section they lack.
3. The client guide: search Confluence, in the spike's space only (Space field in the spike header), for a page titled "Jira Ticket Writing Guide". If one exists, read it in full; its templates, standard acceptance criteria and examples win over the shared skill. Record its URL in plan.md. No such page: use the shared templates.
4. `fr.md`, the manifest, the spike, every PR file, and with an epic, the epic and every ticket file.

## Phase 2: Ticket set

Decide the list of tickets before writing any description, and write the Tickets table of plan.md first, so the shape can be reviewed on its own.

**From propose (no epic):**

- One ticket per FR with status `todo` or `partial`. Merge two FRs into one ticket only when they change the same repository, would ship in one PR, and the result still fits two days of work. Never merge FRs from different spike headings.
- FRs with status `done` get no ticket; they go in Requirement coverage with the PR that did them. `deferred` FRs go there as deferred, with the spike's reason.
- The epic is new: key `new-epic`, summary from the spike's subject, description per ticket-formats.md.

**From interrogate (epic exists):**

- Start from the fetched tickets: one plan file per ticket under `current/tickets/`, same file name. `Action: update` when anything in it changes, `none` when nothing does.
- Apply every Decision in the Findings table and every answer in Questions and answers, literally as the chosen option's stated effect describes it: new tickets, bullets moved between tickets, bullets dropped, wording changed, issue links added, tickets split. "Leave as is" changes nothing.
- Resolve every `placeholder` finding: fill the value when the spike or a PR supplies it, otherwise remove the placeholder line. These were never asked, so each one is a line in the ticket's Changes section.
- Every other finding that was not asked is not applied. List it in plan.md under Not applied with its suggested fix; the reviewer decides.
- The epic keeps its key. `Action: update` only when its wording changes or its child list gains tickets.

**Both:**

- Type is `Task` for technical work and `Story` only when the FR describes behaviour from a user's perspective. Never `Bug`.
- A dependency between tickets is an `is blocked by` issue link, written on both tickets. Order the table so every ticket comes after the tickets it is blocked by.
- Estimate each ticket on the story point scale in workflow.md. A new ticket over 2 points is split, by outcome or by repository, never into phases of the same change. An existing ticket is split only by an interrogate decision.

## Phase 3: Epic and ticket documents

Write `epic.md` and every `tickets/` file in the formats in ticket-formats.md. Follow writing-guide.md for every word of a summary or description; it is the jira-ticket skill's writing process extracted for a stage that drafts without creating, plus this stage's correction pass. Re-read it before each ticket, not once.

For each ticket:

1. **Summary.** An existing ticket keeps its summary, corrected for spelling. A new ticket in an existing epic follows its siblings' pattern. A new ticket in a new epic is a short specific statement of the need, 80 characters at most.
2. **Description** in the type's shape: the Project conventions row first, then the client guide or shared template for what it does not show. CoS or acceptance criteria bullets come from the ticket's FRs, each an observable outcome. The standard acceptance criteria close the list.
3. **Links carried over.** Notes opens with the spike page, then every link under the spike headings the ticket's FRs cite that a developer needs. Absolute URLs only.
4. **Pull requests.** An OPEN PR whose work the ticket continues is the base: the description's first line names it and Pull Requests lists it. A MERGED PR that did part of the work is done context in Notes. Otherwise Pull Requests keeps the template's placeholder line.
5. **Existing tickets.** Keep the meaning and the author's structure, apply the decisions, then run the correction pass in writing-guide.md. Technical terms, identifiers, quoted values, code blocks and URLs stay character for character. Local paths fetch wrote in become the original URLs from the linked document's Source URL. Every change is one line in the ticket's Changes section.
6. **Header.** Action, Type, Parent epic, Sprint (an existing ticket keeps its sprint; a new one is `none`, the backlog, unless `jira_create_into=sprint`), Labels, Issue links, Estimate, FRs, and Source URL for an existing ticket.

## Phase 4: Plan of action

Complete plan.md from plan-template.md: Summary, Project conventions, Epic, Plan of action, Requirement coverage, Not applied, Review notes.

The plan of action is a table implement executes top to bottom, one Jira operation per row, every value written out: create the epic when it is new, create each new ticket in dependency order with type, project, parent, summary and description file, update each changed existing ticket and the epic, then add every issue link once both keys exist, then any sprint move. Placeholder keys (`new-epic`, `new-01`) are replaced by the keys Jira returns as implement goes; a later row that depends on one names it.

Review notes hold whatever a human should look at before running implement: a description kept over the word ceiling to preserve its meaning, a sentence whose intent was unclear and was left as written, a link that could not be resolved, a criterion left out and why.

## Phase 5: Self-check and extract check

Run this self-check, fix every failure, and repeat until clean. Record the result in plan.md.

```
Self-check:
- [ ] no em dash anywhere under plan/: Grep for "—" prints nothing
- [ ] no local path, `<link>`, `TBD`, `TODO`, `etc.` or other template residue in any description, beyond the placeholders the template keeps
- [ ] every ticket's CoS or acceptance criteria ends with the standard criteria from the highest source
- [ ] every description's section labels and order match the Project conventions row for its type, except where the client guide or a complete sibling differs and a Review note says so
- [ ] every ticket's Notes opens with the spike URL
- [ ] every `todo` and `partial` FR maps to exactly one ticket; every `done` and `deferred` FR is in Requirement coverage
- [ ] every issue link names a key or placeholder that exists in the plan, on both tickets
- [ ] every Decision and answer in fr.md is reflected in a ticket, or in Not applied
- [ ] every ticket with Action update has a Changes section with at least one line; no ticket with Action none has one
- [ ] every summary is 80 characters or fewer
- [ ] every relative link under plan/ resolves to an existing file
- [ ] no description mentions the pipeline: no "FR-", "fr.md", "finding", "spike-to-epic", "interrogate" or "propose"
```

**Extract check.** For each ticket and the epic, run the extract implement will send and confirm it has at least one non-blank line. Implement sends it as markdown through the Atlassian MCP server, which converts it to ADF on the way in; there is no offline conversion, so a description the server rejects fails at its step in implement and is fixed here in the plan.

```sh
sed -n '/^## Description$/,$p' spike-to-epic/<KEY>/plan/tickets/<file>.md | tail -n +2 | grep -c .
```

The epic's extract comes from `plan/epic.md` the same way. A count of 0 is a failure: the file has no Description section, or an empty one.

Finally print the tree of `plan/`, the Tickets table, and the counts of Review notes and Not applied rows. Ask the user to review `plan/plan.md` and the ticket files, then suggest `/spike-to-epic-implement <KEY>`. Then stop.
