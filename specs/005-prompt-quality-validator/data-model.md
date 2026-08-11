# Phase 1 Data Model: Static prompt-quality validator

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-08-11

There is no database and nothing persisted at runtime. "Data model" here means the in-process types that the
modules hand to each other, plus the two checked-in data files. Types are shown as TypeScript because they are
the contract between modules; field-level validation rules trace back to the FRs that require them.

The pipeline is one direction, and each stage's output is the next stage's only input:

```text
config.ts ──┐
            ▼
scope/  ──► Scope ──► artifact/ ──► Artifact[] ──► rules/ ──► Finding[] ──► baseline/suppress ──►
                                                      │                                          │
                                              PathIndex (shared)                                  ▼
                                                                              score/ ──► Scorecard[] ──► report/ ──► Report ──► exit code
```

`rules/` receives already-loaded artifacts and a prebuilt `PathIndex`, so every rule is a pure function. That is
what makes the rule suites fixture-driven rather than temp-tree-driven, and it is what guarantees FR-029's
determinism structurally rather than by discipline.

---

## Artifact identity

### `ArtifactKind`

The classification that decides which rules apply and which budgets hold (FR-003).

| Kind                | Matches                                                        | Notes                                                         |
| ------------------- | -------------------------------------------------------------- | ------------------------------------------------------------- |
| `catalog-skill`     | `tooling/skills/catalog/*/SKILL.md`                            | The published body. The authority; installed copies mirror it |
| `catalog-meta`      | `tooling/skills/catalog/*/skill.meta`                          | `key=value`, repeatable keys                                  |
| `catalog-reference` | `tooling/skills/catalog/*/references/**/*.md`                  | Read by a skill mid-procedure                                 |
| `installed-skill`   | `.agents/skills/*/**/*.md`                                     | Compared against catalog for drift; excluded from redundancy  |
| `agent-pointer`     | `.claude/skills/*/SKILL.md`                                    | Frontmatter + one sentence. Excluded from redundancy (R6)     |
| `guidance`          | `AGENTS.md`, `CLAUDE.md`, `.agents/*.md`, `.claude/rules/*.md` | Loaded at run start                                           |
| `speckit-template`  | `.specify/templates/*.md`                                      | Placeholder tokens are its **content**; rule inverted         |
| `constitution`      | `.specify/memory/constitution.md`                              | Placeholder residue here is a real defect                     |
| `unclassified`      | matched a declared location, fits no kind                      | Reported, never skipped (FR-004)                              |

