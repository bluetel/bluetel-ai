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

### 1. Verify the work before committing

Nothing gets committed until it has been through **both** gates below — the automated checks and an
independent review. A PR is a request for someone else's attention; arriving with a red build or an
obvious defect spends their time instead of yours.

Skip a gate only under a condition listed in [When it is OK to bypass verification](#when-it-is-ok-to-bypass-verification),
and say out loud which condition you are invoking.

#### 1a. Run the project's checks

Discover the real commands — do not guess or invent them. Look, in order:

1. `package.json` `scripts`, or `Makefile` / `justfile` / `Taskfile.yml`.
2. `AGENTS.md` / `CLAUDE.md`, which usually state the canonical invocation (task runner, package
   manager, monorepo filters).
3. `.github/workflows/*.yml` — whatever CI runs is, by definition, the bar the PR has to clear.

Cover every gate the project actually has:

| Gate          | Looks like                                                   |
| ------------- | ------------------------------------------------------------ |
| Format        | `prettier --check`, `format:check`, `fmt`                    |
| Lint          | `lint`, `lint:check`, `eslint`, `ruff`, `clippy`             |
| Typecheck     | `typecheck`, `tsc --noEmit`, `mypy`                          |
| Tests         | `test`, `vitest run`, `jest`, `pytest`                       |
| Design lint   | a11y / design-token / visual-rule checks, Storybook a11y run |
| Build         | `build`                                                      |
| Repo-specific | dead-code (`knip`), spellcheck, quality gates (`qlty`)       |

Rules:

- **Run the whole affected scope**, not just the file you edited. Where the repo has a changed-files
  runner (`nx affected`, `turbo --filter`, `lint-staged`), use it — that is the scope CI uses.
- **Every gate must pass.** A failure is work to do, not a caveat to write down.
- **Do not silence a check to make it green.** No new `eslint-disable`, `@ts-ignore`, `.skip`, or
  blind snapshot updates. If a rule genuinely should not apply here, suppress it deliberately and
  explain why in the PR body.
- **Pre-existing failures:** if a gate fails for a reason your change did not cause, confirm it by
  running the same gate on `<base>` before dismissing it, then say so in the PR body. Do not assume.
- **A gate the project does not have is not a gate you skipped.** Note "no typecheck in this repo"
  and move on; never fabricate a command.

#### 1b. Clean-room self-review

Your own account of a change is the least reliable review of it — you already believe it works.
Get an independent read before committing:

- Spawn a **sub-agent** and have it run the **review** skill against the current branch
  (`mode:agent` returns JSON, which is easier to work through as a queue).
- **Clean room means the reviewer gets the artefacts, not your conclusions.** Hand it the diff, the
  ticket/issue text, and the base ref. Do **not** hand it your summary, your rationale, or "I've
  already confirmed X" — every assumption you pass along is precisely the one it can no longer test
  for you.
- Work the findings: fix P0 and P1 before committing. Fix P2/P3 or list them in the PR body under
  **Known follow-ups** — do not drop them silently.
- **Re-run 1a after applying fixes.** Review fixes break builds like any other edit.
- Disagreeing with a finding is fine; doing it in writing is the price. State why in the PR body so
  the human reviewer can weigh it.

If the **review** skill is not installed in this project, still run the sub-agent — give it the diff
and ask it to review for correctness, security, and project-standard violations from scratch. The
independence is the part that matters; the persona pipeline is the refinement.

### 2. Capture visual evidence (any user-visible change)

If the change alters something a person looks at — a screen, a component, a chart, a CLI's output,
an email template — the PR needs a picture. Without one, the reviewer has to check out the branch
and rebuild it just to see what you did.

**Show before and after, side by side.** An "after" shot alone proves the page renders; it does not
show what changed. Put both in a two-column table so the diff is visible at a glance:

```markdown
| Before                | After               |
| --------------------- | ------------------- |
| ![before](BEFORE_URL) | ![after](AFTER_URL) |
```

**To capture the shots, activate the `visual-testing` skill.** Serving the app, reaching a route in a
usable state, and driving a browser headlessly are its job, not this skill's — it knows which command
starts the project, which port it lands on, and what auth or seed data a page needs. Do not improvise
a dev command or a URL: a screenshot of an error page or of the wrong route is worse than no
screenshot, because it still looks like evidence. If that skill is not installed and the project's
own docs are silent, ask the user.

What this skill cares about is the result. Keep the pair honest:

- **Identical viewport, URL, theme, and data.** The only difference between the two frames should be
  your change. A different window size or a different seed makes the comparison worthless.
- **One pair per breakpoint** the change affects (mobile + desktop), and **per theme** if the project
  has light and dark modes.
- **Record video for anything with motion or interaction** — a transition, a drag, a multi-step flow.
  A still cannot show it.
- **Capture "before" from the base branch**, either before you start or from a base-branch checkout.
  Reconstructing it after the fact from memory is how misleading comparisons get made.

Upload the files and embed the returned URLs — see
[Attaching images and video](#attaching-images-and-video).

### 3. Ensure changes are on a feature branch

If on the base branch, create and switch to a feature branch first (name from `branch_pattern`):

```bash
git checkout -b <branch>          # e.g. feature/BTAI-1234
```

### 4. Stage and commit

Use the resolved `commit_format` for the subject:

```bash
git add <files>
git commit -m "<commit-subject>"  # e.g. BTAI-1234: description of changes
```

Let the project's hooks run. If a hook fails, fix the cause — `--no-verify` is reserved for the
bypass conditions below.

### 5. Push the branch

```bash
git push -u origin <branch>
```

### 6. Create the PR

Open a pull request:

- **owner**: `<owner>`
- **repo**: `<repo>`
- **head**: `<branch>`
- **base**: `<base>`
- **title**: `<commit-subject>`
- **body**: Summary of what changed and why, plus:
  - **Verification** — which gates you ran and their result; anything you could not run and why.
  - **Screenshots** — the before/after table for any user-visible change.
  - **Known follow-ups** — P2/P3 review findings you chose not to fix, and any finding you
    disagreed with, with your reasoning.

Do **not** merge the PR — the user merges PRs to `<base>` manually.

### 7. Merging to staging (only if requested)

If the user also asks to merge to staging or deploy to staging, activate the **merging** skill. That skill covers the full merge-to-staging procedure, conflict resolution, and push.

Do **not** merge to staging automatically — wait for the user to explicitly ask.

## When it is OK to bypass verification

There is one good reason to skip the gates: **the work is at risk of being lost, and pushing is the
only way to save it.** That usually means an ephemeral environment — a cloud sandbox, a CI
container, a remote agent session, a devbox about to be reclaimed — where the checks cannot run, or
would not finish before the machine goes away.

When that applies:

```bash
git commit --no-verify -m "<commit-subject> [wip: unverified]"
git push -u origin <branch>
```

and then:

- Open the PR as a **draft** (`gh pr create --draft`), or open no PR at all.
- State it in the first line of the PR body and the commit body: which gates were skipped, and why.
- Treat verification as **deferred, not cancelled**. Whoever picks the branch up runs step 1 before
  the PR leaves draft.

Also legitimate, and not really a bypass — just say so in the PR body:

- **A gate the project does not have.** Note it and move on.
- **A gate that cannot run in this environment** — e2e needing a browser, a check needing a live
  service or a secret you do not have. Name it, so a human runs it before merge.
- **A gate that does not apply to the change.** A README-only edit still gets format and lint if the
  repo lints markdown; it does not need the e2e suite.

Not reasons to skip:

- _"It's a small change."_ Small changes fail typecheck at about the same rate as large ones.
- _"The checks are slow."_
- _"CI will catch it."_ CI catching it costs a round trip and a red PR — and CI will not catch what
  the clean-room review catches.
- _A gate that is currently failing._ `--no-verify` relocates a failure; it does not fix one.

## Attaching images and video

GitHub serves PR attachments from `uploads.github.com/user-attachments/assets`. The endpoint accepts
a bearer token, so screenshots can be uploaded from the terminal rather than dragged into a browser.

Use the bundled script — it resolves the repository id from the git remote (or `repo_owner` /
`repo_name` in `.agents/skills.config`), picks the MIME type from the extension, and prints one URL
per file on stdout:

```bash
BEFORE=$(sh .agents/skills/pr-creation/scripts/gh-upload-asset.sh /tmp/pr-shots/before.png)
AFTER=$(sh .agents/skills/pr-creation/scripts/gh-upload-asset.sh /tmp/pr-shots/after.png)

gh pr comment <number> --body "| Before | After |
| --- | --- |
| ![before]($BEFORE) | ![after]($AFTER) |"
```

Equivalent one-off, without the script:

```bash
FILE=screenshot.png
REPO_ID=$(gh api "repos/<owner>/<repo>" --jq .id)

curl -s -X POST \
  "https://uploads.github.com/user-attachments/assets?name=$FILE&content_type=image/png&repository_id=$REPO_ID" \
  -H "Authorization: Bearer $(gh auth token)" \
  -H "Accept: application/json" \
  --data-binary "@$FILE"

# 201 → {"url":"https://github.com/user-attachments/assets/<uuid>"}
```

Things that will bite you:

- **Video needs a bare URL on its own line.** Wrapping it in `![](…)` stops GitHub rendering a
  player and produces a broken image instead.
- **The endpoint is undocumented.** It works today and may stop without notice. If an upload fails,
  do not keep retrying — ask the user to drag the file into the PR in the browser.
- **Token type matters.** `gh auth token` (a user token) is the verified path. An Actions-issued
  `GITHUB_TOKEN` is an installation token and is _not_ known to work — test it before relying on
  this in a workflow.
- **Size limits apply** (roughly 10MB for images, 100MB for video). Shrink the file rather than
  retrying the upload.
