---
name: review
description: 'Structured code review using tiered persona agents, confidence-gated findings, and a merge/dedup pipeline. Monitors GitHub PR CI status (Actions, lint, typecheck, tests). Use when: reviewing code changes before creating a PR, or verifying a PR is ready to merge.'
argument-hint: '[mode:agent] [blank to review current branch, or provide PR link]'
---

# Code Review

Reviews code changes using dynamically selected reviewer personas. Spawns parallel sub-agents that return structured JSON, then merges and deduplicates findings into a single report.

## When to Use

- Before creating a PR
- After completing a task during iterative implementation
- When feedback is needed on any code changes
- Can be invoked standalone
- Can run inside larger workflows; use `mode:agent` when the caller needs JSON instead of markdown tables

## CI Status Monitoring

Before delivering the final verdict, check the CI status of the PR (when reviewing a PR). This ensures lint, typecheck, and tests all pass before declaring a PR ready to merge.

### How It Works

1. **Fetch CI status.** When a PR number or URL is provided, query the PR's CI checks:

   ```
   gh pr checks <pr-number> --json name,state,conclusion
   ```

   If `gh pr checks` is unavailable, fall back to:

   ```
   gh api repos/{owner}/{repo}/commits/{sha}/check-runs --jq '.check_runs[] | {name, status, conclusion}'
   ```

2. **Evaluate results.** The following must all pass for a "Ready to merge" verdict:
   - **Lint** — ESLint (or equivalent) must pass with no errors
   - **Typecheck** — TypeScript compilation must succeed with no type errors
   - **Tests** — All test suites must pass (unit, integration, e2e as configured)
   - **Build** — The build step must complete successfully
   - **Any other CI checks** — All required status checks must be green

3. **Report CI status in the review output.** Add a `### CI Status` section after the header:
   - List each check with its status (✅ passed, ❌ failed, ⏳ pending, ⚠️ skipped)
   - If any check failed, include the failure reason and link to the Actions run
   - If checks are still pending, note this in the verdict

4. **Verdict interaction with CI:**
   - Any failing CI check → verdict cannot be "Ready to merge" (at best "Ready with fixes")
   - Pending checks → note uncertainty in verdict: "CI checks still running — verify before merge"
   - All green → CI does not block the verdict (findings still determine it)

### Local Verification (standalone/branch review without PR)

When reviewing without a PR (standalone or branch mode), CI status is not available from GitHub. Instead, remind the user to verify locally:

```
**Pre-merge checklist (verify locally):**
- [ ] `pnpm lint` passes with no errors
- [ ] `pnpm typecheck` passes with no type errors
- [ ] `pnpm build` completes successfully
- [ ] Tests pass (`pnpm test` or equivalent)
```

Include this checklist in the Coverage section when no PR CI data is available.

## Argument Parsing

Parse `$ARGUMENTS` for optional tokens. Strip each recognized token before interpreting the remainder as a PR number, GitHub URL, or branch name.

