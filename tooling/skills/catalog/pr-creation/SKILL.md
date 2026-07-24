# Creating a Pull Request

## When to Use This Skill

Activate when the user asks to create a PR, open a pull request, or push changes for review.

## Procedure

### 1. Ensure changes are on a feature branch

If on `main`, create and switch to a new branch first:

```bash
git checkout -b feature/URM-XXX
```

### 2. Stage and commit

```bash
git add <files>
git commit -m "URM-XXX: description of changes"
```

### 3. Push the branch

```bash
git push -u origin feature/URM-XXX
```

### 4. Create the PR

Open a pull request:

- **owner**: `harrytwigg`
- **repo**: `universal-react-monorepo`
- **head**: `feature/URM-XXX`
- **base**: `main`
- **title**: `URM-XXX: description of changes`
- **body**: Summary of what changed and why

Do **not** merge the PR — the user merges PRs to `main` manually.

### 5. Merging to staging (only if requested)

If the user also asks to merge to staging or deploy to staging, activate the **merging** skill. That skill covers the full merge-to-staging procedure, conflict resolution, and push.

Do **not** merge to staging automatically — wait for the user to explicitly ask.
