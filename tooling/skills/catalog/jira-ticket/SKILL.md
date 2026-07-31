# Creating Jira Tickets

## When to Use This Skill

Activate when the user asks to create a Jira ticket/issue, raise a bug, log a task, or move an
existing issue into a sprint or between statuses.

## Project conventions (read first)

This skill is repo-agnostic. The Jira site, project key, epic, and board differ per project, so
they come from this project's config — **never assume another project's values apply here.**

Read `.agents/skills.config` (a `key=value` file at the target root). Relevant keys:

| Key                | Meaning                                              | Example              |
| ------------------ | ---------------------------------------------------- | -------------------- |
| `jira_site`        | Atlassian site host                                  | `acme.atlassian.net` |
| `jira_project_key` | Project key new issues are created in                | `ACME`               |
| `jira_board_id`    | Board id used to find the active sprint              | `42`                 |
| `jira_epic_key`    | Parent epic every new ticket is linked to            | `ACME-100`           |
| `ticket_prefix`    | Ticket namespace — `jira_project_key` defaults to it | `ACME`               |

Resolve them in this order: (1) `.agents/skills.config` if present; (2) otherwise the project's
`AGENTS.md`, then `CLAUDE.md`; (3) if a needed value is still missing, **ask the user** — do not
guess a project key, board, or epic.

Below, `<project>`, `<site>`, `<board>`, and `<epic>` mean the resolved values.

Read the values straight from `.agents/skills.config`. To change them, run `/skills-install` (it
walks the keys), or from a skills snapshot:

```bash
sh lib/skills.sh config show
sh lib/skills.sh config set 'jira_board_id=42' 'jira_epic_key=ACME-100'
```

### Credentials (never in the config file)

`.agents/skills.config` is committed, so it holds **no** credentials:

- **`JIRA_EMAIL`** — your account email, exported in your shell profile (per-user, not per-repo).
- **API token** — stored in the OS keychain. See the header of `scripts/jira-sprint.sh` for the
  one-time setup. Never paste a token into a chat or ask an agent to store one.

## Tooling

- **`acli`** (Atlassian CLI) — must be pre-authenticated via `acli jira auth`.
- **`scripts/jira-sprint.sh`** (beside this skill file) — moves issues to a sprint via the Jira
  Agile REST API, since `acli` has no sprint-assignment command. It reads `jira_site` /
  `jira_board_id` from the same config file. When this skill is installed the path is
  `.agents/skills/jira-ticket/scripts/jira-sprint.sh`; in the source repo it is
  `tooling/skills/catalog/jira-ticket/scripts/jira-sprint.sh`.

## Issue Types

| Type   | When to use                                       |
| ------ | ------------------------------------------------- |
| `Bug`  | Something is broken or behaving incorrectly       |
| `Task` | Internal work, refactors, infrastructure, tooling |

If the project uses other types (`Story`, `Spike`, …), confirm with the user before using them.

## Epic

If `jira_epic_key` is configured, every ticket created in this repo **must** be linked to it —
pass `--parent "<epic>"` on every `acli jira workitem create` call. Tickets without an epic get
lost on the board.

If `jira_epic_key` is empty, omit `--parent` and mention that no default epic is configured (offer
to set one via `config set 'jira_epic_key=…'`).

## Procedure

1. **Identify issue type** from the table above
2. **Write the summary** — concise, action-oriented, max ~80 chars
3. **Write the description** using the template for the issue type below
4. **Create the issue** using `acli`:

```bash
acli jira workitem create \
  --project "<project>" \
  --type "<Bug|Task>" \
  --summary "<summary>" \
  --description "<description>" \
  --parent "<epic>"
```

5. **Move the new issue to the current sprint** — by default, every new ticket goes into the board's active sprint:

```bash
.agents/skills/jira-ticket/scripts/jira-sprint.sh <project>-XXX
```

`JIRA_EMAIL` must be exported (or passed inline for a one-off run, e.g.
`JIRA_EMAIL="you@company.com" .agents/skills/jira-ticket/scripts/jira-sprint.sh <project>-XXX`).

Skip this step only if the user explicitly says otherwise (e.g. "leave it in the backlog", "don't add to the sprint", or names a specific sprint to use instead via `--sprint <id>`), or if no `jira_board_id` is configured — in that case say so rather than guessing a board.

### CLI flags reference

| Flag            | Required | Notes                                                 |
| --------------- | -------- | ----------------------------------------------------- |
| `--project`     | Yes      | The resolved `jira_project_key`                       |
| `--type`        | Yes      | `Bug` or `Task`                                       |
| `--summary`     | Yes      | Short title, max ~80 chars                            |
| `--description` | Yes      | Plain text or markdown body                           |
| `--parent`      | Yes\*    | The resolved `jira_epic_key` (\*if one is configured) |
| `--assignee`    | No       | Email or `@me` to self-assign                         |
| `--label`       | No       | Comma-separated labels                                |

### Important notes

- `--parent` MUST be included whenever an epic is configured — tickets without an epic get lost on the board
- Do NOT pass priority — use Jira UI to set priority after creation
- The description is passed as a single string argument (use shell quoting for multi-line)
- On success, acli prints the created issue key and URL

## Post-Creation Actions

Moving a new ticket to the current sprint is done **by default** (see step 5 above). The actions below are **not** performed by default — only run them when the user explicitly asks (e.g. "assign to X", "move to in progress").

### Assign to a user

```bash
acli jira workitem assign --key "<project>-XXX" --assignee "<email>" --yes
```

- Use `@me` to self-assign
- Use full email for other users (e.g. `user@company.com`)

### Transition status

```bash
acli jira workitem transition --key "<project>-XXX" --status "<status>" --yes
```

Status names are project-specific. Confirm the available set with the user or Jira rather than
assuming; a common workflow is `To Do`, `In Progress`, `review`, `TESTING`, `TESTED`, `IAT`, `Done`.

### Move to a different sprint, or back to the backlog

Use the sprint script (not supported by `acli` directly). `JIRA_EMAIL` is required here too:

```bash
# Move to a specific sprint ID instead of the active one
.agents/skills/jira-ticket/scripts/jira-sprint.sh --sprint <id> <project>-XXX

# Move back to the backlog (e.g. if the user says "don't add this to the sprint")
.agents/skills/jira-ticket/scripts/jira-sprint.sh --backlog <project>-XXX
```

To list sprints on the board (e.g. to find a sprint ID by name):

```bash
acli jira board list-sprints --id <board> --state active,future
```

---

## Description Templates

### Bug

```markdown
### Bug Description

[Clear description of what is wrong]

## Affected Pages / Areas

- [Screen or component name]

## Expected Behaviour

[What should happen]

## Actual Behaviour

[What actually happens]

## Root Cause (if known)

[Technical explanation]

## Steps to Reproduce

1. [Step]
2. [Step]
```

### Task

```markdown
## Overview

[What needs to be done and why]

## COS

- [Item]
- [Item]
```

## Other Notes

- For bugs, include screenshots or screen recordings if possible
- External links