| Token              | Example                                           | Effect                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode:agent`       | `mode:agent`                                      | **Report-only**: return **JSON** instead of markdown tables and skip the Stage 5c apply (the caller applies). Does not change reviewer selection, merge logic, or scope rules (see Output format) |
| `mode:headless`    | `mode:headless`                                   | **Deprecated alias** for `mode:agent`                                                                                                                                                             |
| `mode:report-only` | `mode:report-only`                                | **Deprecated — ignored.** Former no-artifacts mode; default behavior is review-only without checkout                                                                                              |
| `base:`            | `base:abc1234` or `base:origin/main`              | Diff base on the **current checkout** (explicit; skips auto base detection)                                                                                                                       |
| `plan:`            | `plan:docs/plans/2026-03-25-001-feat-foo-plan.md` | Plan file for requirements verification (explicit)                                                                                                                                                |
| `grouping:auto`    | `grouping:auto`                                   | **Default** — build thematic triage groups when findings span distinct concerns (Stage 5 step 9b)                                                                                                 |
| `grouping:off`     | `grouping:off`                                    | Suppress triage groups: no Triage Groups section, empty `triage_groups` in JSON                                                                                                                   |
| `grouping:always`  | `grouping:always`                                 | Always build triage groups, even for small reviews                                                                                                                                                |

**Grouping is presentation, not a mode.** The `grouping:` tokens change how the finding set is organized for triage — never reviewer selection, merge logic, scope rules, or the Stage 5c apply decision.

**Mode alias:** `mode:headless` normalizes to `mode:agent`. `mode:agent` + `mode:headless` is not a conflict.

**Conflicting arguments:** Stop without dispatching reviewers when:

- Multiple incompatible scope selectors appear together (e.g. `base:` **and** a PR number/branch target — `base:` means "review the current checkout against this base")
- Multiple distinct `mode:` tokens other than the `mode:agent`/`mode:headless` alias pair
- Multiple distinct `grouping:` tokens (e.g. `grouping:off` **and** `grouping:always`)

Deprecated `mode:autofix` is **not** a conflict — ignore the token and proceed with the normal flow (see below).

Emit a one-line failure reason. In `mode:agent`, return JSON: `{"status":"failed","reason":"..."}`.

## Operating principles

Same pipeline for default and `mode:agent`:

- **Apply locally; never push.** Never push, open PRs, or file tickets in any mode — push is the outward step the user owns. In **default (interactive)** mode the review applies safe, verified fixes and commits them when the pre-review tree was clean (Stage 5c owns the full rule). In **`mode:agent`** it never mutates the tree — it reports and the caller applies.
- **No blocking prompts.** Never use `AskUserQuestion`, `request_user_input`, `ask_user`, or other blocking question tools. Infer intent, plan, and scope from explicit tokens, git state, PR metadata, and conversation. Note uncertainty in Coverage or the verdict — do not stop to ask.
- **Explicit mutations only.** Never run `gh pr checkout`, `git checkout`, `git switch`, or similar branch-switch commands. Passing a PR number, URL, or branch name selects **review scope**, not permission to mutate the working tree.
- **Smart defaults.** Untracked files: review tracked changes only and list excluded paths in Coverage. Plan: use `plan:` when passed; otherwise discover conservatively from PR body or branch keywords. Weak advisory P2/P3 from testing/maintainability alone: demote to `testing_gaps` / `residual_risks` per Stage 5.
- **Lint, typecheck, and tests must pass.** A PR cannot be declared "Ready to merge" if lint, typecheck, or tests are failing. This applies to both CI-reported status and locally-verified results.

## Output format

| Invocation       | Deliverable                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------- |
| **Default**      | Markdown report (pipe-delimited finding tables) + Actionable Findings summary               |
| **`mode:agent`** | One JSON object (see ### JSON output format below) + the same `/tmp/.../review//` artifacts |

`mode:agent` is **report-only**: it skips the Stage 5c apply (the caller applies) and serializes findings as JSON instead of markdown. It does not change reviewer selection, merge logic, or scope rules — the JSON is the deterministic contract for programmatic and cross-harness callers.

The default markdown is the human view; keep it ASCII-safe (pipe tables, `->` not middot `·`, no box-drawing) so it degrades gracefully across terminals.

## Quick Review Short-Circuit

If `$ARGUMENTS` indicates the user wants a quick, fast, or light code review — and **`mode:agent` is not active** — do not dispatch the multi-agent flow. **Announce the chosen path** before any other work (Quick review vs Multi-agent review). Skip this announcement when `mode:agent` is active.

Sequence:

1. **Run the harness's built-in code review.** Forward any review target after stripping tokens. Then stop — do not dispatch the multi-agent pipeline.
2. **Exemption:** If no built-in review exists, continue into the full multi-agent review.
3. **`mode:agent` bypasses this short-circuit** — always run the full multi-agent review and return JSON.

**Deprecated:** `mode:autofix` is no longer supported — there is no apply _mode_. If passed, ignore the token and proceed with the normal flow (default applies safe fixes via Stage 5c; `mode:agent` reports and the caller applies).

## Severity Scale

All reviewers use P0-P3:

| Level  | Meaning                                                                                    | Action                 |
| ------ | ------------------------------------------------------------------------------------------ | ---------------------- |
| **P0** | Critical breakage, exploitable vulnerability, data loss/corruption                         | Must fix before merge  |
| **P1** | High-impact defect likely hit in normal usage, breaking contract                           | Should fix             |
| **P2** | Moderate issue with meaningful downside (edge case, perf regression, maintainability trap) | Fix if straightforward |
| **P3** | Low-impact, narrow scope, minor improvement                                                | User's discretion      |

## Action Routing

Severity answers **urgency**. `autofix_class` and `owner` are **signal** describing follow-up shape for callers — **not apply permission or an apply gate.**

| `autofix_class` | Default owner                    | Meaning                                                          |
| --------------- | -------------------------------- | ---------------------------------------------------------------- |
| `gated_auto`    | `downstream-resolver` or `human` | Concrete `suggested_fix` proposed; caller applies after judgment |
| `manual`        | `downstream-resolver` or `human` | Actionable work needing design input or handoff                  |
| `advisory`      | `human` or `release`             | Report-only — learnings, rollout notes, residual risk            |

