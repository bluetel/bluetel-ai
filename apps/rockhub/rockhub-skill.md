---
name: rockhub
description: >
  Process GitHub webhook events from the Rockhub app or direct user requests,
  distil the relevant context, and delegate to a coding agent (Copilot CLI or Kiro CLI)
  with a constructed prompt. Use for @bot-mentioned issues, PRs, comments, review requests,
  and direct coding tasks.
user-invocable: true
metadata: openclaw
emoji: 🪨
requires:
  bins:
    - git
    - gh
  anyBins:
    - copilot
    - kiro-cli
  install:
    - id: node-copilot
      kind: node
      package: '@github/copilot-cli'
      bins: copilot
      label: Install Copilot CLI (npm)
    - id: brew-kiro
      kind: brew
      formula: kiro-cli
      bins: kiro-cli
      label: Install Kiro CLI (brew)
---

# Rockhub Skill

> ⚠️ **DELEGATION IS MANDATORY.** OpenClaw's role in this skill is **routing only** —
> parse the event, build the prompt, and hand off to `copilot` or `kiro-cli`.
> OpenClaw **must never attempt to implement, review, or fix code itself** within its
> own session. Every coding task must be executed by a delegated background worker process.

Route GitHub webhook events or direct user requests to a coding agent
(Copilot CLI or Kiro CLI) as background workers.

## Two invocation modes

### Mode 1: Webhook-triggered (from Rockhub app)

When spawned by the Rockhub app, an `OpenclawInvocation` JSON envelope is
delivered via **stdin** (default), `$ROCKHUB_PAYLOAD_JSON` env var, an argv
argument, or a JSON file path.

Envelope shape:

```json
{
  "skill": "rockhub",
  "mentionIdentity": "<repo>:<sourceType>:<sourceId>",
  "eventName": "issue_comment.created",
  "deliveryId": "<github-delivery-uuid>",
  "origin": "webhook",
  "payload": {
    /* full GitHub webhook payload or synthesized payload */
  }
}
```

### Mode 2: Direct invocation (user types `/rockhub`)

The user invokes this skill directly from an OpenClaw chat session with a
free-form coding request. Arguments follow the skill name:

```
/rockhub fix the login bug in bluetel/my-app#42
/rockhub review PR #15 in bluetel/my-app
/rockhub implement feature described in bluetel/my-app#7
```

## Hard rules

- **OpenClaw must NOT process or implement any coding task itself.** Its only job is to parse, build a prompt, and delegate.
- **Delegation to `copilot` or `kiro-cli` is mandatory** — if neither binary is available, report failure immediately and stop.
- **The ONLY correct delegation mechanism is a plain bash shell command.** Do NOT use any agent protocol, MCP tool, context API, function call, or any other non-bash mechanism. Spawn the CLI binary as a subprocess via bash — that is all.
- Always launch the coding agent with `background:true`.
- Copilot CLI **exact bash invocation**: `copilot -p "$(cat "$PROMPT_FILE")" --allow-all` — `--allow-all` grants full tool/path/URL permissions required for non-interactive use. Alias: `--yolo`.
- Kiro CLI **exact bash invocation**: `kiro-cli chat "$(cat "$PROMPT_FILE")" --trust-all-tools --no-interactive` — `--trust-all-tools` allows any tool without confirmation; `--no-interactive` ensures it runs headlessly.
- Default to Copilot CLI unless user or config specifies Kiro.
- Capture a real notification route before spawning.
- Worker must send completion/failure via `openclaw message send`.
- **The sub-agent is responsible for replying on GitHub** (issue comments, PR reviews, review replies). OpenClaw does NOT post results back — the sub-prompt must include explicit `gh` commands for this.
- **Repo cloning must always target a fresh temp directory** — never use an existing checkout or the OpenClaw workspace.
- If both CLIs are unavailable, report failure immediately — do NOT attempt to handle the task in the OpenClaw session.
- Never run coding agents inside `~/.openclaw` or active OpenClaw state dirs.
- Write the worker prompt to a temp file to avoid shell quoting issues.

