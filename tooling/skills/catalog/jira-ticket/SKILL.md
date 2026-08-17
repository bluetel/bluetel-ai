# Creating Jira Tickets

## When to Use This Skill

Activate when the user asks to create a Jira ticket/issue, raise a bug, log a task, write a story, or
move an existing issue into a sprint or between statuses.

## Reference files

Read the relevant one before writing a description — they carry the templates and the team's process:

| File                         | Contents                                                                 |
| ---------------------------- | ------------------------------------------------------------------------ |
| `reference/ticket-types.md`  | Templates, field guidance and worked examples for Story, Task and Bug    |
| `reference/bug-reporting.md` | When a Bug is a Bug (production only), reverts, and the extra Bug fields |
| `reference/workflow.md`      | Board states, creation fields, story point scale, summary style          |

Installed path: `.agents/skills/jira-ticket/reference/…`; in the source repo,
`tooling/skills/catalog/jira-ticket/reference/…`.

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
| `jira_create_into` | `backlog` (default) or `sprint`                      | `backlog`            |
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
  has no sprint-assignment command.
- **`acli`** (Atlassian CLI) — still used for transitions and assignment. Must be pre-authenticated
  via `acli jira auth`.

Script paths: installed as `.agents/skills/jira-ticket/scripts/…`; in the source repo,
`tooling/skills/catalog/jira-ticket/scripts/…`.

## Issue Types

| Type    | When to use                                                                  |
| ------- | ---------------------------------------------------------------------------- |
| `Story` | A new feature or behaviour described from a user's perspective               |
| `Task`  | A concrete piece of technical work (build, configure, investigate, refactor) |
| `Bug`   | Something broken **in production** — and only that                           |

`Bug` is narrower than it looks. Problems found during peer review, IAT or UAT are defects in
unfinished work: bounce that ticket back to In Progress rather than raising a Bug. A fix-forward for
a production issue is still a Bug, not a Task. **Read `reference/bug-reporting.md` before raising
one** — it also covers reverts and the extra fields a Bug carries.

If the project uses other types (`Spike`, …), confirm with the user before using them.

## Epic

**Always set an epic.** If `jira_epic_key` is configured the script does this automatically from
config; pass `--parent` only to override it. Tickets without an epic get lost on the board.

If `jira_epic_key` is empty, the script warns and creates the issue unparented — mention that no
default epic is configured (offer to set one via `config set 'jira_epic_key=…'`).

## Procedure

1. **Identify the issue type** from the table above. For a Bug, check
   `reference/bug-reporting.md` first — the problem may not warrant one.
2. **Write the summary** — a short, specific statement, max ~80 chars. Describe the symptom or need,
   not the fix: "Play bar does not reset when starting a new article", not "Reset play bar state on
   mount".
3. **Write the description** to a file, following the template in `reference/ticket-types.md` and the
   writing rules below.
4. **Create the issue** — pipe the markdown in on stdin, or point at the file:

```bash
.agents/skills/jira-ticket/scripts/jira-issue.mjs create \
  --type "<Story|Task|Bug>" \
  --summary "<summary>" \
  --description-file /tmp/ticket.md
```

Always write the description to a file and pass `--description-file` (or pipe it on stdin). Do not
try to inline a multi-line description as a shell argument — quoting mangles it, and that is half of
how malformed descriptions get published in the first place.

Add `--dry-run` to print the exact payload and check the formatting before anything is created.

5. **Where it lands** — by default the ticket goes to the bottom of the backlog, which is the
   documented process: it sits there until the team refines it. Say so, and suggest notifying the
   team. Pass `--sprint` to put it straight into the board's active sprint, or set
   `jira_create_into=sprint` to make that this repo's default. If no `jira_board_id` is configured,
   say so rather than guessing a board.

6. **Remaining fields** — Priority (usually leave Neutral), Labels, Story Point Estimate and Linked
   Issues are best set in the Jira UI, or via `--field` for custom fields. See
   `reference/workflow.md` for the story point scale and what each field is for.

### Fixing an existing ticket

To re-render a ticket whose description was published as literal markdown:

```bash
.agents/skills/jira-ticket/scripts/jira-issue.mjs update --key <project>-1234 --description-file /tmp/ticket.md
```

### CLI flags reference

| Flag                 | Required | Notes                                            |
| -------------------- | -------- | ------------------------------------------------ |
| `--type`             | create   | `Story`, `Task` or `Bug`                         |
| `--summary`          | create   | Short title, max ~80 chars                       |
| `--key`              | update   | Issue to re-describe                             |
| `--description-file` | Yes\*    | Markdown file (\*or pipe markdown on stdin)      |
| `--project`          | No       | Defaults to `jira_project_key` / `ticket_prefix` |
| `--parent`           | No       | Defaults to `jira_epic_key`                      |
| `--assignee`         | No       | `@me`, an email, or a display name               |
| `--label`            | No       | Comma-separated labels                           |
| `--field`            | No       | `<id>=<value>` for custom fields; repeatable     |
| `--sprint`           | No       | Move into the active sprint after creating       |
| `--no-sprint`        | No       | Leave it in the backlog                          |
| `--dry-run`          | No       | Print the payload without touching Jira          |