Routing rules:

- **Synthesis owns the final route.** Persona-provided routing metadata is input, not the last word.
- **Choose the more conservative route on disagreement.**
- **Reject `safe_auto` and `review-fixer` if present** — drop the finding or remap to `gated_auto` / `downstream-resolver` during synthesis.
- **`requires_verification: true` means any caller-applied fix needs targeted tests or follow-up validation.**

## Reviewers

14 reviewer personas in layered conditionals. Quick roster with one-line triggers below; the persona catalog included at the bottom has the full per-persona selection criteria and spawn gates.

**Always-on (every review):** `correctness-reviewer`, `testing-reviewer`, `maintainability-reviewer`, `project-standards-reviewer`.

**Cross-cutting conditional (per diff):**

- `security-reviewer` — auth, public endpoints, user input, permissions
- `performance-reviewer` — DB queries, data transforms, caching, async
- `api-contract-reviewer` — routes, serializers, type signatures, versioning
- `data-migration-reviewer` — migration files / schema dumps / backfills (see spawn gate in Stage 3)
- `reliability-reviewer` — error handling, retries, timeouts, background jobs
- `adversarial-reviewer` — >=50 changed code lines, or auth / payments / data mutations / external APIs
- `previous-comments-reviewer` — PR with existing review comments (PR-only, comment-gated)

**Stack-specific conditional (per diff):** `frontend-races-reviewer` (Stimulus/Turbo, DOM events, async UI) and `swift-ios-reviewer` (Swift/SwiftUI/UIKit, entitlements, Core Data, `.pbxproj`).

## Review Scope

Every review spawns all 4 always-on personas, then adds whichever cross-cutting and stack-specific conditionals fit the diff. The model naturally right-sizes: a small config change triggers 0 conditionals = 4 reviewers. A feature might trigger security + reliability + adversarial = 7 reviewers.

## How to Run

### Stage 1: Determine scope

Compute the diff range, file list, and diff. Minimize permission prompts by combining into as few commands as possible.

**If `base:` argument is provided (fast path):**

The caller already knows the diff base. Skip all base-branch detection, remote resolution, and merge-base computation. Use the provided value directly:

```
BASE_ARG="{base_arg}"
BASE=$(git merge-base HEAD "$BASE_ARG" 2>/dev/null) || BASE="$BASE_ARG"
```

Then produce the same output as the other paths:

```
echo "BASE:$BASE" && echo "FILES:" && git diff --name-only $BASE && echo "DIFF:" && git diff -U10 $BASE && echo "UNTRACKED:" && git ls-files --others --exclude-standard
```

**If a PR number or GitHub URL is provided as an argument:**

Do **not** check out the PR branch. Scope comes from GitHub read APIs plus optional local alignment when HEAD already matches the PR head branch.

**Skip-condition pre-check.** Before scope detection, run a PR-state probe:

```
gh pr view <number> --json state,title,body,files
```

Apply skip rules in order:

- `state` is `CLOSED` or `MERGED` -> stop with reason `PR is closed/merged; not reviewing.`
- **Trivial-PR judgment**: If the PR is only dependency lock-file or manifest-only bumps, automated release commits, chore version increments with no substantive code changes: stop with reason `PR appears to be a trivial automated PR; not reviewing.`

When any skip rule fires, stop without dispatching reviewers.

**If no skip rule fires**, fetch PR metadata **without checkout**:

```
gh pr view <number> --json title,body,baseRefName,headRefName,headRefOid,isCrossRepository,url,files,reviews,comments --jq '{title, body, baseRefName, headRefName, headRefOid, isCrossRepository, url, files: [.files[].path], hasPriorComments: ((.reviews | map(select(.state != "APPROVED" or .body != "")) | length) > 0 or (.comments | length) > 0)}'
```

**PR scope mode.** Classify as **`local-aligned`** only when **all** of these hold; otherwise use **`pr-remote`**:

1. `git rev-parse --abbrev-ref HEAD` equals `headRefName`.
2. The PR is **not** cross-repository (`isCrossRepository` is false).
3. The PR head commit is contained in the local checkout: `git merge-base --is-ancestor <headRefOid> HEAD` exits 0.

- **`local-aligned`** — all three checks pass. Local Read/Grep/git blame against workspace files are valid for PR changed paths.
- **`pr-remote`** — any check fails. The working tree is **not** the PR head; workspace file contents for changed paths may be stale or unrelated.

**If no argument (standalone on current branch):**

Detect base branch from `gh pr view --json baseRefName,url` or fall back to `main`/`master`. Produce:

