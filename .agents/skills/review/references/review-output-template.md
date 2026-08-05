# Code Review Output Template

Use this **exact format** when presenting synthesized review findings. Findings are grouped by severity, not by reviewer.

**IMPORTANT:** Use pipe-delimited markdown tables (`| col | col |`). Do NOT use ASCII box-drawing characters.

## Example

```markdown
## Code Review Results

**Scope:** merge-base with the review base branch -> working tree (14 files, 342 lines)
**Intent:** Add order export endpoint with CSV and JSON format support
**Mode:** interactive
**Reviewers:** correctness, testing, maintainability, security, api-contract

- security -- new public endpoint accepts user-provided format parameter
- api-contract -- new /api/orders/export route with response schema

### CI Status

| Check     | Status    | Details   |
| --------- | --------- | --------- |
| lint      | ✅ passed |           |
| typecheck | ✅ passed |           |
| tests     | ✅ passed | 214 tests |
| build     | ✅ passed |           |

### Applied (safe, verified)

| #   | File                       | Fix                                            | Reviewer |
| --- | -------------------------- | ---------------------------------------------- | -------- |
| 6   | `export_helper_test.rb:40` | Added missing test for the empty-format branch | testing  |

Validation: export tests 11 -> 13; suite 214 pass, lint clean.
Committed: `fix(review): cover empty-format branch`

### P0 -- Critical

| #   | File                      | Issue                                          | Reviewer | Confidence |
| --- | ------------------------- | ---------------------------------------------- | -------- | ---------- |
| 1   | `orders_controller.rb:42` | User-supplied ID in lookup, no ownership check | security | 100        |

- **#1** — `find(params[:id])` on the export path has no `where(account: current_account)` scope, so any authenticated user can export another account's orders.

### P1 -- High

| #   | File                   | Issue                                     | Reviewer    | Confidence |
| --- | ---------------------- | ----------------------------------------- | ----------- | ---------- |
| 2   | `export_service.rb:87` | Loads all orders into memory -- unbounded | performance | 100        |

### P2 -- Moderate

| #   | File                   | Issue                                           | Reviewer    | Confidence |
| --- | ---------------------- | ----------------------------------------------- | ----------- | ---------- |
| 3   | `export_service.rb:45` | No error handling for CSV serialization failure | correctness | 75         |

### Actionable Findings

| #   | File                      | Issue                   | Route                               | Notes                   |
| --- | ------------------------- | ----------------------- | ----------------------------------- | ----------------------- |
| 1   | `orders_controller.rb:42` | Ownership check missing | `gated_auto -> downstream-resolver` | `suggested_fix` present |

### Pre-existing Issues

| #   | File                      | Issue                                        | Reviewer    |
| --- | ------------------------- | -------------------------------------------- | ----------- |
| 1   | `orders_controller.rb:12` | Broad rescue masking failed permission check | correctness |

### Coverage

- Suppressed: 2 findings below anchor 75
- Residual risks: No rate limiting on export endpoint
- Testing gaps: No test for concurrent export requests
- CI: All checks passing

**Pre-merge checklist (when no PR CI data available):**

- [ ] `pnpm lint` passes with no errors
- [ ] `pnpm typecheck` passes with no type errors
- [ ] `pnpm build` completes successfully
- [ ] Tests pass

---

> **Verdict:** Ready with fixes
>
> **Reasoning:** 1 critical auth bypass must be fixed. CI is green. Lint, typecheck, and tests all pass.
>
> **Fix order:** P0 auth bypass -> P1 memory issue -> P2 error handling if straightforward
```

## Formatting Rules

- **Pipe-delimited markdown tables** for findings -- never ASCII box-drawing characters
- **Severity-grouped sections** -- `### P0 -- Critical`, `### P1 -- High`, `### P2 -- Moderate`, `### P3 -- Low`. Omit empty severity levels.
- **Stable sequential finding numbers** -- continue across severity sections
- **Always include file:line location** for code review issues
- **Reviewer column** shows which persona(s) flagged the issue
- **Confidence column** shows the finding's anchor as an integer (`50`, `75`, or `100`)
- **No `Route` column in the per-severity tables** -- the route appears only in Actionable Findings
- **Detail line (per finding, as needed)** -- `- **#N** — <explanation>` under the severity table
- **CI Status section** -- include when PR CI data is available
- **Pre-merge checklist** -- include in Coverage when no PR CI data is available
- **Header includes** scope, intent, and reviewer team
- **Applied section (default mode only)** -- when fixes were applied
- **Coverage section** -- suppressed count, residual risks, testing gaps, CI status
- **Verdict in blockquote** with reasoning and fix order
- **Horizontal rule** (`---`) separates findings from verdict
