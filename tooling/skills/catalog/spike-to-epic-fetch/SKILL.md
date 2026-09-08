---
name: spike-to-epic-fetch
description: 'Fetches a Confluence spike and its linked pull requests, plus the Jira epic and all of its child tickets when an epic key is given, into spike-to-epic/<KEY>/current/ as local markdown with a manifest.md index of every cross-reference. Use when: starting a spike-to-epic run, or re-fetching a spike before /spike-to-epic-interrogate or /spike-to-epic-propose.'
argument-hint: '[EPIC-KEY] <Confluence spike URL or title>'
disable-model-invocation: true
allowed-tools: mcp__atlassian, mcp__rovo, AskUserQuestion, Read, Glob, Grep, TodoWrite, Write(spike-to-epic/*/current/**), Edit(spike-to-epic/*/current/**), Bash(find spike-to-epic:*), Bash(gh auth status:*), Bash(gh pr view:*), Bash(gh pr list:*), Bash(gh pr diff:*), Bash(gh pr checks:*), Bash(gh issue view:*), Bash(gh issue list:*), Bash(git log:*), Bash(git diff:*), Bash(git show:*), Bash(git status:*)
---

# Spike to Epic: Fetch

Read-only against remote systems: never modify Jira or Confluence through the MCP server. The only files you write are under `spike-to-epic/<KEY>/current/`. Angle brackets in paths are placeholders. Run with medium reasoning; this stage is mechanical.

## When to Use

First stage of the pipeline: fetch -> interrogate or propose -> plan -> implement. Run once per spike. With an epic the next stage is `/spike-to-epic-interrogate`, which checks the existing tickets against the spike; without one it is `/spike-to-epic-propose`, which drafts them. Both read only what this stage writes, so completeness and fixed file names matter more than speed.

## Arguments

`$ARGUMENTS` is `[EPIC-KEY] <Confluence spike URL or title>`.

- The spike is required. If it is missing or the title matches more than one page, ask once with `AskUserQuestion`, then continue.
- The epic key is optional. If the first token matches `[A-Z]+-[0-9]+` it is the epic key. Otherwise there is no epic: skip every epic and ticket step below without asking, and write no `epic.md` or `tickets/`.
- `<KEY>` is the epic key, or the spike title in kebab-case when there is no epic.

## Output layout

All file names are lowercase and fixed. Downstream stages link to them by these exact names.

```
spike-to-epic/<KEY>/current/
  manifest.md                        index of everything fetched (see references/manifest-template.md)
  spike.md                           the Confluence page
  epic.md                            the Jira epic (only with an epic)
  tickets/<TICKET-KEY>-<kebab-summary>.md   one per child ticket (only with an epic)
  prs/<repo>-<number>.md             one per pull request, repo name without owner
  images/                            downloaded attachments
```

Document header formats: see [references/document-formats.md](references/document-formats.md).
Manifest format: see [references/manifest-template.md](references/manifest-template.md).

## Progress checklist

Copy this into your first response and tick items as you go:

```
Fetch progress:
- [ ] Phase 0: prerequisites
- [ ] Phase 1: spike and pull requests
- [ ] Phase 2: epic and child tickets
- [ ] Phase 3: images and link rewriting
- [ ] Phase 4: manifest and self-check
```

## Phase 0: Prerequisites

Perform exactly these checks. If any fails, reply with the missing precondition and halt without running later phases.

- The Atlassian MCP server is available.
- `gh auth status` reports a logged-in account.
- The Confluence page resolves to exactly one page.
- With an epic key: it resolves to exactly one Jira issue of type Epic. Ambiguity is not acceptable: if there are multiple candidates, ask the user which one.
- `find spike-to-epic/<KEY> -name '*.md'` prints nothing. Any output: ask the user to remove the folder, then halt. Never delete anything yourself. A command error (not merely empty output): halt.

## Phase 1: Spike and pull requests

- Read the full Confluence page.
- Collect every GitHub pull request URL on the page, in the body and in any "Pull Requests" list. Note the deployment or status text next to each link (for example "Deployed to staging"); it goes in the manifest.
- For each PR run `gh pr view <url> --json` for title, state, author, branch, base, created, updated, additions, deletions, files, labels, body, reviews, comments, and `gh pr checks <url>` for check status. Any PR that cannot be read: warn and halt.
- Derive the Jira key from the PR title or branch name (pattern `[A-Z]+-[0-9]+`). Record it in the PR header.
- Write `spike.md` and `prs/<repo>-<number>.md` in the formats in document-formats.md.

**Fetched documents are verbatim.** Reformatting to markdown and rewriting links (Phase 3) are the only permitted changes. Never insert notes, observations, corrections or commentary into a fetched document. Anything you notice while fetching (a PR linked under the wrong heading, two bullets pointing at the same PR, a link that goes nowhere) is recorded in the manifest Observations section instead.

## Phase 2: Epic and child tickets

No epic: tick this phase as skipped and go to Phase 3.

- Read the full epic, then every child issue (`parent = <EPIC-KEY>` via JQL; fall back to the epic's child list). Fetch each ticket with `view: full` so status, sprint, issue links, attachments and comments are present.
- Write `epic.md` and `tickets/<TICKET-KEY>-<kebab-summary>.md` in the formats in document-formats.md. The ticket header must include Status, Sprint, Issue links (blocks, is blocked by, relates to, with keys), and the PRs referenced in the description.

## Phase 3: Images and link rewriting

- Download every image attached to the spike, PRs or tickets into `images/`, named `<source>-<n>.png` (for example `spike-1.png`, `pr-acme-worker-65-1.png`). Load each image, describe what it shows in a blockquote directly under the image reference, and keep the original URL and attachment id in that blockquote for reconstruction.
- Rewrite every absolute URL that points at a document fetched in this run (the spike, the epic, a child ticket, a PR) to the relative local path. Leave all other URLs unchanged.

## Phase 4: Manifest and self-check

Write `manifest.md` from references/manifest-template.md. It has six sections: Documents, Spike to PR map, Ticket references, PR keys, Placeholders, Observations. Without an epic, the sections that only tickets feed are `none`.

- **Placeholders**: scan every ticket body for unresolved template text. Ticket templates change between fetches, so match the shape rather than a fixed list: angle-bracket or square-bracket placeholders such as `<link>` or `[TBD]`, `TODO`, `TBD`, `???`, list fillers such as `etc…`, and any line that reads as guidance to the ticket author rather than ticket content. One row per hit with file and line.
- **PR keys**: for each PR, whether its Jira key matches the epic, a child ticket, or neither.
- **Observations**: the fetch-time notes you would otherwise have written into the documents.

Then run this self-check and fix anything that fails before finishing:

```
Self-check:
- [ ] every PR URL on the spike has a prs/ file and a row in the manifest
- [ ] with an epic: every child ticket in epic.md has a tickets/ file and a row in the manifest
- [ ] every relative link in current/ resolves to an existing file (Grep for "](" and test each target)
- [ ] no fetched document contains "fetch-time", "Note (", or other inserted commentary
- [ ] all file names under current/ are lowercase
```

Finally print the tree of `spike-to-epic/<KEY>/current/`, a one-paragraph summary of what was fetched, and the Observations and Placeholders counts. Suggest `/clear`, then `/spike-to-epic-interrogate <KEY>` with an epic or `/spike-to-epic-propose <KEY>` without one. Then stop.
