# Phase 1 Data Model: Static prompt-quality validator

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-08-11

There is no database and nothing persisted at runtime. "Data model" here means the in-process types that the
modules hand to each other, plus the two checked-in data files. Types are shown as TypeScript because they are
the contract between modules; field-level validation rules trace back to the FRs that require them.

The pipeline is one direction, and each stage's output is the next stage's only input:

```text
config.ts ──┐
            ▼
scope/  ──► Scope ──► artifact/ ──► Artifact[] ──┬─► rules/ ─────────────► Finding[] ──┐
                                          │       │      ▲                              │
                                  PathIndex (shared)     │ pure functions               ▼
                                                  │                          baseline/suppress
                                                  └─► contextops/ ──► Bundle[] ──► contextops(1) ──► Finding[] + Scorecard[]
                                                                                                     │
                                                                                                     ▼
                                                                              score/ ──► report/ ──► Report ──► exit code
```

`rules/` receives already-loaded artifacts and a prebuilt `PathIndex`, so every rule is a pure function. That is
what makes the rule suites fixture-driven rather than temp-tree-driven, and it is what guarantees FR-029's
determinism structurally rather than by discipline.

`contextops/` is the second consumer of the same `Artifact[]`, and the **only** module in the tree that knows an
external process exists (FR-053). It groups artifacts into `Bundle`s, serialises each into the payload shape the
analyser reads, invokes it once per bundle, and maps what comes back into the same `Finding` and `Scorecard`
types every other stage speaks. Everything downstream of it is unaware of where a finding came from — which is
what lets one report, one ordering and one exit-code contract cover both halves.

---

## Artifact identity

### `ArtifactKind`

The classification that decides which rules apply and which budgets hold (FR-003).

| Kind                | Matches                                                        | Notes                                                         |
| ------------------- | -------------------------------------------------------------- | ------------------------------------------------------------- |
| `catalog-skill`     | `tooling/skills/catalog/*/SKILL.md`                            | The published body. The authority; installed copies mirror it |
| `catalog-meta`      | `tooling/skills/catalog/*/skill.meta`                          | `key=value`, repeatable keys                                  |
| `catalog-reference` | `tooling/skills/catalog/*/references/**/*.md`                  | Read by a skill mid-procedure                                 |
| `installed-skill`   | `.agents/skills/*/**/*.md`                                     | Compared against catalog for drift; never enters a bundle     |
| `agent-pointer`     | `.claude/skills/*/SKILL.md`                                    | Frontmatter + one sentence. Enters a bundle as `tools` (R10)  |
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
  /** Token count from the analyser's breakdown. Null until the delegated pass runs, and under --rules-only. */
  tokens: number | null
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

---

## The delegated half

### `Bundle`

The unit the analyser measures: a set of artifacts an agent loads together for one run
([research R10](./research.md#r10)). Not a file, and not the repository.

```ts
interface Bundle {
  /** Stable, deterministic: 'guidance' | 'speckit' | `skill:${string}`. Appears in findings. */
  id: string
  /** Artifacts forming the fixed prefix every run pays for — AGENTS.md, CLAUDE.md. */
  system: Artifact[]
  /** The bundle's own content — a skill body and its references; the rules and templates. */
  chunks: Artifact[]
  /** The skill-selection surface: `.claude/skills/*/SKILL.md` pointers. */
  tools: Artifact[]
}
```

**Validation rules**

- Every bundle has at least one `chunks` entry. A bundle of pure prefix measures the prefix, and would report
  the guidance documents once per skill.
- `.agents/skills/**` never enters a bundle: it is a copy of `catalog/**`, and including both would report
  installation itself as duplication ([R6](./research.md#r6)).
- An `agent-pointer` enters only as `tools`, never as `chunks` — 17 near-identical pointers are the installer's
  intended shape, and `chunks` is where redundancy is measured.
- `memory` is not modelled. There is no per-project memory store here, and filling the section with something
  that is not memory would produce a confident measurement of nothing.
- Bundle membership is derived from a sorted artifact list, so two runs build byte-identical payloads (FR-029).

### `AnalyserReport`

What comes back, narrowed to the fields relied on. Anything else the analyser emits is ignored rather than
passed through, so its output growing cannot change ours.

```ts
interface AnalyserReport {
  /** 0–100, the analyser's own number. Reported verbatim; never re-weighted (FR-048). */
  score: number
  dimensions: Record<AnalyserDimension, { penalty: number; max: number }>
  tokenBreakdown: {
    total: number
    bySection: Record<string, number>
    byItem: Record<string, number>
  }
  findings: { dimension: AnalyserDimension; message: string; items: string[] }[]
}