## Step 1: Detect invocation mode

Check for the OpenclawInvocation envelope:

1. Read stdin (if data available and valid JSON with `"skill": "rockhub"`).
2. Check `$ROCKHUB_PAYLOAD_JSON` environment variable.
3. Check argv for a JSON string or file path argument.
4. If none found → this is a **direct invocation**; use `$ARGUMENTS` as the user request.

## Step 2: Parse webhook payload (Mode 1 only)

Extract the coding task from the envelope based on `eventName`:

| eventName pattern               | Context to extract                                           |
| ------------------------------- | ------------------------------------------------------------ |
| `issues.opened/edited/reopened` | issue title + body → the task IS the issue description       |
| `issues.assigned`               | issue title + body → bot was assigned, implement the issue   |
| `issue_comment.created/edited`  | comment body → the task; include issue title for context     |
| `pull_request.opened/edited`    | PR title + body → review or implement what PR describes      |
| `pull_request.review_requested` | PR title + body → perform a code review                      |
| `pull_request_review_comment.*` | comment body → address the review feedback; include PR title |
| `*.synthesized`                 | same as above, from startup scan (treat identically)         |

From the payload, always extract:

- `repository.full_name` → the target repo
- `repository.owner.login` → owner
- `repository.name` → repo name
- Issue/PR number (from `issue.number` or `pull_request.number`)
- Issue/PR title (for context)
- Issue/PR body OR comment body (the actual task/request)
- Sender login (who triggered this)

## Step 3: Determine the coding agent

Priority order:

1. If `$ROCKHUB_ENGINE` is set → use that (`copilot` or `kiro`).
2. If the user's message/comment asks for copilot → use Copilot.
3. If the user's message/comment asks for Kiro → use Kiro.
4. Default → `copilot`.

Verify the chosen CLI binary exists:

```bash
command -v copilot >/dev/null 2>&1 || command -v kiro-cli >/dev/null 2>&1
```

If the preferred binary is missing, fall back to the other. If both missing, fail.

## Step 4: Construct the prompt

**Important:** All sub-prompts run in a fully ephemeral, non-interactive environment —
the sub-agent must be completely autonomous. If it hits a blocker it cannot resolve, it
must immediately report back to the originating GitHub issue/PR/comment thread (via `gh`)
and exit — never wait or ask. The sub-agent is also fully responsible for reporting
success back to GitHub; OpenClaw does NOT handle replies.

### Issue implementation prompt (issues.opened/edited/reopened/assigned, issue_comment)

