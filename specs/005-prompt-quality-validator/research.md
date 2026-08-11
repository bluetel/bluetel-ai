# Phase 0 Research: Static prompt-quality validator

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-08-11

Every decision below was reached by measuring this repository rather than by reasoning about prompt linting in
the abstract. Where a measurement is quoted, the command that produced it is given so it can be re-run.

The Technical Context in [plan.md](./plan.md#technical-context) carries no `NEEDS CLARIFICATION` markers, because
the eight open questions this feature had were each resolvable by inspection. Those eight are R1–R8.

---

<a id="r1"></a>

## R1. What counts as an AI-authored artifact, and is `specs/` in or out?

**Decision**: The declared set is exactly FR-002's list — the skill catalog, the two installed skill trees,
repo-level agent guidance, the Spec Kit templates and the constitution. Everything under `specs/` is **out of the
default set**, available behind an opt-in flag.

**Rationale**: The line that matters is _"does an agent read this at runtime and act on it?"_. A `SKILL.md` is
executed; `AGENTS.md` is loaded on every run; the constitution is the gate every plan checks against. A
`spec.md` is a **record** — written once, read by humans reviewing the change and by `/speckit-analyze` while the
feature is in flight, then archived. `specs/004-remove-reachability-gate/` is literally marked
`DEPRECATED … retained as a historical design record only`.

Gating records has a concrete cost with no matching benefit. `specs/004-…/checklists/requirements.md` contains
the line `- [x] No [NEEDS CLARIFICATION] markers remain`. A placeholder-residue rule over `specs/**` reports that
as a violation, and the only fixes available are to rewrite a historical document or to weaken the rule
everywhere. Meanwhile the failure mode this would protect against — a spec shipping with an unresolved marker —
is already covered by `/speckit-specify`'s quality checklist and `/speckit-analyze`, which exist for exactly that
and run while the spec is still being written.

**Alternatives considered**:

- _Include `specs/**` at `warn`._ Rejected: a permanently-warning corpus of archived documents trains people to
  ignore the warning column, which is the failure mode FR-035 and SC-011 exist to prevent.
- _Include only the currently-active feature directory (from `.specify/feature.json`)._ Rejected as
  scope-dependent behaviour: the same file would be linted or not depending on repo state, breaking the
  "identical input, identical output" property in FR-029.
- _Discover artifacts heuristically (any markdown containing imperative instructions)._ Rejected: FR-001 requires
  a declared, inspectable set. A heuristic makes the artifact set unreviewable and its blind spots undiscoverable.

---

<a id="r2"></a>

## R2. How should a referenced path be resolved before declaring it dangling?

This is the decision the whole feature's credibility rests on, so it was prototyped before being designed.

**The naive rule was measured first.** Extracting every backticked token ending in a file extension from the
prompt surface and requiring it to exist relative to the repo root:

```sh
files=$(ls AGENTS.md CLAUDE.md .agents/*.md .claude/rules/*.md; \
        find .agents/skills .claude/skills tooling/skills/catalog -name '*.md')
for f in $files; do
  grep -oE '`[.a-zA-Z0-9_/@-]+\.(md|ts|sh|json|mjs|yml|txt)`' "$f" | tr -d '`' | sort -u | \
    while read -r p; do [ -e "$p" ] || echo "$f -> $p"; done
done
```

**Result: 65 distinct referenced paths, 40+ reported as missing, of which exactly one was a real defect.** The
noise breaks down into four kinds, each of which tells you something about the resolution algorithm:

| Noise kind                 | Example                                                               | What it means                                        |
| -------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------- |
| Artifact-relative          | `review/references/subagent-template.md` → `references/diff-scope.md` | Exists — but relative to the artifact, not the root  |
| Runtime-created            | `speckit-plan/SKILL.md` → `.specify/extensions.yml`                   | A file the procedure checks for and tolerates absent |
| Feature-directory-relative | `speckit-analyze/SKILL.md` → `spec.md`, `plan.md`, `tasks.md`         | Relative to a directory that exists only mid-feature |
| Another project's tree     | `merging/SKILL.md` → `cdk/package.json`                               | A claim about the _target_ repo, not this one        |
| Variable-bearing           | `SPECIFY_FEATURE_DIRECTORY/spec.md`, `FEATURE_DIR/checklists/…`       | A template, not a path                               |

**Decision**: a reference is reported only when **all** of these hold:

1. It is **path-shaped** — it contains a `/`. A bare filename (`spec.md`, `report.md`, `metadata.json`) is never
   reported; there is no way to tell "the file next to the one you are writing" from "a file in this repo", and
   the bare-filename class was pure noise in the measurement.
2. It contains **no variable syntax** — no `$`, `{`, `<`, `*`, and no path segment that is `SCREAMING_SNAKE_CASE`
   (which is how every Spec Kit variable is written).
3. Its **first segment resolves to a real directory** in one of three roots, tried in order: the artifact's own
   directory, the artifact's skill root (for catalog and installed skills), then the repository root. If no root
   has that first segment, the reference is about somewhere else — a target project, a runtime tree — and is not
   this validator's business.
4. Given a root whose first segment matched, the **full path does not exist** there.

Rule 3 is what does the real work: it converts "I cannot find this file" into "you are making a claim about a
directory that exists, and the claim is false". Applied to the measurement, the 40+ hits collapse to **one**:

> `tooling/skills/catalog/copywriting/references/natural-transitions.md:276`
> `See the seo-audit skill's references/ai-writing-detection.md for a complete list of AI writing tells.`
> `references/` exists next to that artifact; `references/ai-writing-detection.md` does not, and there is no
> `seo-audit` skill anywhere in the catalog.

That is a genuine dangling reference, live in the published catalog, copied into every project that has installed
`copywriting`. One rule, one prototype, one real defect — and zero false positives on the current tree.

**Alternatives considered**:

- _Only check markdown link targets (`[text](path)`), not backticked paths._ Rejected: these artifacts point an
  agent at files in prose and in backticks far more often than in link syntax. It would have missed the one real
  defect, which is in backticks.
- _Maintain an allowlist of known-absent paths._ Rejected: an allowlist of ~40 entries is a second source of
  truth that rots, and it encodes the noise instead of understanding it. Rule 3 needs no list.
- _Report at `warn` and accept the noise._ Rejected: 40 false positives to 1 true positive is the ratio at which
  a gate stops being read.

---

<a id="r3"></a>

## R3. Parse markdown with a library, or by hand?

**Decision**: By hand — a single `artifact/markdown.ts` producing a line-indexed view: heading levels, fenced
code regions, inline code spans, HTML comment regions, link targets, and path-shaped tokens.

**Rationale**: Every rule in the catalogue needs one of five things — _which line is this on_, _is this inside a
code fence_, _is this inside an HTML comment_, _what heading am I under_, _is this token path-shaped_. None needs
an AST. A line-oriented scanner delivers all five in ~120 lines, keeps line numbers exact (FR-007 requires them,
and AST libraries vary in how faithfully they preserve positions through inline nodes), and adds no dependency to
a tool whose job is to be trustworthy.

The comment- and code-span-awareness is not optional detail: it is what stops the placeholder rule firing on
`.specify/memory/constitution.md`, whose `SYNC IMPACT REPORT` HTML comment legitimately quotes the bracketed
template tokens the rule detects, and on this feature's own `docs/rules.md`, which must quote every token it
matches (an edge case the spec calls out explicitly).

**Alternatives considered**:

- _`remark`/`mdast`._ Rejected on dependency grounds (Principle: zero new third-party dependencies for this tool)
  and because a full AST solves a problem no rule has.
- _Regex per rule, no shared scanner._ Rejected: each rule would independently re-derive "am I in a code fence",
  which is both the duplication `qlty:diff` would flag and the inconsistency that produces rule-specific false
  positives.

---

<a id="r4"></a>

## R4. Parse frontmatter and `skill.meta` with a YAML parser?

**Decision**: No parser. Two small hand-written readers: `artifact/frontmatter.ts` for the `---`-delimited flat
`key: value` block, and `artifact/meta.ts` for `skill.meta`'s `key=value` lines.

**Rationale**: The frontmatter actually in scope is flat and shallow — inspected across all 17
`.claude/skills/*/SKILL.md` files, every one is `name`, `description`, and optionally `argument-hint`, single-line,
values sometimes single-quoted. `skill.meta` is not YAML at all: it is `key=value` with **repeatable keys**
(`next_step=` appears twice in `speckit-plan/skill.meta`) and `|`-separated fields inside a value — a shape a
YAML parser would reject or mangle. The authority on that format is `tooling/skills/lib/skills.sh`'s `meta_get`,
which is POSIX shell doing line-oriented reads; a TypeScript reader that mirrors it is more faithful than a YAML
parser that does not.

Duplicate-key detection (FR-013) is also easier to do correctly here than through a parser, since most YAML
parsers silently last-one-wins.

**Alternatives considered**:

- _`yaml` / `js-yaml`._ Rejected: adds a dependency, cannot express `skill.meta` at all, and hides the duplicate
  keys one rule exists to find.
- _Shell out to `skills.sh meta_get`._ Rejected: a subprocess per key per artifact blows the time budget, and
  `skills.sh` is not a library — its functions are not addressable from outside.

---

<a id="r5"></a>

## R5. How is artifact size measured without a tokenizer?

**Decision**: A deterministic offline approximation in `artifact/size.ts` — count characters and whitespace-
delimited words, and report `approxTokens = max(ceil(chars / 4), ceil(words * 1.3))`. Budgets in `config.ts` are
set with at least 25% headroom above the largest artifact intended to pass.

**Rationale**: FR-046 forbids network and model calls; a real tokenizer means `tiktoken` (a native/WASM
dependency carrying a model-specific vocabulary) for a number that only ever feeds a threshold comparison. The
approximation's error on English prose is comfortably within ±20%, and the headroom rule means that error cannot
flip a verdict — which is the only property the budget rule needs. The spec records this as an assumption so a
reader does not mistake the number for a model-exact count; the report labels it `approxTokens` for the same
reason.

**Alternatives considered**:

- _`tiktoken`._ Rejected: a dependency and a model-specific vocabulary for a thresholded approximation. If a
  future rule needs exact counts (cost attribution, context-window packing) this decision is worth revisiting.
- _Bytes only._ Rejected: it makes the budget unintelligible to the person being asked to shrink a prompt, and
  penalises artifacts with wide characters arbitrarily.

---

<a id="r6"></a>

## R6. How is cross-artifact redundancy detected deterministically?

**Decision**: Shingle clustering. Normalise each line (collapse whitespace, lowercase, drop trailing
punctuation), slide a window of 8 consecutive non-blank normalised lines, hash each window, group windows by
hash, merge overlapping windows in the same pair of artifacts into maximal blocks, and report one finding per
cluster naming every location (FR-022, and US4 scenario 4's "once, not once per file").

**Rationale**: It is deterministic, needs no dependency, is linear in total lines, and reports at block
granularity rather than line granularity — which is the difference between "these two skills share a 40-line
block" and 40 separate findings. Window size 8 was chosen so that shared _boilerplate paragraphs_ are caught
while shared _single sentences_ (which convergent instruction-writing produces constantly) are not.

**The calibration matters more than the algorithm.** Two shapes in this repo are duplicated **by design**:

1. The 17 `.claude/skills/*/SKILL.md` pointers, each a frontmatter block plus one sentence naming the shared file.
   That is the installer's intended shape, not a defect (spec edge case). Kind `agent-pointer` is therefore
   excluded from cross-artifact redundancy entirely.
2. `.agents/skills/<name>/**` is a **byte-identical copy** of `catalog/<name>/**` — that is what installation
   _is_, and `install/catalog-drift` fires when it stops being true. Redundancy comparison therefore runs over
   one representative per skill (the catalog copy), never across the catalog/installed boundary.

Without both exclusions the rule would report the installer's design as its largest finding, which is how a rule
gets disabled wholesale — the outcome SC-011 forbids.

**Alternatives considered**:

- _`qlty smells`' duplication detection._ Rejected: it is tuned for code structure and does not run over
  markdown; and the repo already learned from `qlty-diff` that a duplication percentage over prose needs a
  different denominator than lines-of-code.
- _Token-level suffix automaton for exact longest common substrings._ Rejected as more machinery than the finding
  needs; block granularity at line level is what a human acts on.

---

<a id="r7"></a>

## R7. What are the score's dimensions, and do we copy `contextops`?

**Decision**: A 0–100 score from four weighted dimensions — **Correctness 40, Redundancy 25, Density 20,
Structure 15** — computed by deducting a per-finding weight within each dimension and flooring at 0.

**Rationale**: The four-dimension, bounded-score, dimension-decomposed shape is taken directly from `contextops`,
which is the right shape: a single number for trend and triage, always shown with the breakdown that produced it
so it is never a mystery. The weights are not taken from it. `contextops` scores redundancy 30, density 30,
structure 20 and _source concentration_ 20 — appropriate for retrieved RAG context assembled from many documents,
where over-reliance on one source is the failure mode. This repository's artifacts are hand-authored instruction
documents; there is no retrieval and no source distribution, so _concentration_ has no referent here and is
dropped. What dominates instead is **correctness**: a dangling reference silently removes half a procedure,
whereas 20% bloat merely costs tokens. Hence correctness at 40, the largest single weight.

The score is explicitly **not** what the gate decides on in Phase B — severity counts are (see
[plan.md](./plan.md#phasing-delivery-order-by-user-story)). A score that gates would invite arguing about weights
instead of fixing findings.

**Alternatives considered**:

- _Adopt `contextops`' weights unchanged for comparability._ Rejected: comparability with a tool measuring a
  different thing is not a benefit, and keeping a `concentration` dimension that is structurally always full
  marks would make the breakdown misleading.
- _Depend on or vendor `contextops`._ Rejected on two independent grounds, recorded in the spec's Assumptions:
  its licence (Sustainable Use) is not one this repo adopts for a build-blocking dependency, and it knows nothing
  of `skill.meta`, `.agents/skills.config` or the catalog/installed model — which is where the defects actually
  are. Its `inspect` / `check --min-score` / `diff` command shape is adopted; `diff` (report-vs-report comparison)
  is deferred per the spec's Assumptions.

---

<a id="r8"></a>

## R8. How could a target project that installs skills adopt this?

**Decision**: Deferred, with the path recorded. This repository is the reference implementation (spec
Assumptions); FR-045 is satisfied by _not foreclosing_ target adoption, not by shipping it now.

**Rationale**: `tooling/skills/README.md` states the installer's hard constraint plainly — a target needs only
the Claude CLI, `git`, `curl` and POSIX utilities, with **no target-side Node, `jq`, or `tar`**, and _"nothing
Node-based is shipped to or executed on a target"_. `prompt-lint` is Node. So there are exactly three ways to get
it into a target, and two are bad:

1. **Ship it as an asset bundle** and require Node in targets. Rejected: it breaks the installer's central
   promise, which is the reason the installer is adoptable at all.
2. **Reimplement the rules in POSIX shell** alongside `skills.sh`. Rejected for now: the cross-artifact rules
   (shingle clustering, drift, path-index resolution) in POSIX `sh` would be both slow and the least testable
   code in the repository — and `skills.sh` is already 1,140 lines carrying the installer's whole contract.
3. **A catalog skill whose procedure an agent executes directly** — an agent can check references resolve, check
   frontmatter completeness, and check config agreement by reading files, with no Node at all. This is the
   plausible route when someone wants it, and it composes with how every other skill in the catalog works.

Recorded so that a future reader reaches (3) without re-deriving (1) and (2). Nothing in this feature's design
blocks any of the three.

---

## Open questions deliberately left open

- **Density's exact formula** (`content/density`) is specified as "measured against a threshold" and implemented
  in Phase D. Its calibration needs the first whole-repo measurement to be meaningful, so fixing a formula now
  would be inventing a number. The rule ships with the threshold set from that first measurement, and the
  measurement is recorded in the pull request that adds it.
- **`content/self-contradiction`'s coverage** stays bounded to mechanically decidable cases (FR-026). The spec's
  checklist records why enumerating them fully would smuggle in the semantic judgement this feature excludes.
- **Whether the gate should eventually block on score** rather than severity counts. Left for after Phase D has
  produced enough history to know whether the score moves for reasons anyone cares about.