type AnalyserDimension = 'redundancy' | 'density' | 'structure' | 'concentration'
```

**Validation rules**

- A response that does not parse, or whose `score` is outside 0–100, is a run failure naming the bundle — never
  a bundle silently scored 0 (spec edge case).
- `findings[].items` are payload item identifiers; `contextops/map.ts` translates them back to artifact paths
  before a `Finding` is constructed. An item that cannot be translated keeps the bundle id as its location and
  says so, rather than guessing a file.
- `dimensions` maxima are asserted against the pinned version's published values (30/30/20/20). A mismatch means
  the engine changed under a pin that claimed it had not, and fails the run.

### `AnalyserBinary`

```ts
interface AnalyserBinary {
  /** Argv prefix: ['contextops'] | ['uvx', 'contextops@0.3.3'] | ['pipx', 'run', …] — R9's resolution order. */
  argv: string[]
  /** Reported by `--version`; asserted equal to config.contextops.version before any artifact is read. */
  version: string
  /** Which route resolved it, named in the report header so a run is reproducible. */
  source: 'env' | 'path' | 'uvx' | 'pipx'
}
```

**Validation rules**: unresolvable, or a `version` other than the pin, exits `6` (FR-050, FR-051). The
subprocess environment is constructed explicitly rather than inherited — `TIKTOKEN_CACHE_DIR` when configured,
`cwd` at the repo root — because an inherited variable is an unrecorded input.

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
  /** Which dimension the finding belongs to. 'correctness' is ours; the other four are the analyser's. */
  dimension: Dimension
  /** 'artifact' → per artifact; 'set' → once over the scope; 'bundle' → once per context bundle. */
  scope: 'artifact' | 'set' | 'bundle'
} & (
  | { source: 'prompt-lint'; check: (input: RuleInput) => Finding[] }
  /** Declared here for --list-rules, --explain and the catalogue cross-check; evaluated by contextops. */
  | { source: 'contextops'; check?: never }
)
```

`source` is the discriminant that keeps FR-047 true across the split. A delegated rule has no `check` body, but
it has an id, a statement, a rationale, a configurable severity and a catalogue entry exactly like any other —
so `--list-rules` shows 25 rules, `--explain contextops/concentration` answers, and the catalogue cross-check
(SC-010) cannot be satisfied by quietly documenting something nothing evaluates. `rules/delegated.ts` holds the
five declarations; `contextops/map.ts` produces their findings.

