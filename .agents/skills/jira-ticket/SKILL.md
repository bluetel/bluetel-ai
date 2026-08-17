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

- **`scripts/jira-issue.mjs`** — creates and re-describes issues. **Use this, not
  `acli jira workitem create`.** It converts the markdown description to ADF (Atlassian Document
  Format) before sending, so headings, lists, links and code actually render. `acli` sends
  `--description` as plain text, which is why older tickets contain literal `**bold**` and `##`
  characters. Needs `JIRA_EMAIL` + the keychain token.
- **`scripts/jira-sprint.sh`** — moves issues to a sprint via the Jira Agile REST API, since `acli`
  has no sprint-assignment command. `jira-issue.mjs` calls it automatically after creating.
- **`acli`** (Atlassian CLI) — still used for transitions and assignment. Must be pre-authenticated
  via `acli jira auth`.

Script paths: installed as `.agents/skills/jira-ticket/scripts/…`; in the source repo,
`tooling/skills/catalog/jira-ticket/scripts/…`.

## Issue Types

| Type   | When to use                                       |
| ------ | ------------------------------------------------- |
| `Bug`  | Something is broken or behaving incorrectly       |
| `Task` | Internal work, refactors, infrastructure, tooling |

If the project uses other types (`Story`, `Spike`, …), confirm with the user before using them.

## Epic

If `jira_epic_key` is configured, every ticket created in this repo **must** be linked to it. The
script does this automatically from config; pass `--parent` only to override it. Tickets without an
epic get lost on the board.

If `jira_epic_key` is empty, the script warns and creates the issue unparented — mention that no
default epic is configured (offer to set one via `config set 'jira_epic_key=…'`).

## Procedure

1. **Identify issue type** from the table above.
2. **Write the summary** — concise, action-oriented, max ~80 chars. Describe the symptom, not the
   fix: "Play bar does not reset when starting a new article", not "Reset play bar state on mount".
3. **Write the description** to a file, following the template and the writing rules below.
4. **Create the issue** — pipe the markdown in on stdin, or point at the file:

```bash
.agents/skills/jira-ticket/scripts/jira-issue.mjs create \
  --type "<Bug|Task>" \
  --summary "<summary>" \
  --description-file /tmp/ticket.md
```

Always write the description to a file and pass `--description-file` (or pipe it on stdin). Do not
try to inline a multi-line description as a shell argument — quoting mangles it, and that is half of
how malformed descriptions get published in the first place.

Add `--dry-run` to print the exact payload and check the formatting before anything is created.

5. **Sprint** — this happens automatically: the script moves the new issue into the board's active
   sprint. Pass `--no-sprint` only if the user says otherwise ("leave it in the backlog"), or use
   `jira-sprint.sh --sprint <id>` for a specific sprint. If no `jira_board_id` is configured, say so
   rather than guessing a board.

### Fixing an existing ticket

To re-render a ticket whose description was published as literal markdown:

```bash
.agents/skills/jira-ticket/scripts/jira-issue.mjs update --key <project>-1234 --description-file /tmp/ticket.md
```

### CLI flags reference

| Flag                 | Required | Notes                                            |
| -------------------- | -------- | ------------------------------------------------ |
| `--type`             | create   | `Bug` or `Task`                                  |
| `--summary`          | create   | Short title, max ~80 chars                       |
| `--key`              | update   | Issue to re-describe                             |
| `--description-file` | Yes\*    | Markdown file (\*or pipe markdown on stdin)      |
| `--project`          | No       | Defaults to `jira_project_key` / `ticket_prefix` |
| `--parent`           | No       | Defaults to `jira_epic_key`                      |
| `--assignee`         | No       | `@me`, an email, or a display name               |
| `--label`            | No       | Comma-separated labels                           |
| `--no-sprint`        | No       | Skip the automatic move into the active sprint   |
| `--dry-run`          | No       | Print the payload without touching Jira          |

Do NOT pass priority — set it in the Jira UI after creation.

## Writing rules

These matter as much as the template. Tickets are read by whoever picks the work up next.

### Write the problem, not the solution

The ticket **states what is wrong or what is needed**. Diagnosing and designing the fix is the
implementer's job, not the writer's.

