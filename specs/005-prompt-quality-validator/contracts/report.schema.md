# Contract: machine-readable report schema

**Feature**: [../spec.md](../spec.md) | **Data model**: [../data-model.md](../data-model.md) | **Date**: 2026-08-11

`prompt-lint --json` emits exactly one JSON object on stdout and nothing else. This is the FR-038 surface: the
form in which an agent, a dashboard, or a future report-comparison tool consumes a run. It is a **stable
contract** — fields are added, never repurposed or removed without a version bump of `schemaVersion`.

## Object

```json
{
  "schemaVersion": 1,
  "verdict": "fail",
  "scope": {
    "mode": "diff",
    "baseRef": "origin/main",
    "artifactCount": 6,
    "universeCount": 141,
    "excluded": [
      {
        "path": "tooling/skills/catalog/frontend-design/LICENSE.txt",
        "reason": "third-party skill, vendored"
      }
    ]
  },
  "counts": { "error": 1, "warn": 3, "note": 2 },
  "findings": [
    {
      "rule": "refs/dangling-path",
      "severity": "error",
      "path": "tooling/skills/catalog/copywriting/references/natural-transitions.md",
      "line": 276,
      "column": 24,
      "message": "References `references/ai-writing-detection.md`, which does not exist relative to this artifact, its skill root, or the repository root.",
      "remediation": "Point at an existing reference, or remove the sentence. If the file is created at runtime, suppress with a reason.",
      "related": [],
      "baselined": false
    }
  ],
  "scores": {
    "run": {
      "path": null,
      "score": 87,
      "dimensions": {
        "correctness": { "earned": 34, "max": 40, "deductions": 6 },
        "redundancy": { "earned": 23, "max": 25, "deductions": 2 },
        "density": { "earned": 18, "max": 20, "deductions": 2 },
        "structure": { "earned": 12, "max": 15, "deductions": 3 }
      }
    },
    "artifacts": [{ "path": "AGENTS.md", "score": 100, "dimensions": { "…": {} } }]
  },
  "thresholds": {
    "maxErrors": 0,
    "maxWarnings": 50,
    "minScore": 0,
    "redundancy": { "windowLines": 8, "minBlockLines": 8 },
    "density": { "minUniqueLineRatio": 0.8 },
    "sizeBudgets": { "catalog-skill": 12000, "agent-pointer": 400 },
    "severities": { "skill/use-when-trigger": "warn" }
  },
  "overrides": [],
  "suppressions": { "used": 3, "stale": [] },
  "baseline": { "applied": 10, "stale": 1 }
}
```

## Field contract

| Field                    | Type                          | Contract                                                                           |
| ------------------------ | ----------------------------- | ---------------------------------------------------------------------------------- |
| `schemaVersion`          | integer                       | `1`. Incremented only on a breaking change; consumers must reject an unknown major |
| `verdict`                | `"pass" \| "fail"`            | Agrees with the exit code: `fail` ⟺ exit `1`                                       |
| `scope.mode`             | `"diff" \| "staged" \| "all"` | `baseRef` present iff `mode === "diff"`                                            |
| `scope.artifactCount`    | integer                       | Artifacts per-artifact rules ran over (`targets`)                                  |
| `scope.universeCount`    | integer                       | The whole declared set (`universe`) — set-scoped rules ran over this               |
| `scope.excluded`         | array                         | Every exclusion with a non-empty `reason` (FR-005)                                 |
| `counts`                 | object                        | One key per severity, always all three present, `0` rather than absent             |
| `findings`               | array                         | Ordered by severity, path, line, rule — total and stable (SC-005)                  |
| `findings[].remediation` | non-empty string              | Enforced by the registry test; a rule cannot ship without one (SC-006)             |
| `findings[].related`     | array                         | Additional locations for set-scoped rules; `[]` rather than absent                 |
| `findings[].baselined`   | boolean                       | `true` when a `baseline.json` entry downgraded this finding to `note`              |
| `scores`                 | object or **absent**          | **Absent** when the artifact set was empty (FR-030) and before Phase D lands       |
| `thresholds`             | object                        | The effective config — what the verdict was actually computed against              |
| `overrides`              | array                         | `PROMPT_LINT_*` variables in effect. Empty in CI, by policy (FR-034)               |
| `suppressions`           | object                        | `used` count and the stale ones as findings (FR-010)                               |
| `baseline`               | object                        | How many entries applied and how many are stale — the drain gauge                  |

## Invariants the tests assert

1. **Nothing but the object on stdout.** Diagnostics, progress and errors go to stderr, so `… --json | jq` never
   needs filtering. This is what makes it consumable by an agent without prompt-level parsing instructions.
2. **Determinism.** Two runs over an identical tree produce byte-identical JSON (SC-005). No timestamp, no
   duration, no absolute path, no `Date`, no unordered object key emitted from a `Map` or `Set` iteration.
3. **Human/JSON parity.** Every finding and every count visible in the human output appears here. The human output
   may _omit_ findings (it is capped, FR-037); the JSON never is.
4. **`verdict` and exit code cannot disagree.** Asserted directly, because a consumer branching on one while a CI
   step branches on the other is a defect that would otherwise surface only in production.
5. **`thresholds` reflects reality.** Serialised from the same object the gate compared against, not
   re-derived — so a report can never claim thresholds the run did not use.
6. **Empty scope is representable.** `artifactCount: 0`, `findings: []`, `scores` absent, `verdict: "pass"`. A
   consumer can distinguish "nothing to check" from "everything passed" (FR-040).
