# Plan document formats

Every file under `plan/` mirrors the format fetch writes under `current/`, so a reviewer can read a plan ticket next to its fetched original. The differences are deliberate and listed at the end.

## Contents

- Epic (`epic.md`)
- Ticket (`tickets/<key>-<kebab-summary>.md`)
- Epic description template
- Ticket description templates
- Extracting the description
- Differences from the fetched format

## Epic

```markdown
# <EPIC-KEY or new-epic> - <summary>

- **Action:** create | update | none
- **Type:** Epic | **Project:** <key>
- **Labels:** <list or none>
- **Spike:** <confluence url>
- **Source URL (for reconstruction):** <jira url> (existing epic only)

## Changes

- <one line per change from current/epic.md; section omitted for a new epic or Action none>

## Child issues

| Key     | Summary                         | Type | Action | Sprint    | Local file                                                                                         |
| ------- | ------------------------------- | ---- | ------ | --------- | -------------------------------------------------------------------------------------------------- |
| ABC-103 | Rate Limiting - Worker Limits   | Task | update | Sprint 20 | [tickets/abc-103-rate-limiting-worker-limits.md](tickets/abc-103-rate-limiting-worker-limits.md)   |
| new-01  | Rate Limiting - Quota Dashboard | Task | create | none      | [tickets/new-01-rate-limiting-quota-dashboard.md](tickets/new-01-rate-limiting-quota-dashboard.md) |

## Description

<the epic description exactly as it goes into Jira; template below>
```

## Ticket

```markdown
# <KEY or new-nn> - <summary>

- **Action:** create | update | none
- **Type:** Task | Story
- **Parent epic:** [<EPIC-KEY or new-epic> - <summary>](../epic.md)
- **Sprint:** <name or none>
- **Labels:** <list or none>
- **Issue links:** <blocks: KEY; is blocked by: KEY; relates to: KEY> or none
- **Estimate:** <points>
- **FRs:** FR-01, FR-03
- **PRs referenced:** <github url>, ... or none
- **Source URL (for reconstruction):** <jira url> (existing ticket only)

## Changes

- <one line per change from the fetched ticket; section present only for Action update>

## Description

<the description exactly as it goes into Jira>
```

Keys in Issue links are Jira keys for existing tickets and `new-nn` placeholders for new ones. A link appears on both tickets it joins.

## Epic description template

Bold labels. The section set and order come from the Epic row of the Project conventions table in plan.md, read from the project's own epics. This is the fallback shape when that row is `none`.

```markdown
**Goal**

<one or two sentences: what the epic delivers and why>

**Scope**

- <outcome>
- <outcome>

**Acceptance Criteria**

- <condition that is true when the epic is complete>

**Notes**

- Spike: <confluence url>
```

## Ticket description templates

Section labels and their order come from the Project conventions table in plan.md first, read from the project in Jira. The client guide's templates, or failing both the jira-ticket skill's `references/ticket-types.md`, fill in what the project does not show; writing-guide.md says which wins. Section labels are bold paragraphs, never headings. `Resolution` and `UAT Steps` keep their placeholder form. `Pull Requests` lists known PRs or keeps the template's placeholder line.

## Extracting the description

The description implement sends is every line after the `## Description` heading to the end of the file. No section follows it, in tickets or in the epic. Shell:

```sh
sed -n '/^## Description$/,$p' plan/tickets/<file>.md | tail -n +2
```

## Differences from the fetched format

- The title separator is a plain hyphen, not an em dash. The summary is sent to Jira and em dashes are banned from anything that is.
- `Action`, `Estimate`, `FRs` and `Changes` exist only in the plan.
- In the epic, `Child issues` comes before `Description`, so the extraction rule above holds for every file.
- Status, Assignee, Reporter, Created, Updated, Attachments and Comments are absent. The plan does not set them.
- Links in descriptions are absolute URLs. Fetch rewrites them to local paths; the plan restores the originals.