- Do not write a root-cause analysis, name the file or function to change, or propose a patch — even
  when you are confident you know the cause. If you have a genuinely useful lead, put one sentence
  under `Notes` and mark it as a hunch ("possibly the draft-lock timeout, which looks like 5s").
- Leave `Resolution`, `UAT Steps`, and `Pull Requests` as the italic placeholders shown in the
  templates. Those sections belong to the implementer and are filled in as the work lands.

### Never reference the conversation that produced the ticket

The ticket must read as if a colleague wrote it from scratch. It is read months later by people with
no access to this session. Never include:

- references to the prompt, the request, this chat, an agent, or "as discussed/requested above"
- session artefacts: pasted transcript, tool output, file paths from the local scratchpad, or
  "the user said…"
- meta-commentary about writing the ticket ("This ticket captures…", "Below is a summary of…")

### Keep it short

Real tickets on these boards run ~110 words / ~1,000 characters of description. Aim for that; treat
~250 words as a hard ceiling and cut back to the template if you exceed it.

- One or two sentences per section. `Problem` and `Expected` are usually a single line each.
- No preamble, no restating the summary, no "Background" essay unless the reason genuinely is not
  obvious from the problem statement.
- Include logs, stack traces, or long output only when they are the evidence — trim to the few
  relevant lines in a fenced code block, not the whole dump.
- Screenshots and recordings are worth more than prose for UI bugs. Attach them in Jira and refer to
  them; do not describe pixel-by-pixel what a screenshot already shows.

### Formatting

- Section labels are **bold paragraphs**, exactly as in the templates below — not markdown headings.
  These boards use bold labels almost universally, and `##` headings render as oversized text that
  looks nothing like the rest of the board.
- Use `-` bullets for conditions and numbered lists for ordered steps.
- Use backticks for identifiers, paths, and values.
- Put URLs on their own or inline as bare URLs; they become links automatically.
- The description is markdown and is converted for you. Do not hand-write ADF, and do not wrap the
  whole description in a fenced code block.

## Description Templates

Use these labels verbatim, including capitalisation (`CoS`, not `COS`) and the trailing colons.

### Bug

```markdown
**Problem:**

[One or two sentences on what is wrong, and where.]

**Expected:**

[What should happen instead.]

**Steps to replicate:**

1. [Step]
2. [Step]

**Resolution:**

_A summary of how the issue raised was addressed_

**UAT Steps:**

_Steps for the reviewer to verify the fix_

**Pull Requests**

- _repo: <link>_
```

Add a `**Notes**` section before `Resolution` only when there is context worth carrying: a Slack
thread, a related ticket, an environment restriction, or a flagged hunch.

### Task

```markdown
**CoS**

- [Condition of satisfaction — an observable outcome, not an implementation step]
- [Condition]

**Notes**

- _Good-to-know (e.g. links to Slack threads or docs)_

**UAT Steps:**

_Steps for the reviewer to verify the change_

**Pull Requests**

- _repo: <link>_
```

`CoS` (Conditions of Satisfaction) are what must be observably true when the work is done. Write
them as outcomes — "the footer shows an Advertisement section containing X and Y" — not as tasks for
the implementer to perform in order.

## Post-Creation Actions

Moving a new ticket to the active sprint happens by default (step 5). The actions below are **not**
performed by default — only run them when the user explicitly asks.

### Assign to a user

```bash
acli jira workitem assign --key "<project>-XXX" --assignee "<email>" --yes
```

Use `@me` to self-assign, or a full email for someone else.

### Transition status

```bash
acli jira workitem transition --key "<project>-XXX" --status "<status>" --yes
```

Status names are project-specific. Confirm the available set with the user or Jira rather than
assuming; a common workflow is `To Do`, `In Progress`, `review`, `TESTING`, `TESTED`, `IAT`, `Done`.

### Move to a different sprint, or back to the backlog

```bash
# a specific sprint id instead of the active one
.agents/skills/jira-ticket/scripts/jira-sprint.sh --sprint <id> <project>-XXX

# back to the backlog
.agents/skills/jira-ticket/scripts/jira-sprint.sh --backlog <project>-XXX
```

To list sprints on the board (e.g. to find a sprint id by name):

```bash
acli jira board list-sprints --id <board> --state active,future
```