```
echo "BASE:$BASE" && echo "FILES:" && git diff --name-only $BASE && echo "DIFF:" && git diff -U10 $BASE && echo "UNTRACKED:" && git ls-files --others --exclude-standard
```

Using `git diff $BASE` (without `..HEAD`) diffs the merge-base against the working tree, which includes committed, staged, and unstaged changes together.

**Untracked file handling:** Always inspect `UNTRACKED:`. Untracked paths are out of scope unless staged. When non-empty, list excluded files in Coverage and continue on tracked changes only — never stop or prompt.

### Stage 1b: CI Status Check (PR mode only)

When a PR number or URL is available, fetch CI check status:

```
gh pr checks <number> --json name,state,conclusion 2>/dev/null || gh api repos/{owner}/{repo}/commits/{headRefOid}/check-runs --jq '.check_runs[] | {name, status, conclusion}'
```

Record the results for inclusion in the final report. Key checks to look for:

- **lint** / **eslint** — code style and lint errors
- **typecheck** / **tsc** — TypeScript type checking
- **test** / **jest** / **vitest** — test suite results
- **build** — compilation/bundling
- **CI** / **main** — umbrella workflow status

If all checks pass, CI does not block the verdict. If any fail, the verdict cannot be "Ready to merge".

### Stage 2: Intent discovery

Understand what the change is trying to accomplish.

**PR/URL mode:** Use the PR title, body, and linked issues from `gh pr view` metadata.

**Standalone (current branch):** Run:

```
echo "BRANCH:" && git rev-parse --abbrev-ref HEAD && echo "COMMITS:" && git log --oneline ${BASE}..HEAD
```

Write a 2-3 line intent summary and pass this to every reviewer.

### Stage 2b: Plan discovery (requirements verification)

Locate the plan document so Stage 6 can verify requirements completeness. Check sources in priority order — stop at the first hit:

1. **`plan:` argument.** If the caller passed a plan path, use it directly.
2. **PR body.** Scan for paths matching `docs/plans/*.md`.
3. **Auto-discover.** Extract keywords from branch name, glob `docs/plans/*`.

If a plan is found, read its **Requirements** section and store for Stage 6.

### Stage 3: Select reviewers

Read the diff and file list from Stage 1. The 4 always-on personas are automatic. For each conditional persona, decide whether the diff warrants it.

**`previous-comments` is PR-only AND comment-gated.** Only select when both conditions hold:

1. Stage 1 gathered PR metadata.
2. `hasPriorComments` is true.

**`data-migration` spawn gate.** Select only when the diff includes migration or schema artifacts.

Announce the team before spawning:

```
Review team:
- correctness (always)
- testing (always)
- maintainability (always)
- project-standards (always)
- security -- new endpoint accepts user-provided input
```

### Stage 3b: Discover project standards paths

Find file paths of all relevant standards files (e.g. `CLAUDE.md`, `AGENTS.md`, `.kiro/steering/`) that govern the changed files. Pass these paths to the `project-standards` persona.

### Stage 4: Spawn sub-agents

Generate a unique run identifier before dispatching any agents:

```bash
RUN_ID=$(date +%Y%m%d-%H%M%S)-$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' ')
mkdir -p "/tmp/review/$RUN_ID"
```

Spawn each selected persona reviewer using the subagent template. Each persona sub-agent receives:

1. Their persona file content
2. Shared diff-scope rules
3. The JSON output contract
4. PR metadata when available
5. Review context: intent summary, file list, diff, scope mode
6. Run ID and reviewer name for artifact file path

Persona sub-agents are **read-only** with respect to the project: they review and return structured JSON. They do not edit project files.

### Stage 5: Merge findings

Convert multiple reviewer compact JSON returns into one deduplicated, confidence-gated finding set.

1. **Validate.** Check each return for required fields. Drop malformed returns.
2. **Deduplicate.** Fingerprint: `normalize(file) + line_bucket(line, +/-3) + normalize(title)`.
3. **Cross-reviewer agreement.** 2+ reviewers flag same issue → promote confidence by one step.
4. **Separate pre-existing.** Pull out `pre_existing: true` findings.
5. **Resolve disagreements.** Keep more conservative severity/routing.
6. **Normalize routing.** Remap legacy values.
   6b. **Mode-aware demotion.** Weak P2/P3 advisory-only from testing/maintainability → demote to soft buckets.
7. **Confidence gate.** Suppress below anchor 75. Exception: P0 at 50+ survives.
8. **Partition.** Actionable queue vs report-only queue.
9. **Sort and number.** Order by severity → anchor → file → line.
   9b. **Build thematic triage groups** (when `grouping:auto` or `grouping:always`).
