# PR verification subagent template

Spawn one subagent per PR that has FRs pointing at it. Fill the slots and pass the result as the prompt. Read-only: the subagent must not check out branches, edit files, or write anywhere.

## Template

```
You are verifying whether a pull request implements specific requirements. Read-only: do not check out branches, edit files, commit, or write anywhere.

Pull request: {pr_url} ({pr_state})
Local summary: {pr_local_path}

Get the diff with:
  gh pr diff {pr_number} --repo {owner_repo}
If it is too large to read at once, use `gh pr diff ... --name-only` first, then `gh pr diff` with `--patch` and read the files relevant to each requirement.

For each requirement below decide exactly one verdict:
- implemented: the diff contains working code, config or infrastructure that delivers it
- partially implemented: part of it is present; say what is missing
- absent: nothing in the diff delivers it

Description text does not count as evidence. Only the diff does. A TODO, a commented-out block, or a disabled feature flag counts as partially implemented at best.

Requirements:
{fr_list}

Return exactly this pipe table and nothing else:

| FR | Verdict | Evidence (file, and hunk or symbol) | Missing |
| -- | ------- | ----------------------------------- | ------- |
```

## Variable reference

| Variable                      | Source                                       |
| ----------------------------- | -------------------------------------------- |
| `{pr_url}`                    | PR header, Source URL                        |
| `{pr_state}`                  | PR header, State                             |
| `{pr_local_path}`             | `current/prs/<file>.md`                      |
| `{pr_number}`, `{owner_repo}` | PR header, PR and Repository                 |
| `{fr_list}`                   | One line per FR: `FR-nn: <requirement text>` |

## Applying verdicts

| Verdict                    | Effect on fr.md                                                                 |
| -------------------------- | ------------------------------------------------------------------------------- |
| implemented on a MERGED PR | Status `done`                                                                   |
| implemented on an OPEN PR  | Status `partial` (a prototype is never done)                                    |
| partially implemented      | Status `partial`; copy Missing into Evidence                                    |
| absent                     | Status `todo`; note "claimed by <pr> description, absent from diff" in Evidence |