```
ENVIRONMENT NOTICE: You are running in a fully ephemeral, non-interactive environment.
There is no human present to answer questions or unblock you. You must be completely
autonomous. If you encounter a blocker you cannot resolve on your own (ambiguous
requirements, missing credentials, unresolvable conflict, test failures you cannot fix),
do NOT wait or ask — immediately report back to the originating GitHub issue/comment
(see "Reporting back" below) with a clear explanation of what blocked you, then exit.

You are working on repository: {owner}/{repo}

Setup:
- Clone the repository to a fresh temp directory: git clone https://github.com/{owner}/{repo}.git $(mktemp -d)
- cd into the cloned directory.
- **Install dependencies (REQUIRED before doing any work):**
  1. Look for a `rocky.sh` script in the repo root — if present, run it: `bash rocky.sh`
  2. If no `rocky.sh`, make a best-effort install based on what's present:
     - `package.json` → `npm install` (or `yarn install` / `pnpm install` if lockfile indicates)
     - `requirements.txt` → `pip install -r requirements.txt`
     - `Pipfile` → `pipenv install`
     - `pyproject.toml` → `pip install -e .` or `poetry install`
     - `Gemfile` → `bundle install`
     - `go.mod` → `go mod download`
     - `Cargo.toml` → `cargo fetch`
     - `Makefile` with an `install` target → `make install`
  3. If install fails and is unrecoverable, report back to the issue and exit — do not proceed.
  - Check CONTRIBUTING.md, .github/CONTRIBUTING.md, docs/CONTRIBUTING.md, or any branching/workflow docs in the repo.
  - Check .github/CODEOWNERS, README.md, or any config files that describe branch patterns (e.g., refs to `feature/*`, `feat/*`, `issues/*`, `fix/*`, `JIRA-123`, ticket-prefixed names, etc.).
  - Check Husky hooks for enforced naming rules: inspect `.husky/pre-push`, `.husky/commit-msg`, and any referenced scripts (e.g., `scripts/validate-branch-name.sh`) for regex patterns or validation logic that constrain branch names or commit message formats — and comply with them.
  - If a convention is found, follow it exactly (e.g., `{prefix}/{ticket_or_issue_number}-{short-description}`).
  - If no convention is found, fall back to: `feature/{issue_number}` or `feat/{issue_number}` from the default branch.

Context:
- Issue #{issue_number}: {issue_title}
- Issue body: {issue_body}
- Triggering comment (if applicable): {comment_body}

Task:
{extracted_task_text}

Instructions:
- Implement the fix/feature described above.
- Run relevant tests to verify your changes work.
- Commit with a conventional commit message referencing #{issue_number}.
- Push the branch and open a PR against the default branch.
- For the PR body: first check if the repository has a PR template at
  .github/pull_request_template.md or .github/PULL_REQUEST_TEMPLATE.md or
  docs/pull_request_template.md — if found, follow that template structure.
  If no template exists, use a body that includes: Summary of changes +
  "Fixes {owner}/{repo}#{issue_number}".

Reporting back (REQUIRED — you must do this, OpenClaw will not):
- On success: comment on issue #{issue_number} with the PR URL and a brief summary:
  gh issue comment {issue_number} --repo {owner}/{repo} --body "✅ PR opened: <PR_URL>\n\n<brief summary of changes>"
- On failure or blocker you cannot resolve: comment on issue #{issue_number} immediately — do not wait:
  gh issue comment {issue_number} --repo {owner}/{repo} --body "❌ Blocked: <reason>\n\n<what was attempted and what information would be needed to proceed>"
```

For **direct invocations** (Mode 2), use the user's request as-is for the task
text, and infer repo/issue from the arguments (or use the current workspace).
If a repo is specified, always clone to a temp directory.

### PR review prompt (pull_request.review_requested)

```
ENVIRONMENT NOTICE: You are running in a fully ephemeral, non-interactive environment.
There is no human present to answer questions or unblock you. You must be completely
autonomous. If you encounter a blocker you cannot resolve on your own, do NOT wait or
ask — immediately post a review comment on the PR explaining what blocked you, then exit.

You are reviewing PR #{pr_number} in {owner}/{repo}.
PR title: {title}
PR description: {body}

Setup:
- Clone the repository to a fresh temp directory: git clone https://github.com/{owner}/{repo}.git $(mktemp -d)
- cd into the cloned directory.
- Fetch and checkout the PR branch: gh pr checkout {pr_number}
- **Install dependencies (REQUIRED before doing any work):**
  1. Look for a `rocky.sh` script in the repo root — if present, run it: `bash rocky.sh`
  2. If no `rocky.sh`, make a best-effort install based on what's present:
     - `package.json` → `npm install` (or `yarn`/`pnpm` if lockfile indicates)
     - `requirements.txt` → `pip install -r requirements.txt`
     - `Pipfile` → `pipenv install`
     - `pyproject.toml` → `pip install -e .` or `poetry install`
     - `Gemfile` → `bundle install`
     - `go.mod` → `go mod download`
     - `Cargo.toml` → `cargo fetch`
     - `Makefile` with an `install` target → `make install`
  3. If install fails and is unrecoverable, post a comment on the PR and exit.

Instructions:
- First check if the repository has a PR template at .github/pull_request_template.md
  or similar paths — use it to understand the project's PR standards and review against them.
- Review the code changes thoroughly (use `gh pr diff {pr_number}` or inspect files).
- Look for bugs, security issues, performance problems, and logic errors.
- If changes are needed, make them directly, commit, and push to the PR branch.
- If the PR looks good, approve it.

Reporting back (REQUIRED — you must do this, OpenClaw will not):
- Submit a PR review with your findings:
  gh pr review {pr_number} --repo {owner}/{repo} --approve --body "<summary>"
  OR if changes needed:
  gh pr review {pr_number} --repo {owner}/{repo} --request-changes --body "<findings>"
- If you made fixes, push them and comment:
  gh pr comment {pr_number} --repo {owner}/{repo} --body "🔧 Pushed fixes: <summary of changes>"
- If blocked by something you cannot resolve: post a comment immediately — do not wait:
  gh pr comment {pr_number} --repo {owner}/{repo} --body "❌ Blocked: <reason>\n\n<what was attempted and what information would be needed to proceed>"
```

### PR review comment prompt (pull_request_review_comment.created/edited)

```
ENVIRONMENT NOTICE: You are running in a fully ephemeral, non-interactive environment.
There is no human present to answer questions or unblock you. You must be completely
autonomous. If you encounter a blocker you cannot resolve on your own, do NOT wait or
ask — immediately reply to the originating review comment explaining what blocked you,
then exit.

You are addressing review feedback on PR #{pr_number} in {owner}/{repo}.
PR title: {title}
Review comment: {comment_body}

Setup:
- Clone the repository to a fresh temp directory: git clone https://github.com/{owner}/{repo}.git $(mktemp -d)
- cd into the cloned directory.
- Fetch and checkout the PR branch: gh pr checkout {pr_number}
- **Install dependencies (REQUIRED before doing any work):**
  1. Look for a `rocky.sh` script in the repo root — if present, run it: `bash rocky.sh`
  2. If no `rocky.sh`, make a best-effort install based on what's present:
     - `package.json` → `npm install` (or `yarn`/`pnpm` if lockfile indicates)
     - `requirements.txt` → `pip install -r requirements.txt`
     - `Pipfile` → `pipenv install`
     - `pyproject.toml` → `pip install -e .` or `poetry install`
     - `Gemfile` → `bundle install`
     - `go.mod` → `go mod download`
     - `Cargo.toml` → `cargo fetch`
     - `Makefile` with an `install` target → `make install`
  3. If install fails and is unrecoverable, reply to the review comment and exit.

Instructions:
- Read and understand the review comment/feedback.
- Make the requested changes.
- Run relevant tests to verify.
- Commit and push to the PR branch.

Reporting back (REQUIRED — you must do this, OpenClaw will not):
- Reply to the review comment thread confirming the fix:
  gh api repos/{owner}/{repo}/pulls/{pr_number}/comments/{comment_id}/replies --method POST --field body="✅ Addressed: <brief description of fix>"
- If blocked by something you cannot resolve: reply immediately — do not wait:
  gh api repos/{owner}/{repo}/pulls/{pr_number}/comments/{comment_id}/replies --method POST --field body="❌ Blocked: <reason>\n\n<what was attempted and what information would be needed to proceed>"
```

## Step 5: Launch the coding agent

> ⚠️ **Use bash. Only bash.** Do NOT use MCP, agent protocols, context APIs, function
> calls, or any other mechanism. The coding agent is a CLI binary — invoke it as a
> subprocess with a plain bash command, exactly as shown below. Nothing else is correct.

Write the full prompt to a temp file first (avoids all shell quoting issues), then run
the binary in a background bash process with a fresh working directory.

```bash
# 1. Create a fresh workdir and prompt file
WORKDIR=$(mktemp -d -t rockhub-work.XXXXXX)
PROMPT_FILE=$(mktemp -t rockhub-worker-prompt.XXXXXX)

# 2. Write the constructed prompt (including the notification block) into the file
cat > "$PROMPT_FILE" << 'EOF'
<constructed prompt text>
<notification block>
EOF
```

### Copilot CLI — bash command (background, with inline launch verification):

```bash
bash background:true workdir:"$WORKDIR" command:"copilot -p \"$(cat \"$PROMPT_FILE\")\" --allow-all & WORKER_PID=\$!; sleep 2; if kill -0 \$WORKER_PID 2>/dev/null; then echo 'Worker launched (PID: '\$WORKER_PID')'; else echo 'Worker failed to start — wrong flag, PATH issue, or binary not executable' >&2; exit 1; fi; wait"
```

`--allow-all` enables full tool, path, and URL permissions — required for non-interactive autonomous use. (`--yolo` is an alias for the same flag.)

The worker binary is backgrounded with `&` inside the **same** shell invocation so that `$!` correctly captures its PID. A `sleep 2` + `kill -0` check confirms it is still alive before `wait` blocks until it finishes. If the process has already exited the outer command exits with code 1, surfacing the failure immediately.

### Kiro CLI — bash command (background, with inline launch verification):

```bash
bash pty:true background:true workdir:"$WORKDIR" command:"kiro-cli chat \"$(cat \"$PROMPT_FILE\")\" --trust-all-tools --no-interactive & WORKER_PID=\$!; sleep 2; if kill -0 \$WORKER_PID 2>/dev/null; then echo 'Worker launched (PID: '\$WORKER_PID')'; else echo 'Worker failed to start — wrong flag, PATH issue, or binary not executable' >&2; exit 1; fi; wait"
```

`--trust-all-tools` allows the model to run any tool without confirmation. `--no-interactive` ensures it runs headlessly without waiting for user input.

**Do not:**

- Call `copilot` or `kiro-cli` via any tool other than bash
- Use MCP tools, agent context protocol, or OpenClaw function-call APIs to delegate
- Pass the prompt inline on the command line — always use the temp file via `$(cat "$PROMPT_FILE")`
- Split the spawn and verification into separate bash invocations — `$!` and `wait` only work within the same shell process; always embed verification inline in the same command

## Notification block

Append this to every worker prompt with real values:

```
---
Notification route:
- channel: <notifyChannel>
- target: <notifyTarget>
- account: <notifyAccount or omit>
- reply_to: <notifyReplyTo or omit>
- thread_id: <notifyThreadId or omit>

When finished, send exactly one completion or failure message using:
openclaw message send --channel <channel> --target '<target>' --message '<brief result>'
Add --account, --reply-to, or --thread-id only when present above.
```

If no trustworthy notification route exists, say auto-notify is unavailable.

## Step 6: Report to user

After spawning, immediately report:

- Which coding agent was launched (Copilot or Kiro)
- The target repo and issue/PR
- `mentionIdentity` (for traceability, webhook mode only)
- That the user will be notified on completion

## Direct invocation examples

```
User: /rockhub fix the broken CSS in bluetel/my-app#23
→ Parse: repo=bluetel/my-app, issue=#23
→ Fetch issue context with: gh issue view 23 --repo bluetel/my-app --json title,body
→ Construct prompt with issue context
→ Launch copilot -p "<prompt>"

User: /rockhub review bluetel/my-app#15
→ Parse: repo=bluetel/my-app, PR=#15
→ Fetch PR context with: gh pr view 15 --repo bluetel/my-app --json title,body,files
→ Construct review prompt
→ Launch copilot -p "<prompt>"

User: /rockhub add dark mode to the settings page
→ No repo/issue specified → use current workspace repo (from git remote)
→ Construct prompt with the user's request as the task
→ Launch copilot -p "<prompt>"
```

## Error handling

- If envelope JSON is malformed → log error, report failure, do not spawn.
- If required payload fields are missing → report what's missing, do not spawn.
- If `gh` auth fails when fetching context → report and ask user to authenticate.
- If the worker process is not alive 2 seconds after spawning → the launch failed; report the failure (the inline verification command will exit 1 with an error message), do not silently continue.
- If coding agent exits non-zero → report failure with last output lines.
- Never silently swallow errors — always report back to the user/channel.

## Process monitoring

After launch, the worker can be monitored with OpenClaw process commands:

- `list`: show running workers
- `poll`: check status
- `log`: view output
- `kill`: terminate if stuck