10. **Collect coverage data.**

### Stage 5b: Validation pass (optional quality gate)

Spawn one validator sub-agent per surviving finding. Findings the validator rejects are dropped; confirmed findings flow through unchanged.

**When this stage runs:** After Stage 5 whenever at least one finding survives. When more than 15 survive, validate the highest-severity 15.

### Stage 5c: Act on findings (default mode only)

**Skip entirely in `mode:agent`.**

In default mode, apply safe, verified fixes before presenting the report.

**Act policy (bias to act).** Default to applying every finding that is a clear improvement and a reversible edit. Verify by running affected tests and lint after applying. If they fail, revert and report instead.

**Commit when the pre-review tree was clean.** Use a review-labeled commit: `fix(review): <summary>`.

**Never push, open a PR, or file tickets.**

### Stage 6: Synthesize and present

Assemble the final report.

1. **Header.** Scope, intent, mode, reviewer team.
2. **CI Status (PR mode).** Check results from Stage 1b.
3. **Applied (default mode only).** Stage 5c results.
4. **Triage Groups.** When groups exist.
5. **Findings.** Pipe-delimited tables grouped by severity.
6. **Requirements Completeness.** When a plan was found.
7. **Actionable Findings.** Findings the caller should address.
8. **Pre-existing.** Separate section.
9. **Coverage.** Suppressed count, residual risks, testing gaps, CI status, pre-merge checklist.
10. **Verdict.** Ready to merge / Ready with fixes / Not ready. Fix order if applicable.

**Verdict rules with CI:**

- Any P0 finding → "Not ready"
- Any failing CI check (lint, typecheck, tests, build) → cannot be "Ready to merge"
- All CI green + no P0/P1 → "Ready to merge" or "Ready with fixes" depending on remaining findings

### JSON output format (`mode:agent` only)

Emit one raw JSON object as the primary response. Minimum shape:

```json
{
  "status": "complete",
  "verdict": "Ready to merge | Ready with fixes | Not ready",
  "ci_status": {
    "lint": "pass | fail | pending | unknown",
    "typecheck": "pass | fail | pending | unknown",
    "tests": "pass | fail | pending | unknown",
    "build": "pass | fail | pending | unknown",
    "checks": []
  },
  "scope": {
    "base": "<merge-base sha>",
    "branch": "<current branch name>",
    "head_sha": "<git rev-parse HEAD>",
    "pr_url": "<url or null>",
    "files_changed": 0
  },
  "intent": "<2-3 line summary>",
  "reviewers": ["correctness", "security"],
  "findings": [],
  "actionable_findings": [],
  "triage_groups": [],
  "pre_existing_findings": [],
  "requirements_completeness": null,
  "residual_risks": [],
  "testing_gaps": [],
  "coverage": {},
  "artifact_path": "/tmp/review/<run-id>/",
  "run_id": "<run-id>"
}
```

## Quality Gates

Before delivering the review, verify:

1. **Every finding is actionable.** No "consider" or "might want to" without a concrete fix.
2. **No false positives from skimming.** Verify surrounding code was actually read.
3. **Severity is calibrated.** Style nit ≠ P0. SQL injection ≠ P3.
4. **Line numbers are accurate.** Verify against file content.
5. **Findings don't duplicate linter output.** Focus on semantic issues.
6. **CI is checked.** When PR data is available, CI status is reported and factored into verdict.
7. **Lint, typecheck, and tests are verified.** The verdict reflects whether these pass.

## After Review

After Stage 6, stop. Never push, open PRs, or file tickets from this skill.

### Emit actionable findings summary (default mode only)

After Stage 6 in default mode, emit a compact **Actionable Findings** summary. In `mode:agent` the actionable findings are in the JSON `actionable_findings` field.

Do not run post-review triage. The report and summary are the complete handoff.

### Run artifacts

Always write run artifacts under `/tmp/review/<run-id>/`:

- synthesized findings
- per-agent `{reviewer_name}.json` from Stage 4
- `report.md` (default mode)
- `review.json` (`mode:agent`)
- `metadata.json`

## Fallback

If the platform doesn't support parallel sub-agents, run reviewers sequentially. Everything else stays the same.

---

## Included References

### Persona Catalog

@./references/persona-catalog.md

### Subagent Template

@./references/subagent-template.md

### Diff Scope Rules

@./references/diff-scope.md

### Action class rubric

@./references/action-class-rubric.md

### Findings Schema

@./references/findings-schema.json

### Review Output Template

@./references/review-output-template.md

### Validator Template

@./references/validator-template.md
