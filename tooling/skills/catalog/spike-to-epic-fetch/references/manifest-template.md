# Manifest template

Write `spike-to-epic/<KEY>/current/manifest.md` with exactly these sections in this order. Use pipe tables. Empty sections keep their heading and a single line "none". Without an epic: the Epic line is `none`, the Documents table has no epic or ticket rows, and Ticket references and Placeholders are `none`.

```markdown
# Manifest — <KEY>

- **Fetched:** <YYYY-MM-DD>
- **Spike:** [spike.md](spike.md) — <confluence url>
- **Epic:** [epic.md](epic.md) — <jira url>, or none

## Documents

| Local file        | Type   | Source URL | State / Status                         |
| ----------------- | ------ | ---------- | -------------------------------------- |
| spike.md          | spike  | <url>      | version <n>                            |
| epic.md           | epic   | <url>      | <status>                               |
| tickets/<file>.md | ticket | <url>      | <status>                               |
| prs/<file>.md     | pr     | <url>      | <OPEN/MERGED/CLOSED>, checks <summary> |

## Spike to PR map

One row per PR link found on the spike. "Deployment note" is the text the spike puts next to the link, verbatim.

| Spike heading                 | PR                             | PR state | Deployment note     |
| ----------------------------- | ------------------------------ | -------- | ------------------- |
| <heading the link sits under> | [prs/<file>.md](prs/<file>.md) | OPEN     | Deployed to staging |

## Ticket references

| Ticket | Status   | Sprint           | PRs referenced     | Tickets referenced | Issue links                       |
| ------ | -------- | ---------------- | ------------------ | ------------------ | --------------------------------- |
| <KEY>  | <status> | <sprint or none> | prs/<file>.md, ... | <KEY>, ...         | blocks <KEY>; is blocked by <KEY> |

## PR keys

| PR            | Jira key      | Matches                    |
| ------------- | ------------- | -------------------------- |
| prs/<file>.md | <KEY or none> | epic / ticket <KEY> / none |

## Placeholders

Unresolved template text found in tickets.

| File              | Line | Text               |
| ----------------- | ---- | ------------------ |
| tickets/<file>.md | <n>  | `acme-web: <link>` |

## Observations

Fetch-time notes that would otherwise have been written into the documents. One per line, numbered, each naming the file and heading it concerns.

- O1: <file> under "<heading>" — <what you noticed>
```
