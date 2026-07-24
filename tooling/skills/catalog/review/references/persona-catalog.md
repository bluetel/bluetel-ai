# Persona Catalog

14 reviewer personas organized into always-on, cross-cutting conditional, and stack-specific conditional layers.

## Always-on (4 personas)

Spawned on every review regardless of diff content.

| Persona             | Agent                        | Focus                                                                                                                         |
| ------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `correctness`       | `correctness-reviewer`       | Logic errors, edge cases, state bugs, error propagation, intent compliance                                                    |
| `testing`           | `testing-reviewer`           | Coverage gaps, weak assertions, brittle tests, missing edge case tests                                                        |
| `maintainability`   | `maintainability-reviewer`   | Structural quality, complexity deletion, 1k-line regressions, coupling, type-boundary leaks, dead code, premature abstraction |
| `project-standards` | `project-standards-reviewer` | Project conventions compliance — naming, cross-platform portability, tool selection, steering file rules                      |

## Conditional (7 personas)

Spawned when the orchestrator identifies relevant patterns in the diff. This is agent judgment, not keyword matching.

| Persona             | Agent                        | Select when diff touches...                                                                                                                       |
| ------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `security`          | `security-reviewer`          | Auth middleware, public endpoints, user input handling, permission checks, secrets management                                                     |
| `performance`       | `performance-reviewer`       | Database queries, ORM calls, loop-heavy data transforms, caching layers, async/concurrent code                                                    |
| `api-contract`      | `api-contract-reviewer`      | Route definitions, serializer/interface changes, event schemas, exported type signatures, API versioning                                          |
| `data-migration`    | `data-migration-reviewer`    | Migration files, schema dumps, backfill scripts, data transformations — **not** model/query-only changes without migration artifacts              |
| `reliability`       | `reliability-reviewer`       | Error handling, retry logic, circuit breakers, timeouts, background jobs, async handlers, health checks                                           |
| `adversarial`       | `adversarial-reviewer`       | Diff has >=50 changed non-test, non-generated, non-lockfile lines, OR touches auth, payments, data mutations, external API integrations           |
| `previous-comments` | `previous-comments-reviewer` | **PR-only AND comment-gated.** Reviewing a PR that has existing review comments from prior rounds. Skip when no PR metadata or no prior comments. |

## Stack-Specific Conditional (2 personas)

These reviewers cover runtime behavior the always-on personas do not specialize in.

| Persona          | Agent                     | Select when diff touches...                                                                                                                                 |
| ---------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frontend-races` | `frontend-races-reviewer` | Stimulus/Turbo controllers, DOM event wiring, timers, async UI flows, animations, or frontend state transitions with race potential                         |
| `swift-ios`      | `swift-ios-reviewer`      | Swift files, SwiftUI views, UIKit controllers, `.entitlements`, `PrivacyInfo.xcprivacy`, `.xcdatamodeld`, `Package.swift`, storyboards, XIBs, or `.pbxproj` |

## Selection rules

1. **Always spawn all 4 always-on personas.**
2. **For each cross-cutting conditional persona**, read the diff and decide whether the persona's domain is relevant. This is a judgment call, not a keyword match.
3. **For each stack-specific conditional persona**, use file types and changed patterns as a starting point, then decide whether the diff actually introduces meaningful work for that reviewer.
4. **For `data-migration`**, spawn only when the diff includes migration or schema artifacts.
5. **Announce the team** before spawning with a one-line justification per conditional reviewer selected.