Do NOT pass priority — set it in the Jira UI after creation.

## Writing rules

These matter as much as the template. Tickets are read by whoever picks the work up next, months
later, with no access to this conversation.

### Write the problem, not the solution

The ticket **states what is wrong or what is needed**. Diagnosing and designing the fix is the
implementer's job.

- Do not write a root-cause analysis, name the file or function to change, or propose a patch — even
  when you are confident you know the cause. If you have a genuinely useful lead, put one sentence
  under `Notes` and mark it as a hunch ("possibly the draft-lock timeout, which looks like 5s").
- Leave `Resolution` and `Pull Requests` as the italic placeholders shown in the templates. Those are
  closing-time fields: the engineer fills them in before moving the ticket to Peer Review. Root cause
  and fix belong there, written by whoever did the work — not in the description at creation.

### Never reference the conversation that produced the ticket

The ticket must read as if a colleague wrote it from scratch. Never include:

- references to the prompt, the request, this chat, an agent, or "as discussed/requested above"
- session artefacts: pasted transcript, tool output, local scratchpad paths, or "the user said…"
- meta-commentary about writing the ticket ("This ticket captures…", "Below is a summary of…")

### Keep it short

Real tickets on these boards run ~110 words / ~1,000 characters of description. Aim for that; treat
~250 words as a hard ceiling and cut back to the template if you exceed it.

- One or two sentences per section. `Problem` and `Expected` are usually a single line each.
- No preamble, no restating the summary, no "Background" essay unless the reason genuinely is not
  obvious from the problem statement.
- Include logs, stack traces or long output only when they are the evidence — trim to the few
  relevant lines in a fenced code block, not the whole dump.
- Screenshots and recordings are worth more than prose for UI bugs. Attach them in Jira and refer to
  them; do not describe pixel-by-pixel what a screenshot already shows.
- Stories and Bugs are read by non-engineers — keep jargon in `Notes`, not the main description.

### One ticket, one concern

If you find yourself writing "and also", split the ticket. Aim for work completable in under two
days; see the story point scale in `reference/workflow.md`.

### Formatting

- Section labels are **bold paragraphs**, exactly as in the templates — not markdown headings. These
  boards use bold labels almost universally, and `##` headings render as oversized text that looks
  nothing like the rest of the board.
- Use `-` bullets for conditions and numbered lists for ordered steps.
- Use backticks for identifiers, paths, and values.
- Bare URLs become links automatically.
- Link related tickets with Jira's **Linked Issues** feature rather than pasting ticket ids into the
  description.
- A test matrix table is worth using when behaviour depends on a combination of inputs.
- The description is markdown and is converted for you. Do not hand-write ADF, and do not wrap the
  whole description in a fenced code block.

### The standard acceptance criteria

Every Story and Task ends its CoS with these three, below the task-specific ones:

```markdown
- Unit tests with at least 80% coverage
- SonarQube Quality Gates are passing
- Feature changes are sufficiently documented
```

If one genuinely does not apply, leave it out and say why in `Notes` rather than dropping it
silently.

## Post-Creation Actions

The actions below are **not** performed by default — only run them when the user explicitly asks.

### Assign to a user

```bash
acli jira workitem assign --key "<project>-XXX" --assignee "<email>" --yes
```

Use `@me` to self-assign, or a full email for someone else.

### Transition status

```bash
acli jira workitem transition --key "<project>-XXX" --status "<status>" --yes
```

The default board flow is `Backlog` → `Ready` → `In Progress` → `Peer Review` → `IAT` → `UAT` →
`Awaiting Release` → `Done`, plus `Blocked`. Status names vary per project, so confirm rather than
assuming. `reference/workflow.md` describes what each state means and what must be true to leave it.

### Move to a sprint, or back to the backlog

```bash
# the board's active sprint
.agents/skills/jira-ticket/scripts/jira-sprint.sh <project>-XXX

# a specific sprint id
.agents/skills/jira-ticket/scripts/jira-sprint.sh --sprint <id> <project>-XXX

# back to the backlog
.agents/skills/jira-ticket/scripts/jira-sprint.sh --backlog <project>-XXX
```

To list sprints on the board (e.g. to find a sprint id by name):

```bash
acli jira board list-sprints --id <board> --state active,future
```
