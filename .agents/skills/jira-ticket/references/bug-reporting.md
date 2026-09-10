# When a Bug Is a Bug

`Bug` is narrower than it looks, and getting it wrong quietly erases production issues from the
record. Read this before raising one.

## A Bug is for problems found in production, and only for that

- **Problems found during peer review, IAT or UAT** are defects in unfinished work. Bounce the
  ticket back to In Progress. Do **not** raise a Bug.
- **Problems found after release** get a Bug, regardless of how they end up being resolved.

### Fix-forward still gets a Bug

When the team agrees with the client to fix a low-impact production bug rather than revert, the fix
ticket must be raised as a **Bug**, not a Task. This is the easiest one to get wrong: the work looks
like ordinary work — small, scoped, shipped the same day. Raised as a Task, that production issue
disappears from the records entirely.

### When the change is reverted

Raise a Bug as the record, link it to the original ticket via **Linked Work Items** using the
`caused by` relation, and close it once the revert is done. The rework itself happens on the
original ticket, which goes back to In Progress as normal. **Do not reopen a closed Bug.**

### Pre-emptive reverts count

If a change is pulled out of concern rather than a confirmed problem, still raise a Bug and set
**Detection Source** to `Suspected risk, unconfirmed`.

## Additional fields on a Bug

Six fields. One is set when the ticket is raised; the rest when it is closed. If you do not know a
value, **leave it blank** — a confident wrong answer is worse than a missing one.

### Set when opening

**Detection Source** — who or what first told us something was wrong. Record what actually prompted
action: if an alarm fired but nobody looked until the client called, it is `Client`.

| Option                        |
| ----------------------------- |
| `Client`                      |
| `Internal Engineers`          |
| `Monitoring/Alerting`         |
| `Synthetic Checks`            |
| `Suspected risk, unconfirmed` |

### Set when closing

These are the engineer's job at close time, not the writer's. Do not attempt to fill them in when
raising the ticket.

**Released on** — date of the release that introduced the problem, from the relevant Fix Version.
Leave blank if it cannot be pinned to one release.

**Escape Stage** — which stage should realistically have caught it. Pick the earliest with a
realistic chance. `None of the above` is expected and legitimate: it says the problem needs
production monitoring rather than more pre-release checking.

| Option                        |
| ----------------------------- |
| `Unit tests`                  |
| `Static analysis`             |
| `Peer review`                 |
| `Smoke tests`                 |
| `Internal acceptance testing` |
| `User acceptance testing`     |
| `None of the above`           |

**Failure Class** — what was at fault. Describe the mechanism, not the symptom.

| Option                 |
| ---------------------- |
| `Logic`                |
| `Integration`          |
| `Unexpected data`      |
| `Configuration`        |
| `External dependency`  |
| `Concurrency & timing` |
| `Resource limits`      |

**Authorship Mode** — how the code that _caused_ the bug was written, not how the fix was written.
Use `Mixed or unknown` rather than guessing.

| Option             |
| ------------------ |
| `Human`            |
| `AI assisted`      |
| `Agent generated`  |
| `Mixed or unknown` |
| `N/A`              |

**Trigger condition** — why it did not show up earlier (`immediate`, `specific data`,
`volume or load`, `elapsed time`, `rare path`, `external change`). The written process describes
this field, but there is **no matching field on the NA Bug screen** — only the five above exist.
Treat it as not yet implemented: do not invent a custom field id for it, and if it matters, note the
reason in a comment instead.

## Setting these from the CLI

These are project-specific custom fields, so `jira-issue.mjs` has no dedicated flags for them — use
`--field`, which takes any field id:

```bash
.agents/skills/jira-ticket/scripts/jira-issue.mjs create \
  --type Bug --summary "…" --description-file /tmp/ticket.md \
  --field customfield_12042="Client"
```

Field ids differ per project. On the NA project they are currently:

| Field                | Id                  |
| -------------------- | ------------------- |
| Detection Source     | `customfield_12042` |
| Escape Stage         | `customfield_12041` |
| Failure Class        | `customfield_12040` |
| Authorship Mode      | `customfield_12039` |
| Released on          | `customfield_12038` |
| Story point estimate | `customfield_11718` |

Verify before relying on these — they are not portable to other projects. To list the real ids and
their allowed values for a project:

```bash
acli jira workitem view <KEY> --json    # inspect an existing issue's fields
```

Alternatively set them in the Jira UI after creation, which is often simpler for the closing-time
fields since the engineer is already looking at the ticket.

## What this data is for

Everything closed in the last 30 days gets a ten-minute review, looking for patterns rather than
individual tickets. A failure class appearing twice becomes a candidate for an automated check so it
cannot happen a third time.

The option sets will probably change after the first few reviews. If something does not fit what you
are seeing, say so rather than picking the nearest option.
