# Creating a Pull Request

## When to Use This Skill

Activate when the user asks to create a PR, open a pull request, or push changes for review.

## Project conventions (read first)

This skill is repo-agnostic. The concrete branch name, commit subject, and target repo come from
this project's config file — **never assume the `bluetel` / `BTAI` defaults apply here.**

Read `.agents/skills.config` (a `key=value` file at the target root). Relevant keys:

| Key              | Meaning                                            | Example                   |
| ---------------- | -------------------------------------------------- | ------------------------- |
| `ticket_prefix`  | Ticket namespace for this repo                     | `BTAI`                    |
| `branch_pattern` | Feature-branch shape; `{ticket}` = full id         | `feature/{ticket}`        |
| `commit_format`  | Commit subject shape; `{ticket}` + `{description}` | `{ticket}: {description}` |
| `base_branch`    | Branch PRs target                                  | `main`                    |
| `repo_owner`     | GitHub owner/org                                   | `bluetel`                 |
| `repo_name`      | GitHub repo                                        | `bluetel-ai`              |

Resolve them in this order:

1. `.agents/skills.config` if present (`sh .agents/skills/skills-install/... ` is not needed — just read the file).
2. Otherwise fall back to the project's `AGENTS.md`, then `CLAUDE.md` git-workflow section.
3. If neither is available, **ask the user** for the ticket id and branch/commit convention before continuing.

Then substitute the placeholders for this task: `{ticket}` → the actual ticket id (e.g. the
`ticket_prefix` plus the number the user gives, `BTAI-1234`); `{description}` → a short summary of
the change. In the commands below, `<branch>`, `<commit-subject>`, `<base>`, `<owner>`, `<repo>`
mean the resolved values.

## Procedure

### 1. Ensure changes are on a feature branch

If on the base branch, create and switch to a feature branch first (name from `branch_pattern`):

```bash
git checkout -b <branch>          # e.g. feature/BTAI-1234
```

### 2. Stage and commit

Use the resolved `commit_format` for the subject:

```bash
git add <files>
git commit -m "<commit-subject>"  # e.g. BTAI-1234: description of changes
```

### 3. Push the branch

```bash
git push -u origin <branch>
```

### 4. Create the PR

Open a pull request:

- **owner**: `<owner>`
- **repo**: `<repo>`
- **head**: `<branch>`
- **base**: `<base>`
- **title**: `<commit-subject>`
- **body**: Summary of what changed and why

Do **not** merge the PR — the user merges PRs to `<base>` manually.

### 5. Merging to staging (only if requested)

If the user also asks to merge to staging or deploy to staging, activate the **merging** skill. That skill covers the full merge-to-staging procedure, conflict resolution, and push.

Do **not** merge to staging automatically — wait for the user to explicitly ask.
