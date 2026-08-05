# Merging a Feature Branch into Staging

## When to Use This Skill

**Only proceed with merging to staging when the user explicitly requests it.** This can happen:

- At the start of the workflow (e.g., "create a PR and merge to staging")
- After creating a PR (e.g., "now merge this to staging")
- At any other point when the user asks to deploy or merge to staging

**Do not automatically merge to staging** just because a PR was created. Always wait for explicit user instruction.

## Project conventions (read first)

This skill is repo-agnostic. The concrete branch names and target repo come from this project's
config file — **never assume the `bluetel` / `BTAI` / `staging` defaults apply here.**

Read `.agents/skills.config` (a `key=value` file at the target root). Relevant keys:

| Key              | Meaning                                    | Example            |
| ---------------- | ------------------------------------------ | ------------------ |
| `branch_pattern` | Feature-branch shape; `{ticket}` = full id | `feature/{ticket}` |
| `staging_branch` | Branch feature work is merged into         | `staging`          |
| `base_branch`    | Branch PRs target                          | `main`             |
| `repo_owner`     | GitHub owner/org                           | `bluetel`          |
| `repo_name`      | GitHub repo                                | `bluetel-ai`       |

Resolve them in this order: (1) `.agents/skills.config` if present; (2) otherwise the project's
`AGENTS.md`, then `CLAUDE.md` git-workflow section; (3) if neither is available, **ask the user**. Below, `<feature>`
is the resolved feature branch, `<staging>` the staging branch, `<base>` the PR base, and
`<owner>` / `<repo>` the GitHub target.

## Rules

- **Never rebase** `<staging>` onto a feature branch. Always use `git merge --no-ff`.
- **Never merge the PR** — only the user merges PRs to `<base>`.
- The feature branch is merged into `<staging>` directly (not via a PR).
- Always use `--no-ff` to preserve a named merge commit in the staging history.

## Full Procedure

### 1. Open a PR targeting `<base>`

Create a pull request before merging into staging:

- **owner**: `<owner>`
- **repo**: `<repo>`
- **head**: `<feature>`
- **base**: `<base>`
- **title**: the commit subject (see `commit_format`, e.g. `BTAI-XXX: description of changes`)
- **body**: Reference ticket, include testing instructions

Do **not** merge the PR — the user will do that manually.

### 2. Push the feature branch

Ensure the latest commits are on the remote before merging:

```bash
git checkout <feature>
git push
```

### 3. Merge into staging

```bash
git checkout <staging>
git pull
git merge <feature> --no-ff -m "<staging>: merge <feature>"
```

If the merge is **conflict-free**, Git creates the merge commit immediately — skip to step 5.

### 4. Resolve conflicts (if any — otherwise skip)

**Lockfile conflicts (`pnpm-lock.yaml` / `cdk/pnpm-lock.yaml`):**

- If **no** `package.json` or `cdk/package.json` changes are involved, keep staging's lockfile version:
  ```bash
  git checkout --ours pnpm-lock.yaml && git add pnpm-lock.yaml
  # or for the cdk lockfile:
  git checkout --ours cdk/pnpm-lock.yaml && git add cdk/pnpm-lock.yaml
  ```
- If `package.json` or `cdk/package.json` **was changed**, resolve the manifest conflict first, then regenerate the lockfile so CI `--frozen-lockfile` installs continue to work:
  ```bash
  # after resolving package.json:
  pnpm install                              # regenerates root pnpm-lock.yaml
  cd cdk && pnpm install && cd ..           # if cdk/package.json changed
  git add pnpm-lock.yaml cdk/pnpm-lock.yaml
  ```

**Other conflicts:** try to keep both intents; resolve manually.

### 5. Commit (only if there were conflicts)

Only needed when step 4 had conflicts — otherwise the merge commit was already created by `git merge`:

```bash
git commit -m "<staging>: merge <feature>"
```

### 6. Push staging

```bash
git push
```

## Summary

```
git checkout <staging> && git pull
git merge <feature> --no-ff -m "<staging>: merge <feature>"
# if conflict-free: merge commit is created — jump to push
# if lockfile conflict with no manifest changes:
#   git checkout --ours pnpm-lock.yaml && git add pnpm-lock.yaml
#   (and/or: git checkout --ours cdk/pnpm-lock.yaml && git add cdk/pnpm-lock.yaml)
# if lockfile conflict with manifest changes:
#   resolve package.json, then: pnpm install && git add pnpm-lock.yaml
# commit only if there were conflicts:
#   git commit -m "<staging>: merge <feature>"
git push
```