`scope: 'set'` exists because three rules are properties of the collection, not of a file:
`install/catalog-drift`, `install/version-bump`, `install/pointer-mismatch`. Modelling them as per-artifact rules
is what would force each of them to re-read the tree — the shape research [R2](./research.md#r2) avoids via
`PathIndex`. `scope: 'bundle'` is the five delegated rules, and exists because the thing they measure is a
relationship between artifacts loaded together ([R10](./research.md#r10)).

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
  /** 1-indexed. 0 for a bundle-scoped finding, which is about a set, not a line. */
  line: number
  column?: number
  /** Set for a bundle-scoped finding: which context bundle it was measured in. */
  bundle?: string
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
  /** Compared against the analyser's score. Ships at 0 (inert) until measured. [PROMPT_LINT_MIN_SCORE] */
  minScore: number
  /** Everything about the external analyser, in the same central file as the thresholds (FR-050). */
  contextops: {
    /** Exact pin. Asserted against `--version` before any artifact is read — a range would defeat the point. */
    version: '0.3.3'
    /** tiktoken encoding selector, passed as --model. Named in the report; changing it changes every count. */
    model: string
    /** Archetype passed as --profile. 'agent' — these are agent instruction bundles, not RAG context. */
    profile: 'agent'
    /** Written to a temp config file and passed as --config, so the analyser's thresholds live here too. */
    ratios: { system: number; retrieval: number; tool: number }
    /** [PROMPT_LINT_CONTEXTOPS_BIN] — explicit path, first in R9's resolution order. */
    binOverride?: string
  }
  /** Per-bundle and per-artifact token budgets, measured against the analyser's breakdown (FR-024). */
  tokenBudgets: { bundle: Record<string, number>; artifact: Record<ArtifactKind, number> }
  /** Per-rule severity override — the staged-adoption lever (plan: Adoption). */
  severities: Partial<Record<RuleId, Severity>>
  /** Path globs never evaluated, each with a recorded reason (FR-005). */
  exclude: { glob: string; reason: string }[]
  /** [PROMPT_LINT_BASE_REF] */ defaultBaseRef: string
}
```

**Validation rules** (FR-036, rejected before any artifact is read):

| Invalid configuration                                         | Rejected because                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `minScore` outside 0–100                                      | Unreachable in either direction; a gate that can never pass or never fail             |
| `minScore > 0` with `--rules-only`                            | A score threshold with nothing computing a score                                      |
| `maxErrors > 0` while a rule is `error` and baselined         | Two mechanisms silently disagreeing about the same file                               |
| A `severities` key naming a rule that does not exist          | A silently-ineffective override (also catches renames)                                |
| A `tokenBudgets.artifact` key for an unknown kind, or missing | Blind spot by omission                                                                |
| A `tokenBudgets.bundle` key naming no constructible bundle    | Same, one level up — a budget nothing is measured against                             |
| `contextops.version` not the exact pinned string              | A range is not a pin; the score would stop being comparable between machines (FR-050) |
| Any `contextops.ratios` value outside 0–1                     | The analyser rejects it after the run has already started doing work                  |
| An `exclude` entry with an empty `reason`                     | FR-005 requires the exclusion be explainable                                          |

Any `PROMPT_LINT_*` override in effect is stated in the report header (FR-034), so a CI log can never look like a
clean pass under relaxed thresholds.

### `Scorecard` and `Report`

```ts
/** 'correctness' is ours and is never scored; the other four are the analyser's and are never re-weighted. */
type Dimension = 'correctness' | AnalyserDimension

interface Scorecard {
  /** Bundle id, or null for the run-level aggregate. Scores are per bundle, not per file (R10). */
  bundle: string | null
  /** 0-100, integer — the analyser's number, unmodified (FR-048). */
  score: number
  dimensions: Record<AnalyserDimension, { penalty: number; max: number }>
  tokens: number
  /** What computed it. A score without its engine's version is not comparable with the next one. */
  analyser: { name: 'contextops'; version: string; model: string; profile: string }
}

interface Report {
  verdict: 'pass' | 'fail'
  scope: { mode: Scope['mode']; baseRef?: string; artifactCount: number; excludedCount: number }
  /** Absent when the set was empty (FR-030) or when the delegated half did not run (--rules-only). */
  scorecards?: { run: Scorecard; bundles: Scorecard[] }
  /** Which rules did not run and why — never silence. Populated on --rules-only and on a skipped bundle. */
  notEvaluated: { rule: RuleId; reason: string }[]
  findings: Finding[]
  counts: Record<Severity, number>
  thresholds: Config
  /** Overrides in effect, so the report is self-describing (FR-034). */
  overrides: { name: string; value: string }[]
  suppressions: { used: number; stale: Finding[] }
  baseline: { applied: number; stale: number }
}
```

Dimension maxima are the analyser's published ones — Redundancy 30, Density 30, Structure 20, Concentration 20 —
reported as it produces them (research [R7](./research.md#r7)). There is no correctness contribution to the
score: correctness is a finding count sitting beside it, because a dangling reference is not a number of points.

The run-level score is the token-weighted mean of the per-bundle scores, and is stated as a mean in the output so
it is not mistaken for a minimum. Token-weighted rather than count-weighted because a bundle nobody pays much for
should not move the number as much as one every run loads — and because the weights are then measured rather than
chosen, which is the same reason the dimensions are not re-weighted.

---

## The 25 rules, by family

Full text — statement, rationale, fix — is the catalogue at [contracts/rules.md](./contracts/rules.md), which
`rules/registry.test.ts` cross-checks against the implemented set (FR-047, SC-010).

| Family         | Rules                                                                                            | Dimension     | Scope    | Source      |
| -------------- | ------------------------------------------------------------------------------------------------ | ------------- | -------- | ----------- |
| `meta/`        | `required-field`, `duplicate-key`, `version-semver`, `stray-line`, `declared-dependency-missing` | correctness   | artifact | prompt-lint |
| `skill/`       | `use-when-trigger`, `section-missing`                                                            | correctness   | artifact | prompt-lint |
| `refs/`        | `dangling-path`                                                                                  | correctness   | artifact | prompt-lint |
| `template/`    | `placeholder-residue`                                                                            | correctness   | artifact | prompt-lint |
| `conventions/` | `config-mismatch`                                                                                | correctness   | artifact | prompt-lint |
| `install/`     | `catalog-drift`, `version-bump`, `pointer-mismatch`                                              | correctness   | set      | prompt-lint |
| `content/`     | `self-contradiction`                                                                             | correctness   | artifact | prompt-lint |
| `structure/`   | `degenerate`, `heading-skip`                                                                     | correctness   | artifact | prompt-lint |
| `contextops/`  | `redundancy`                                                                                     | redundancy    | bundle   | contextops  |
| `contextops/`  | `density`, `token-budget`                                                                        | density       | bundle   | contextops  |
| `contextops/`  | `structure-imbalance`                                                                            | structure     | bundle   | contextops  |
| `contextops/`  | `concentration`                                                                                  | concentration | bundle   | contextops  |
| `artifact/`    | `unclassified`, `unreadable`                                                                     | correctness   | artifact | prompt-lint |
| `suppression/` | `unreasoned`, `stale`                                                                            | correctness   | artifact | prompt-lint |

Twenty-five rules across eleven families. Twenty-one have a catalogue entry and a configurable severity — the
four `artifact/` and `suppression/` rules are bookkeeping about the run itself (an unreadable file, an unreasoned
suppression), so there is nothing to promote, demote or baseline for them.

Five of the twenty-one are `source: 'contextops'`. They are declared here, documented in the catalogue,
severity-configurable and suppressible exactly like the rest; what differs is only which process evaluates them.
`structure/degenerate` and `structure/heading-skip` stay ours despite the name overlap, because they are
properties of one markdown document's shape, while `contextops/structure-imbalance` is a property of how a
bundle's token cost is distributed across its components. Two different things that a shared word would have
quietly merged.
