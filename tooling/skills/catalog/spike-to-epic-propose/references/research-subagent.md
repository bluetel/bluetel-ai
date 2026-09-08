# Research subagent template

Spawn one subagent per kept repository. Fill the slots and pass the result as the prompt. Read-only: the subagent must not clone, check out, edit, or write anywhere.

## Template

```
You are checking whether a repository already contains specific things a spike asks to be built. Read-only: do not clone or check out anything, edit files, or write anywhere.

Repository: {owner_repo} (default branch)

For each term below, search with:
  gh search code "{term}" --repo {owner_repo} --json path,textMatches
and, when the snippet is not enough, read a hit in full with:
  gh api repos/{owner_repo}/contents/{path} -H "Accept: application/vnd.github.raw"
Try one or two spellings a developer would use (kebab, snake, camel case) before concluding absent. If search returns an error for this repository, report "search unavailable" for every term and stop.

For each term decide exactly one finding:
- present: working code, config or infrastructure delivers what the requirement describes
- partial: part of it is present; say what is missing
- absent: nothing in the repository delivers it

A TODO, a commented-out block, or a feature flag that exists but is off counts as partial at best. In Raised, report anything that makes the requirement harder to read: the term found in two unrelated places, a service or flag named differently from the spike, code that contradicts the spike. Leave Raised empty otherwise.

Terms:
{term_list}

Return exactly this pipe table and nothing else:

| FR | Term | Finding | Files (path, and symbol or line) | Missing | Raised |
| -- | ---- | ------- | -------------------------------- | ------- | ------ |
```

## Variable reference

| Variable       | Source                                                  |
| -------------- | ------------------------------------------------------- |
| `{owner_repo}` | Repositories table, Repository                          |
| `{term_list}`  | One line per term: `FR-nn: <term> — <requirement text>` |

## Applying findings

| Finding              | Effect on fr.md                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------- |
| present              | Status `done`; Files into Evidence prefixed `research: <repo>`                            |
| partial              | Status `partial`; Files and Missing into Evidence prefixed `research: <repo>`             |
| absent               | No change                                                                                 |
| search unavailable   | No change; note the repository under Research so the user knows it was not checked        |
| Raised (any finding) | New Ambiguities row typed `status`, `conflict` or `scope`, Location = the repository file |
