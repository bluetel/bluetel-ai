# Phase 0 Research: Static prompt-quality validator

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-08-11

Every decision below was reached by measuring this repository rather than by reasoning about prompt linting in
the abstract. Where a measurement is quoted, the command that produced it is given so it can be re-run.

The Technical Context in [plan.md](./plan.md#technical-context) carries no `NEEDS CLARIFICATION` markers, because
the ten open questions this feature had were each resolvable by inspection. Those ten are R1–R10.

> **Revised 2026-08-11 after review feedback on [PR #28](https://github.com/bluetel/bluetel-ai/pull/28):**
> _"we were hoping to use this tool as a dependency dont re-write it"._ `contextops` is now a **pinned
> dependency**, not prior art. R5, R6 and R7 previously specified hand-written implementations of context
> measurement — token approximation, shingle clustering, a re-weighted score — and all three are deleted in
> favour of calling the tool. R8 gains the licence constraint that follows. R9 (how the dependency is acquired
> and invoked) and R10 (how this repository's files become a payload it can read) are new, and R10 is now the
> second decision, alongside [R2](#r2), that the feature's credibility rests on.

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

## R5. How are token counts obtained?

**Decision**: From `contextops`. Its report carries a `token_breakdown` computed with `tiktoken` under a named
encoding (`--model`, default `gpt-4o`), and `prompt-lint` reads that number rather than producing one. There is
no `artifact/size.ts`, no character-count approximation, and no tokenizer dependency in this workspace.

**Rationale**: the earlier revision of this decision hand-wrote `approxTokens = max(ceil(chars/4), ceil(words*1.3))`
to avoid taking `tiktoken` as a dependency. That reasoning does not survive taking `contextops` as a dependency:
`tiktoken` is already one of its two runtime requirements, so the exact count is now free and the approximation
would be a deliberately worse number sitting next to a better one. Budgets stop needing a 25% headroom rule,
because the error the headroom protected against no longer exists.

**The one caveat, recorded because it is the only thing here that touches a network**: `tiktoken` fetches its BPE
vocabulary on first use and caches it. On a machine that has never run it, the first invocation reaches
`openaipublic.blob.core.windows.net`. This does not violate FR-046 — `prompt-lint` makes no network call, no
inference call, and no call whose result varies — but it does mean a first run on a cold machine needs
connectivity, and an air-gapped one needs the cache pre-seeded. Mitigations, both cheap:

- Set `TIKTOKEN_CACHE_DIR` to a fixed path and cache it in CI, keyed on the pinned `contextops` version. The
  vocabulary for one encoding is a few megabytes and never changes for a given encoding name.
- The exit-6 path of [R9](#r9) covers the failure explicitly, so a cold offline machine gets "the tokenizer
  vocabulary is not cached and cannot be fetched" rather than a Python traceback.

**Alternatives considered**:

- _Keep the hand-written approximation and use `contextops` only for the score._ Rejected: two token counts that
  disagree, one of them in the report and the other in the budget rule, is a defect generator. One source.
- _Pin the encoding to a Claude tokenizer._ Not available — `tiktoken` ships OpenAI encodings. The count is
  therefore a consistent proxy rather than the exact cost of a Claude call, which the report states plainly by
  naming the encoding it used. Budget thresholds are calibrated against that proxy, so the comparison is
  self-consistent even though the absolute number is not Anthropic's.

---

<a id="r6"></a>

## R6. How is cross-artifact redundancy detected deterministically?

**Decision**: By `contextops`. Its `redundancy` dimension measures lexical duplication across the items of a
context payload and returns `redundancy_findings`; `prompt-lint` maps each into a `contextops/redundancy`
finding and reports it like any other. No shingle implementation is written here.

**Rationale**: this is the clearest case of the review's instruction. The previous revision specified an
8-line shingle window, hashing, overlap merging into maximal blocks, and a calibration exercise — perhaps 150
lines of code and a suite, re-deriving what the dependency was chosen for. `contextops` states determinism as a
guarantee (_"the same input always produces the same score… on any machine, at any time. No randomness"_) and
ships a `stability` command that verifies it, which is a stronger assurance than our own tests could give about
our own code. FR-022's "reported once, naming every location" is satisfied by the shape of
`redundancy_findings`, which is per duplicated span rather than per file.

**What survives from the old decision is the calibration, and it is now more important, not less** — it just
moves from a rule's parameters to the construction of the payload in [R10](#r10). Two shapes in this repo are
duplicated **by design**:

1. The 17 `.claude/skills/*/SKILL.md` pointers, each a frontmatter block plus one sentence naming the shared file.
   That is the installer's intended shape, not a defect (spec edge case). Pointers therefore enter a payload only
   as the `tools` section — the skill-selection surface, where near-identical framing is correct — and never as
   `chunks`, which is where redundancy is measured.
2. `.agents/skills/<name>/**` is a **byte-identical copy** of `catalog/<name>/**` — that is what installation
   _is_, and `install/catalog-drift` fires when it stops being true. A payload therefore contains one
   representative per skill (the catalog copy); the installed tree is never in the same payload as its source.

Without both exclusions `contextops` would correctly report that this repository's context is massively
redundant, and it would be describing the installer's design rather than a defect — which is how a check gets
disabled wholesale, the outcome SC-011 forbids. **A dependency does not remove the obligation to feed it the
right input; it concentrates that obligation in one place** ([R10](#r10)).

**Alternatives considered**:

- _Write the shingle clustering anyway, because it is only 150 lines._ Rejected on the review's instruction, and
  it was the right instruction: the 150 lines are the easy part, and the calibration, the determinism proof and
  the maintenance are not.
- _`qlty smells`' duplication detection._ Rejected: it is tuned for code structure and does not run over
  markdown; and the repo already learned from `qlty-diff` that a duplication percentage over prose needs a
  different denominator than lines-of-code.

---

<a id="r7"></a>

## R7. Where does the score come from, and do we re-weight it?

**Decision**: The 0–100 score is **`contextops`' score, reported verbatim**, with its four dimensions and their
published maxima — Redundancy 30, Density 30, Structure 20, Concentration 20. `prompt-lint` does not re-weight
it, does not drop a dimension, and does not fold its own findings into it. Correctness is reported **beside** the
score as its own number and its own finding list, never blended in.

**Rationale**: the previous revision reasoned that _concentration_ "has no referent" for hand-authored
instruction documents, and re-cut the weights around a correctness dimension of our own. Both parts were wrong,
and the second was worse than the first.

- **Concentration has a referent — a better one than we had.** Once a payload is an agent's actual context bundle
  ([R10](#r10)) rather than a flat list of files, concentration measures exactly the thing that goes wrong with a
  skill: one 900-line `references/` file dominating the bundle, so the procedure the agent is meant to follow
  is a rounding error in what it was handed. That failure is real here, and we would not have measured it.
- **Re-weighting someone else's score destroys the only property it has that ours would not: an external
  referent.** A `contextops` score of 74 is comparable with every other repository and every other run of that
  tool. A score of 74 under weights we invented is comparable with nothing, while _looking_ like the first. If
  the number is worth having, it is worth having unmodified.
- **Blending correctness in would be a category error.** A dangling reference is not 6 points of anything; it is
  a broken instruction. Findings gate, scores inform. Keeping them separate is what lets the score stay a metric
  and the correctness rules stay a control.

So the report shows two things: `context 74/100 (redundancy 22/30, density 19/30, structure 18/20,
concentration 15/20)` from `contextops`, and `correctness: 1 error, 3 warnings` from our rules. The gate decides
on severity counts, plus optionally `minScore` against the `contextops` number — the same decision `contextops
check --min-score` would make, taken in our process so there is one exit-code contract ([R9](#r9)).

**Alternatives considered**:

- _Re-weight to put correctness first, as previously specified._ Rejected as above. It was the design's weakest
  decision and the review's instruction removes it.
- _Use `contextops check --min-score` directly as the gate._ Rejected: two tools each owning an exit code means
  a red CI step whose cause has to be inferred from which line failed. `prompt-lint` runs the `inspect` command,
  applies the threshold itself, and owns the single documented exit contract in
  [contracts/cli.md](./contracts/cli.md#exit-codes).
- _Derive a composite "prompt health" number over both halves._ Rejected: nobody could say what a 12-point drop
  meant, and the first argument about the composite would be an argument about weights instead of about a
  broken reference.

---

<a id="r8"></a>

## R8. How could a target project that installs skills adopt this?

**Decision**: Deferred, with the path recorded. This repository is the reference implementation (spec
Assumptions); FR-045 is satisfied by _not foreclosing_ target adoption, not by shipping it now.

**Rationale**: `tooling/skills/README.md` states the installer's hard constraint plainly — a target needs only
the Claude CLI, `git`, `curl` and POSIX utilities, with **no target-side Node, `jq`, or `tar`**, and _"nothing
Node-based is shipped to or executed on a target"_. `prompt-lint` is Node, and now Python as well. So there are
exactly three ways to get it into a target, and two are bad:

1. **Ship it as an asset bundle** and require Node in targets. Rejected: it breaks the installer's central
   promise, which is the reason the installer is adoptable at all. Taking `contextops` as a dependency makes this
   worse, not better — the bundle would then have to carry a Python runtime too.
2. **Reimplement the rules in POSIX shell** alongside `skills.sh`. Rejected for now: the cross-artifact rules
   (drift, path-index resolution) in POSIX `sh` would be both slow and the least testable code in the repository
   — and `skills.sh` is already 1,140 lines carrying the installer's whole contract. The context-economy half
   cannot be reimplemented in shell at all.
3. **A catalog skill whose procedure an agent executes directly** — an agent can check references resolve, check
   frontmatter completeness, and check config agreement by reading files, with no Node at all. This is the
   plausible route when someone wants it, and it composes with how every other skill in the catalog works.

**The licence adds a fourth reason to defer, and it is the one to read carefully.** `contextops` is under the
Sustainable Use License, whose grant is _"use or modify the software only for your own internal business
operations, personal use, or non-commercial purposes"_, whose limitation is _"you may not provide the software,
or any derivative work of the software, to third parties as a hosted or managed service, or as part of a
commercial product or service offering"_, and which permits redistribution _"only if you do so free of charge,
and only for non-commercial purposes"_, with the terms attached.

Read against how this repository is actually used:

| Use                                                         | Reading                                                                                                                                   |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Bluetel runs `prompt-lint` in this repo's CI and pre-commit | Internal business operations. Within the grant.                                                                                           |
| A skill installed into a **client** project invokes it      | Plausibly "part of a commercial product or service offering". **Do not do this without sign-off.**                                        |
| The catalog ships `contextops` as an asset bundle           | Redistribution. Permitted only free of charge, non-commercially, with the licence attached — which a client deliverable is generally not. |
| A target project installs `contextops` itself and runs it   | That project's own licence decision, taken by whoever owns it. This is the only route that keeps the question where it belongs.           |

`prompt-lint` therefore never installs, vendors or ships `contextops` anywhere; it invokes a `contextops` that
is already present, and says so when it is not ([R9](#r9)). Route (3) above stays the target-adoption path, and a
target that wants the context-economy half installs the dependency under its own terms.

**This is a legal judgement recorded by an agent from the licence text, and it is not legal advice.** It is
flagged in the spec's Assumptions as needing a human decision before anything touching a client repository is
built on it. The nothing-is-shipped stance is chosen so that the answer only ever has to be "yes" to unblock,
never "we already did".

---

<a id="r9"></a>

## R9. How is a Python dependency acquired, pinned and invoked from a pnpm/Nx workspace?

**Decision**: `contextops==0.3.3`, pinned exactly; never installed by `prompt-lint`; located at startup in a
documented order; asserted to be the pinned version before any artifact is read; and a missing or mismatched
binary is its own exit code (`6`), distinct from a gate failure.

Resolution order, first hit wins:

1. `PROMPT_LINT_CONTEXTOPS_BIN` — an explicit path. The escape hatch for a venv, a Nix store path, or a CI cache.
2. `contextops` on `PATH`.
3. `uvx contextops@0.3.3` if `uv` is on `PATH`, then `pipx run contextops==0.3.3` if `pipx` is. Both run a
   pinned version in an ephemeral, cached environment without touching the machine's Python.

If none resolve, exit `6` with the install line for each route and the reason it is not optional. If one resolves
but `contextops --version` disagrees with the pin, exit `6` naming both versions — a silently different scoring
engine would break SC-005's byte-identical property between a developer machine and CI, which is precisely the
class of failure that makes a gate untrustworthy.

**Rationale**: the workspace already has this exact shape and it works. `qlty` is a non-Node binary that
`qlty:diff` shells out to, that CI and `.husky/pre-commit` both require, and that the hook installs on demand
before running the gate. A second external tool follows a path the repository has already walked, and reviewers
already know how it behaves when absent.

Two deliberate differences from the `qlty` precedent:

- **`prompt-lint` does not install `contextops`.** The hook `curl | sh`s the qlty installer; this one only ever
  reports. Installing a Sustainable-Use-licensed package onto a machine on the user's behalf is a decision for
  the person who owns the machine, per [R8](#r8). The message tells them how; it does not act.
- **The version is asserted, not merely present.** `qlty` is a linter aggregator whose findings we compare against
  a threshold; `contextops` produces a number we report as a score, so drift in the engine is drift in the metric.
  Pinning without asserting would be a pin that does nothing.

Environment for the subprocess is fixed explicitly — `TIKTOKEN_CACHE_DIR` when configured, no inherited
`PYTHON*` interference, `cwd` set to the repo root — because an inherited environment is an input, and an
uncontrolled input breaks determinism (FR-029).

**Alternatives considered**:

- _Add it to a `requirements.txt` and have CI `pip install`._ Rejected as the only route, kept as one of several:
  it works in CI, but a developer machine with a system Python and no venv is where `pip install` does damage.
  `uvx` / `pipx run` are the routes that cost the user nothing.
- _Wrap it in a Docker image._ Rejected: it turns a sub-second local gate into a container pull, and the repo has
  no other containerised tooling to amortise that against.
- _Port it to TypeScript._ That is the thing the review explicitly asked us not to do.

---

<a id="r10"></a>

## R10. What is a "context payload" for this repository?

`contextops` analyses _a context payload assembled for one inference call_ — `{system, messages, chunks, memory,
tools}` — not a directory of files. Nothing in this repository is natively that shape. This mapping is therefore
the decision that determines whether every number the dependency returns is meaningful or noise, and it is the
place where the repository's knowledge lives now that the algorithms do not.

**Decision**: `prompt-lint` assembles one payload per **context bundle** — a set of artifacts an agent actually
loads together for one run — and runs `contextops inspect` once per bundle.

| Bundle              | `system`                                         | `chunks`                                        | `tools`                            | Models                                             |
| ------------------- | ------------------------------------------------ | ----------------------------------------------- | ---------------------------------- | -------------------------------------------------- |
| `guidance` (one)    | `AGENTS.md`, `CLAUDE.md`                         | `.claude/rules/*.md`, `.agents/*.md`            | the 17 `.claude/skills/*/SKILL.md` | What every agent run loads before it does anything |
| `skill:<name>` (17) | `AGENTS.md`, `CLAUDE.md` (the same fixed prefix) | `catalog/<name>/SKILL.md` + its `references/**` | that skill's pointer               | What an agent holds while executing one skill      |
| `speckit` (one)     | the constitution                                 | `.specify/templates/*.md`                       | —                                  | What a Spec Kit command assembles                  |

`memory` is left empty on every bundle, and the report says so rather than omitting the row. There is no
per-project memory store in this repository; a payload section filled with something that is not what it means
would produce a confidently wrong `memory-max-ratio`.

**Why bundles rather than one payload for the repo, or one per file:**

- **One payload for the whole repository** would tell you the repository is redundant — 17 skills that each
  restate the house style — while an agent never loads two skills at once. The finding would be true of a thing
  nobody experiences.
- **One payload per file** discards every relationship. `contextops`' four dimensions are all _cross-item_
  measures; a single-item payload makes concentration meaningless by construction and redundancy always zero.
- **Per bundle**, every dimension lands on something real: redundancy = "this skill repeats what `AGENTS.md`
  already told the agent"; concentration = "one reference file is 80% of what this skill costs"; structure =
  "the fixed guidance prefix outweighs the procedure it is supposed to introduce"; density = formatting overhead
  in what is actually sent. Each is a sentence a maintainer can act on.

**The fixed guidance prefix in every skill bundle is the load-bearing detail.** It is what makes
`skill:review`'s redundancy score mean "duplicates the house rules" rather than "duplicates nothing, since we
only handed you one file". It is also what makes the guidance documents' size everybody's problem rather than
nobody's, which is the honest model: `AGENTS.md` is paid for on every run of every skill.

**Determinism**: bundles are built from a sorted artifact list; each payload is serialised with sorted keys and
written to a temp file whose path never enters the report (FR-039); `contextops` guarantees the rest and ships
`stability` to prove it, which the suite runs as a contract test against the pinned version.

**Cost**: 19 bundles, one subprocess each, against a published budget of under 2s per ≤5,000 tokens. Diff-scoped
runs build only the bundles containing a changed artifact — the usual case is one. This is why SC-002's
whole-repository budget moves from 30s to 60s and its diff-scoped budget from 5s to 10s; the correctness half is
still milliseconds, and `--rules-only` skips the subprocesses entirely for anyone who wants the old speed while
investigating.

**Alternatives considered**:

- _Feed `contextops` the raw markdown as a plain string._ It accepts that, and it is what a first attempt would
  do. Rejected: a string has no sections, so structure and concentration collapse to a single item and two of the
  four dimensions stop measuring. The whole value of the dependency is in the payload shape.
- _One bundle per installed skill as well as per catalog skill._ Rejected: identical content, doubled runtime,
  and `install/catalog-drift` already owns the question of whether they differ.
- _Include `messages`._ Rejected: there is no conversation to model, and inventing one would fabricate input.

---

## Open questions deliberately left open

- **The `minScore` threshold's value.** The score is `contextops`' and its scale is not ours to predict; the
  number is set from the first whole-repository measurement and recorded in the pull request that sets it. It
  ships at 0 (inert) until then, per [plan.md](./plan.md#phasing-delivery-order-by-user-story).
- **The token-budget thresholds per bundle**, for the same reason and on the same schedule — measured against
  `token_breakdown` once, not guessed now.
- **Whether `contextops diff` becomes the report-comparison surface.** The spec deferred report-vs-report
  comparison as work not worth doing; as a dependency it is a command that already exists, so the question is
  now only whether to wire it, not whether to build it. Left for after the first delivery has produced two
  reports worth comparing. The same applies to `badge` and `telemetry`.
- **`content/self-contradiction`'s coverage** stays bounded to mechanically decidable cases (FR-026). The spec's
  checklist records why enumerating them fully would smuggle in the semantic judgement this feature excludes.
- **Whether the gate should eventually block on score** rather than severity counts. Left for after Phase D has
  produced enough history to know whether the score moves for reasons anyone cares about.
