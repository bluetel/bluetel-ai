# Fetched document formats

Every fetched document starts with a `#` title and a metadata bullet list, then the body converted to markdown verbatim. Keep the field names below exactly; interrogate greps for them.

## Contents

- Spike (`spike.md`)
- Epic (`epic.md`)
- Child ticket (`tickets/<TICKET-KEY>-<kebab-summary>.md`)
- Pull request (`prs/<repo>-<number>.md`)
- Image blockquote

## Spike

```markdown
# SPIKE: <page title>

- **Source URL (for reconstruction):** <confluence url>
- **Space:** <key> (<name>) | **Page ID:** <id>
- **Author:** <name> | **Version:** <n>, created <YYYY-MM-DD>
- **Related epic:** [<EPIC-KEY> — <epic summary>](epic.md) or none

<page body as markdown; PR and ticket links rewritten to local paths>
```

## Epic

```markdown
# <EPIC-KEY> — <summary>

- **Type:** Epic | **Status:** <status> (<category>) | **Priority:** <priority>
- **Project:** <key> (<name>)
- **Assignee:** <name or _unassigned_> | **Reporter / Creator:** <name>
- **Created:** <YYYY-MM-DD> | **Updated:** <YYYY-MM-DD>
- **Labels:** <list or none> | **Components:** <list or none> | **Attachments:** <count or none> | **Comments:** <count or none>
- **Issue links:** <type: KEY, ...> or none
- **Source URL (for reconstruction):** <jira url>
- **Spike:** [spike.md](spike.md)

## Description

<description as markdown>

## Child issues

| Key | Summary | Type | Status | Sprint | Local file |
| --- | ------- | ---- | ------ | ------ | ---------- |
```

## Child ticket

```markdown
# <TICKET-KEY> — <summary>

- **Type:** <type> | **Status:** <status> (<category>) | **Priority:** <priority>
- **Parent epic:** [<EPIC-KEY> — <summary>](../epic.md)
- **Sprint:** <name or none>
- **Assignee:** <name or _unassigned_> | **Reporter / Creator:** <name>
- **Created:** <YYYY-MM-DD> | **Updated:** <YYYY-MM-DD>
- **Labels:** <list or none> | **Attachments:** <count or none> | **Comments:** <count or none>
- **Issue links:** <blocks: KEY; is blocked by: KEY; relates to: KEY> or none
- **PRs referenced:** [prs/<file>.md](../prs/<file>.md), ... or none
- **Source URL (for reconstruction):** <jira url>

## Description

<description as markdown, verbatim, including any template residue. Body structure is not guaranteed and varies between fetches; only the header fields above are fixed>

## Comments

<one `### <author> (<timestamp>)` block per comment, or omit the section when there are none>
```

## Pull request

```markdown
# <owner>/<repo>#<number> — <title>

- **Repository:** `<owner>/<repo>`
- **PR:** #<number>
- **State:** OPEN | MERGED | CLOSED | DRAFT
- **Jira key:** <KEY from title or branch, or none>
- **Author:** <login>
- **Branch:** `<head>` -> `<base>`
- **Created:** <ISO timestamp> | **Updated:** <ISO timestamp>
- **Diff:** <n> files, +<add> / -<del>
- **Checks:** <n passed, n failed, n pending> or none
- **Labels:** <list or none>
- **Source URL (for reconstruction):** <github url>

## Description

<PR body as markdown>

## Changed files

- `<path>` (+<add>/-<del>)

## Reviews

<one line per review: `- <login>: <state> (<timestamp>)`, or "none">

## Comments

<one `### <author> (<timestamp>)` block per comment, or "none">
```

## Image blockquote

Replace each image with the local reference, then a blockquote describing it:

```markdown
![<local-name>.png](images/<local-name>.png)

> **Diagram: <one-line title>.**
>
> - <what the image shows, as bullets; keep labels and arrows literal>
>
> _(Image downloaded to `images/<local-name>.png`; original: <original url or attachment id>)_
```