`specs/**` has no kind by default (research [R1](./research.md#r1)).

### `Artifact`

```ts
interface Artifact {
  /** Repo-relative, POSIX separators, stable across machines (FR-039). */
  path: string
  kind: ArtifactKind
  /** Raw content, or null when unreadable — see readError. */
  content: string | null
  /** Set when the file could not be read as UTF-8 text, is a symlink, or is empty (FR-007 edge cases). */
  readError: 'not-utf8' | 'symlink' | 'empty' | 'unreadable' | null
  /** Line-indexed view; null when content is null or the parse failed. */
  view: MarkdownView | null
  /** Parsed metadata for the kinds that have it; null otherwise or on parse failure. */
  meta: MetaBlock | null
  size: SizeMeasurement
  /** The skill directory this artifact belongs to, for the 3-root reference resolution (R2). */
  skillRoot: string | null
  suppressions: Suppression[]
}
```

**Validation rules**

- An artifact with a non-null `readError` yields a finding at `error` and is excluded from every rule that needs
  `content` — those rules are recorded as **not evaluated** for it, never as passing (spec edge case).
- `path` is always repo-relative; absolute paths never enter the model (FR-039, SC-005).
- A `catalog-meta` or `agent-pointer` whose metadata fails to parse yields `meta: null` plus one `error` finding,
  and metadata rules are marked not-evaluated rather than silently passing.

### `MarkdownView`

Output of the hand-written scanner (research [R3](./research.md#r3)). Purely positional; holds no judgement.

```ts
interface MarkdownView {
  lines: string[] // 0-indexed; findings report 1-indexed
  headings: { line: number; level: number; text: string }[]
  /** Inclusive line ranges to which content rules do not apply. */
  fenced: Range[]
  htmlComments: Range[]
  /** Inline code spans, per line, as column ranges. */
  codeSpans: Map<number, Range[]>
  links: { line: number; text: string; target: string }[]
  /** Path-shaped tokens (backticked, link target, or bare) with their position and context flags. */
  pathTokens: PathToken[]
}

interface PathToken {
  line: number
  raw: string
  inCodeSpan: boolean
  inFence: boolean
  inHtmlComment: boolean
  /** False when the token carries variable syntax — rule 2 of R2. */
  literal: boolean
}
```

### `MetaBlock`

Covers both `skill.meta` (`key=value`) and `.claude/` frontmatter (`key: value`), because every consumer needs
the same three things: the values, the duplicates, and the line each came from.

```ts
interface MetaBlock {
  format: 'skill-meta' | 'frontmatter'
  /** Repeatable keys keep every value in order — `next_step=` appears twice in speckit-plan (R4). */
  entries: { key: string; value: string; line: number }[]
  /** Keys seen more than once where the format does not permit repetition (FR-013). */
  duplicates: { key: string; lines: number[] }[]
  /** Lines inside the block that parsed as neither a comment nor key=value (FR-013). */
  strayLines: number[]
}
```

**Validation rules** (FR-012, FR-013): `catalog-meta` requires non-empty `name`, `version`, `description`;
`version` must be valid semver; `agent-pointer` frontmatter requires `name` and `description`. Repeatable keys are
`next_step` only — a repeated `name` or `version` is a duplicate finding.

### `SizeMeasurement`

```ts
interface SizeMeasurement {
  bytes: number
  chars: number
  words: number
  nonBlankLines: number
  /** Deterministic approximation, never a model-exact count (research R5). */
  approxTokens: number
}
```

---

## Rules and findings

### `Rule`

```ts
interface Rule {
  /** Stable `family/name` identifier. Never renamed — a suppression or baseline entry names it (FR-006). */
  id: RuleId
  /** Ships as this; overridable per rule in config.ts (plan: Adoption). */
  defaultSeverity: Severity
  /** One line: what it enforces. Surfaced by `--list-rules`. */
  statement: string
  /** Why it matters. Surfaced in the finding's remediation and in docs/rules.md. */
  rationale: string
  appliesTo: ArtifactKind[]
  /** Which score dimension its findings deduct from (research R7). */
  dimension: Dimension
  /** 'artifact' → run per artifact; 'set' → run once over the whole scope. */
  scope: 'artifact' | 'set'
  check: (input: RuleInput) => Finding[]
}
```

`scope: 'set'` exists because four rules are properties of the collection, not of a file:
`install/catalog-drift`, `install/version-bump`, `install/pointer-mismatch`,
`content/cross-artifact-duplication`. Modelling them as per-artifact rules is what would force each of them to
re-read the tree — the shape research [R2](./research.md#r2) and [R6](./research.md#r6) both avoid via
`PathIndex`.

### `Severity`

| Value   | Gate effect                                | Used for                                              |
| ------- | ------------------------------------------ | ----------------------------------------------------- |
| `error` | Fails the gate (`maxErrors` defaults to 0) | A defect that changes what an agent does              |
| `warn`  | Counted against `maxWarnings`; reported    | A defect being staged in, or a cost-only problem      |
| `note`  | Never fails; reported                      | Informational; the level baselined violations drop to |

### `Finding`

```ts
interface Finding {
  rule: RuleId
  severity: Severity // effective severity, after config override and baseline (FR-008)
  path: string
  line: number // 1-indexed
  column?: number
  /** Additional locations, for set-scoped rules — duplication clusters, drift pairs (FR-022). */
  related?: { path: string; line?: number }[]
  /** What is wrong. Names the offending value. */
  message: string
  /** What to do about it. Required, non-empty (FR-007, SC-006). */
  remediation: string
  /** Set when a baseline entry downgraded this finding, so the report can say so. */
  baselined?: boolean
}
```

**Validation rules**: `remediation` non-empty is enforced by the registry test, not by convention — SC-006 is a
property of every rule, and a rule that cannot say how to fix its finding is not ready to ship. Ordering is fixed
by `report/order.ts`: severity descending, then `path` ascending, then `line`, then `rule` — total and stable, so
SC-005 holds.

### `Suppression`

```ts
interface Suppression {
  rule: RuleId
  /** The line the suppression applies to (the line after the marker). */
  targetLine: number
  markerLine: number
  /** Required. A suppression without one is itself a finding (FR-009). */
  reason: string
  /** Set during evaluation; a suppression matching nothing is reported stale (FR-010). */
  used: boolean
}
```

Syntax is per format: `<!-- prompt-lint-disable-next-line <rule> — <reason> -->` in markdown,
`# prompt-lint-disable-next-line <rule> — <reason>` in `skill.meta`. Only next-line scope exists; file-wide
suppression is deliberately absent, because "this whole file is exempt" is a decision that belongs in the central
config where it is reviewable, not in the file being exempted.

### `BaselineEntry`

The checked-in `baseline.json` (FR-035).

```ts
interface BaselineEntry {
  rule: RuleId
  path: string
  /** Free text. Reviewed when the entry is added; not machine-interpreted. */
  reason: string
}
```

**Validation rules**: a matched entry downgrades the finding to `note` and sets `baselined: true`. An entry that
matches nothing is reported as a `stale-baseline` finding at `warn`, so the file drains. Entries are keyed on
`rule` + `path` only — deliberately not on line number, which would churn on every unrelated edit, and not on a
content hash, which would make the file unreadable.

---

## Scope and configuration

### `Scope`

```ts
interface Scope {
  mode: 'diff' | 'staged' | 'all'
  /** Present for mode 'diff'. */
  baseRef?: string
  /** Artifacts to evaluate per-artifact rules against. */
  targets: Artifact[]
  /** Every artifact in the declared set, regardless of mode — set-scoped rules need the whole picture. */
  universe: Artifact[]
  /** Path → exists, over the whole repo. Built once; the only filesystem read a rule sees (R2). */
  index: PathIndex
  /** What was excluded and why, so the run can report it (FR-005). */
  exclusions: { path: string; reason: string }[]
}
```

`targets` versus `universe` is the model's most consequential distinction. It is what makes US1 scenario 4 work:
deleting a referenced file puts nothing in `targets` for the _referring_ artifact, but the referring artifact is
in `universe`, and `refs/dangling-path` is evaluated over `universe` when the diff deletes any artifact. Stated as
a rule: **per-artifact rules run over `targets`; set-scoped rules run over `universe`.**

### `Config`

Every threshold, in one file, per FR-034 / SC-009. Shape mirrors `tooling/qlty-diff/src/config.ts` including the
`[ENV_VAR]` comment convention.

```ts
interface Config {
  /** Fails the gate above this. Default 0. [PROMPT_LINT_MAX_ERRORS] */
  maxErrors: number
  /** Default 50 — high enough to admit the staged rules, low enough to notice a flood. [PROMPT_LINT_MAX_WARNINGS] */
  maxWarnings: number
  /** Inert until Phase D; documented as such. [PROMPT_LINT_MIN_SCORE] */
  minScore: number
  /** Per-kind approxTokens budget, ≥25% headroom over the largest intended-passing artifact (R5). */
  sizeBudgets: Record<ArtifactKind, number>
  /** Window size for shingle clustering, and the minimum block size worth reporting (R6). */
  redundancy: { windowLines: number; minBlockLines: number }
  density: { minUniqueLineRatio: number }
  /** Per-rule severity override — the staged-adoption lever (plan: Adoption). */
  severities: Partial<Record<RuleId, Severity>>
  /** Path globs never evaluated, each with a recorded reason (FR-005). */
  exclude: { glob: string; reason: string }[]
  /** [PROMPT_LINT_BASE_REF] */ defaultBaseRef: string
}
```

**Validation rules** (FR-036, rejected before any artifact is read):

| Invalid configuration                                      | Rejected because                                        |
| ---------------------------------------------------------- | ------------------------------------------------------- |
| `minScore > 0` with a dimension weight of 0                | The score could not reach the minimum                   |
| `maxErrors > 0` while a rule is `error` and baselined      | Two mechanisms silently disagreeing about the same file |
| `redundancy.minBlockLines < redundancy.windowLines`        | No cluster could ever be reported                       |
| A `severities` key naming a rule that does not exist       | A silently-ineffective override (also catches renames)  |
| A `sizeBudgets` key for an unknown kind, or a kind missing | Blind spot by omission                                  |
| An `exclude` entry with an empty `reason`                  | FR-005 requires the exclusion be explainable            |

Any `PROMPT_LINT_*` override in effect is stated in the report header (FR-034), so a CI log can never look like a
clean pass under relaxed thresholds.

### `Scorecard` and `Report`

```ts
type Dimension = 'correctness' | 'redundancy' | 'density' | 'structure'

interface Scorecard {
  /** Repo-relative path, or null for the run-level aggregate. */
  path: string | null
  /** 0-100, integer. */
  score: number
  dimensions: Record<Dimension, { earned: number; max: number; deductions: number }>
}

interface Report {
  verdict: 'pass' | 'fail'
  scope: { mode: Scope['mode']; baseRef?: string; artifactCount: number; excludedCount: number }
  /** Absent when the artifact set was empty — FR-030 forbids scoring nothing. */
  scorecards?: { run: Scorecard; artifacts: Scorecard[] }
  findings: Finding[]
  counts: Record<Severity, number>
  thresholds: Config
  /** Overrides in effect, so the report is self-describing (FR-034). */
  overrides: { name: string; value: string }[]
  suppressions: { used: number; stale: Finding[] }
  baseline: { applied: number; stale: number }
}
```

Dimension maxima are Correctness 40, Redundancy 25, Density 20, Structure 15 (research
[R7](./research.md#r7)). The run-level score is the artifact-count-weighted mean of the per-artifact scores, so
one bad artifact in a large set does not read as a collapsed repository — and is stated as a mean in the output so
the number is not mistaken for a minimum.

---

## The 23 rules, by family

Full text — statement, rationale, fix — is the catalogue at [contracts/rules.md](./contracts/rules.md), which
`rules/registry.test.ts` cross-checks against the implemented set (FR-047, SC-010).

| Family         | Rules                                                                                            | Dimension   | Scope    |
| -------------- | ------------------------------------------------------------------------------------------------ | ----------- | -------- |
| `meta/`        | `required-field`, `duplicate-key`, `version-semver`, `stray-line`, `declared-dependency-missing` | correctness | artifact |
| `skill/`       | `use-when-trigger`, `section-missing`                                                            | correctness | artifact |
| `refs/`        | `dangling-path`                                                                                  | correctness | artifact |
| `template/`    | `placeholder-residue`                                                                            | correctness | artifact |
| `conventions/` | `config-mismatch`                                                                                | correctness | artifact |
| `install/`     | `catalog-drift`, `version-bump`, `pointer-mismatch`                                              | correctness | set      |
| `content/`     | `cross-artifact-duplication`                                                                     | redundancy  | set      |
| `content/`     | `density`, `size-budget`                                                                         | density     | artifact |
| `structure/`   | `degenerate`, `heading-skip`                                                                     | structure   | artifact |
| `content/`     | `self-contradiction`                                                                             | correctness | artifact |
| `artifact/`    | `unclassified`, `unreadable`                                                                     | correctness | artifact |
| `suppression/` | `unreasoned`, `stale`                                                                            | correctness | artifact |

Twenty-three rules across ten families. Nineteen of them have a catalogue entry and a configurable severity — the
four `artifact/` and `suppression/` rules are bookkeeping about the run itself (an unreadable file, an unreasoned
suppression), so there is nothing to promote, demote or baseline for them.
