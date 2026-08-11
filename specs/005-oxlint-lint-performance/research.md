# Phase 0 Research: oxlint Compatibility, and the TypeScript 7 Upgrade

**Feature**: `005-oxlint-lint-performance` | **Date**: 2026-08-11 | **Spec**: [spec.md](./spec.md)

This document answers the question the issue asks: _is the existing ESLint setup compatible with
oxlint, and if not, exactly where does it break?_ Every claim below is either a measurement taken on
this branch or a citation to oxlint's documentation as of 2026-08-11.

**§7 was added after review feedback asking to fold the TypeScript upgrade into this feature's scope
and to test whether it fixes the blocker §3.3 reported.** It does not fix that blocker — it shows there
was none, and that the upgrade's real relationship to this work is the reverse of what §3.3 assumed.
§3.3 and §4 are marked accordingly rather than deleted, so the reasoning that was corrected stays
visible. **Read §7 before §3.3 and §4.**

---

## 1. Baseline measurements

### Method

Run on a GitHub Actions `ubuntu` runner, Node v24.15.0, ESLint 9.34.0, 42 tracked lintable files
across 7 Nx projects. Commands, verbatim:

```bash
# Exactly what lint-staged runs today, on one file
/usr/bin/time -f "%e s  %M KB" node --max-old-space-size=8192 ./node_modules/.bin/eslint \
  --flag v10_config_lookup_from_file packages/env-validation-errors/src/index.ts

# Whole workspace, cache defeated
time pnpm lint:check --skip-nx-cache
time pnpm typecheck --skip-nx-cache

# Per-rule attribution for one project
cd packages/env-validation-errors && TIMING=15 node --max-old-space-size=8192 ../../node_modules/.bin/eslint .
```

### Results

| Measurement                            | Result                              |
| -------------------------------------- | ----------------------------------- |
| ESLint, 1 file, lint-staged invocation | **5.68 s**, **798 648 KB** peak RSS |
| `pnpm lint:check --skip-nx-cache`      | **30.69 s** wall (50.36 s user)     |
| `pnpm lint:check` (all cache hits)     | 4.84 s                              |
| `pnpm typecheck --skip-nx-cache`       | 7.30 s                              |

Per-rule time, `packages/env-validation-errors`, top rows:

| Rule                                      | Time         | Share      |
| ----------------------------------------- | ------------ | ---------- |
| `@cspell/spellchecker`                    | 1555.0 ms    | **61.7 %** |
| `react-compiler/react-compiler`           | 236.7 ms     | 9.4 %      |
| `@typescript-eslint/no-misused-promises`  | 232.5 ms     | 9.2 %      |
| `@typescript-eslint/no-unsafe-assignment` | 186.1 ms     | 7.4 %      |
| `@typescript-eslint/no-floating-promises` | 77.1 ms      | 3.1 %      |
| `import-x/no-duplicates`                  | 49.4 ms      | 2.0 %      |
| `@typescript-eslint/no-deprecated`        | 32.8 ms      | 1.3 %      |
| `@nx/enforce-module-boundaries`           | 22.8 ms      | 0.9 %      |
| all remaining rules                       | < 16 ms each | —          |

### What the numbers mean

Rule execution accounts for roughly **2.5 s** of the 5.68 s single-file run. The rest is process
startup, flat-config resolution, plugin loading, and TypeScript program construction. So there are
**two independent problems**, and they need two different fixes:

1. **~3.2 s of fixed overhead per invocation.** Only a fundamentally cheaper linter process fixes
   this. `lint-staged` pays it on every commit regardless of diff size, and it cannot be Nx-cached
   because it operates on the staged working tree.
2. **~2.5 s of rule work, 62 % of it a single rule.** `@cspell/spellchecker` costs 1555 ms. Spell
   checking is not a per-file-at-commit-time concern — it only has to be blocking somewhere. Getting
   this one rule off the per-file path is the cheapest, highest-yield change available, and it needs no
   new tooling. See §3.5 for why `pnpm audit:cspell` is _not_ the replacement.

### Incidental finding: a rule that is already not running

The single-file run emits:

```
warning No cached ProjectGraph is available. The rule will be skipped.
          @nx/enforce-module-boundaries
```

`@nx/enforce-module-boundaries` is **silently skipped in the `lint-staged` path today** because
`lint-staged` invokes `eslint` directly rather than through Nx, so no project graph is cached. It is
enforced only via `pnpm nx run … lint` and in CI. This is a pre-existing coverage gap in the hook,
not something this feature introduces — but it must be recorded in the inventory (FR-006) so the
migration is not blamed for it, and the design should close it rather than inherit it.

---

## 2. The rule set being migrated

Extracted from ESLint's own effective config rather than by reading the source, so nothing is missed:

```bash
node ./node_modules/.bin/eslint --print-config packages/env-validation-errors/src/index.ts
```

**129 rules are enabled** for a `.ts` file. By origin:

| Origin                   | Enabled rules | Notes                                                                |
| ------------------------ | ------------- | -------------------------------------------------------------------- |
| ESLint core              | 47            | `js.configs.recommended` + `arrow-body-style`, `no-useless-return`   |
| `@typescript-eslint`     | 71            | `recommended` + `strictTypeChecked`; **41 type-aware, 30 syntactic** |
| `@nx`                    | 1             | `enforce-module-boundaries`                                          |
| `unused-imports`         | 2             | `no-unused-imports`, `no-unused-vars`                                |
| `import-x`               | 2             | `order`, `no-duplicates`                                             |
| `prefer-arrow-functions` | 1             | `prefer-arrow-functions`                                             |
| `check-file`             | 2             | `filename-naming-convention`, `folder-naming-convention`             |
| `react-compiler`         | 1             | `react-compiler`                                                     |
| `@cspell`                | 1             | `spellchecker`                                                       |
| `@bluetel-ai`            | 1             | `enforce-safe-env` (local, `tooling/eslint-config-base/rules/`)      |

The type-aware/syntactic split was computed from each rule's own
`meta.docs.requiresTypeChecking` flag in the installed `@typescript-eslint/eslint-plugin`, not
guessed. **41 of 129 rules (32 %) require a TypeScript program.** §3.3 originally read that as the
constraint that forced a hybrid design; §7 shows it is not one.

---

## 3. oxlint capability findings

### 3.1 Built-in plugin coverage

oxlint ships native Rust implementations of the plugins that matter here
([built-in plugins](https://oxc.rs/docs/guide/usage/linter/plugins.html)):

- **Enabled by default**: `eslint` (core rules), `typescript` (typescript-eslint ports), `unicorn`,
  `oxc`.
- **Opt-in**: `react` (covers react, react-hooks, react-refresh and React Compiler rules),
  `react-perf`, `nextjs`, `import`, `jsdoc`, `jsx-a11y`, `node`, `promise`, `jest`, `vitest`, `vue`.

Spot-checked against this repo's non-recommended rules — both exist natively:

| Rule                                 | In oxlint? | Category | Fix           |
| ------------------------------------ | ---------- | -------- | ------------- |
| `typescript/consistent-type-imports` | Yes        | style    | Yes (partial) |
| `eslint/arrow-body-style`            | Yes        | style    | Yes           |

### 3.2 JS plugins — the ESLint-compatible escape hatch

JS plugin support reached alpha in March 2026 and is the mechanism the issue proposes using.
([announcement](https://oxc.rs/blog/2026-03-11-oxlint-js-plugins-alpha), [docs](https://oxc.rs/docs/guide/usage/linter/js-plugins.html))

- The plugin API is **compatible with ESLint v9+**; the project states an expectation that "80 % of
  ESLint users can now switch to Oxlint and have it just work", and that the implementation is tested
  against ESLint's own full test suite.
- Supported: AST traversal, rule options and selectors, `SourceCode`/token APIs, scope and
  control-flow analysis, fixes and suggestions, inline disable directives, LSP diagnostics and
  quick-fixes.
- Configured via `jsPlugins` in `.oxlintrc.json`, accepting local paths, npm packages, or an
  `{ name, specifier }` alias to avoid colliding with a native plugin prefix:

  ```json
  {
    "jsPlugins": ["./path/to/my-plugin.js", "eslint-plugin-whatever"],
    "rules": {
      "my-plugin/rule1": "error",
      "whatever/rule1": "error"
    }
  }
  ```

- **Not supported**: custom parsers / non-JS file formats (Svelte, Vue, Angular templates), and
  **type-aware rules**.

Neither unsupported case blocks us: this workspace has no Svelte/Vue/Angular files, and type-aware
rules are handled per §4.

### 3.3 Type-aware mode — ~~the one hard blocker~~ **SUPERSEDED, see §7**

> **This subsection's conclusion was wrong and is retained only for the audit trail.** It reasoned
> from oxlint's documented "TypeScript 7.0+ is required" line without testing it. §7 records the
> experiments: `oxlint-tsgolint` embeds its own typechecker and runs correctly on this workspace at
> TypeScript 5.9.2 — and with no `typescript` package installed at all. There is no blocker. Read §7
> for the corrected finding and the design it implies; the rest of this subsection is the original
> text.

oxlint has a type-aware mode backed by `tsgolint`, covering **59 of 61** typescript-eslint type-aware
rules, enabled by `--type-aware` or `options.typeAware: true`
([docs](https://oxc.rs/docs/guide/usage/linter/type-aware.html)). Its requirements, quoted:

- `npm add -D oxlint-tsgolint@latest`
- **"TypeScript 7.0+ is required"**
- monorepos must "build dependent packages so `.d.ts` files are available"
- known limits: "rule coverage is incomplete (but very close)", high memory on very large codebases,
  and some legacy `tsconfig` options unsupported (e.g. `baseUrl`).

**This workspace is on TypeScript `~5.9.2`** (`packages/env-validation-errors/package.json`;
`node -e "require('typescript/package.json').version"` → `5.9.2`).

> ~~**Conclusion: oxlint cannot own the 41 type-aware rules today.**~~ **Retracted — see §7.2.** The
> quoted requirement is a documentation statement about which TypeScript _semantics_ tsgolint
> implements, not a runtime dependency on the installed `typescript` package. Measured behaviour
> contradicts the inference drawn here.

### 3.4 Rules with no native oxlint equivalent

| Current rule                                    | Native oxlint equivalent                                                                                                                                          | Resolution                                             |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `import-x/no-duplicates`                        | `import/no-duplicates` (correctness, fixable)                                                                                                                     | Native                                                 |
| `import-x/order`                                | **None.** Confirmed absent from the rules list; the nearest built-in is `eslint/sort-imports`, which is not equivalent (no group ordering, no `newlines-between`) | JS plugin (`eslint-plugin-import-x`)                   |
| `check-file/filename-naming-convention`         | `unicorn/filename-case` (style) is close but does not express the `ignoreMiddleExtensions` behaviour this repo relies on for `*.test.ts`                          | JS plugin (`eslint-plugin-check-file`)                 |
| `check-file/folder-naming-convention`           | None                                                                                                                                                              | JS plugin (`eslint-plugin-check-file`)                 |
| `prefer-arrow-functions/prefer-arrow-functions` | None                                                                                                                                                              | JS plugin                                              |
| `unused-imports/no-unused-imports`              | `no-unused-vars` with import-aware fixing (`fix.imports`)                                                                                                         | Native — verify fix parity, see gap G3                 |
| `react-compiler/react-compiler`                 | Included in the `react` plugin, but **experimental, lint-only, opt-in**                                                                                           | Native if parity holds, else JS plugin                 |
| `@nx/enforce-module-boundaries`                 | None, and it needs the Nx project graph                                                                                                                           | Not a per-file rule — keep in the ESLint/Nx layer (§4) |
| `@cspell/spellchecker`                          | None                                                                                                                                                              | Relocate off the per-file path — see §3.5              |
| `@bluetel-ai/enforce-safe-env`                  | N/A — local rule                                                                                                                                                  | Port to an oxlint JS plugin                            |

`@bluetel-ai/enforce-safe-env` (`tooling/eslint-config-base/rules/enforce-safe-env.mjs`, 48 lines) is
a pure AST rule: one `ImportDeclaration` visitor, `context.report`, `messageId`s, and a `suggest` fix
using `fixer.replaceText`/`replaceTextRange`. Every API it touches is on oxlint's supported list, and
it needs **no** type information. It should port essentially unchanged — this is the "js api for
plugins" path the issue names.

### 3.5 Spell checking — correcting an obvious-looking assumption

It is tempting to say "we already have `pnpm audit:cspell`, so just delete the ESLint rule". **That is
wrong, and the script's own header says so.** `scripts/audit-cspell.mjs` audits `cspell.json`'s `words`
array for entries that are unused or duplicated:

> "Audits cspell.json's `words` list and reports entries that appear to be unused … This script only
> REPORTS candidates - it does not modify cspell.json."

It runs in **0.62 s** and never spell-checks a single source file. It is dictionary hygiene, not a
spellchecker. Deleting `@cspell/spellchecker` in reliance on it would drop spell-check coverage
outright — precisely the FR-005 violation this feature must not commit.

Also relevant: the `cspell` **CLI is not installed** in this workspace. Only `@cspell/eslint-plugin` is
a dependency; `node_modules/.bin` contains no `cspell` binary. So there are two real options:

| Option                           | Change                                                                                                                           | Cost                                                                                | Risk                                                                                                          |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **A (default)**                  | Keep `@cspell/spellchecker` as an ESLint rule, but move it into the Nx-cached, `affected`-scoped layer so it never runs per-file | Zero new dependencies. Removes 1555 ms from the staged path immediately             | Lowest. Coverage provably identical — same rule, same config, different cadence                               |
| **B (follow-up, measure first)** | Add the `cspell` CLI as a devDependency and run it as its own Nx target                                                          | One new dependency, subject to `minimumReleaseAge: 1 week`; needs its own benchmark | Config drift between `cspell.json` and the plugin's resolution; must prove diagnostics match before switching |

**Option A is the plan.** Option B is only worth taking if A leaves the cold full-lint number short of
SC-003, and it must be justified by a measurement, not by preference.

### 3.6 Migration and de-duplication tooling

- [`@oxlint/migrate`](https://www.npmjs.com/package/@oxlint/migrate) (latest 1.67.0) generates
  `.oxlintrc.json` from an ESLint **flat** config and converts `eslint-disable` comments to
  `oxlint-disable`: `npx @oxlint/migrate <config-path>`, with `--type-aware` for the type-aware
  layer. This repo already uses flat config (`eslint.config.mjs`), so it is directly applicable.
  Caveat from the docs: local custom plugins require manual configuration afterwards.
- [`eslint-plugin-oxlint`](https://www.npmjs.com/package/eslint-plugin-oxlint) turns **off** the
  ESLint rules oxlint now owns. This is the mechanism that satisfies FR-014 / SC-008 (no duplicate
  diagnostics) without hand-maintaining a disable list.
- oxlint's own guidance for a hybrid setup: _"it is recommended to run Oxlint first to catch errors
  early, then fall back to ESLint only if needed"_ — i.e. `oxlint && eslint`
  ([migration guide](https://oxc.rs/docs/guide/usage/linter/migrate-from-eslint.md)).

---

## 4. Decision: oxlint owns all 127 per-file rules; ESLint keeps only what needs Nx

**Decision** (revised after §7 — the original two-layer split is recorded in §7.6 as a rejected
alternative). Three layers, and the split is no longer "does the rule need types" but **"can the rule
run without the Nx project graph"**.

| Layer                | Tool                                      | Rules                                                                                                                                                                                                    | Where it runs                                                                 |
| -------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Fast / syntactic** | oxlint (native rules + JS plugins)        | **86** of 129 — ESLint core (47), syntactic TS (30), import order + no-duplicates (2), unused imports (2), file/folder naming (2), arrow functions (1), react-compiler (1), local `enforce-safe-env` (1) | `lint-staged` on staged files, plus an Nx target and a standalone command     |
| **Type-aware**       | oxlint `--type-aware` (`oxlint-tsgolint`) | **41** — every `requiresTypeChecking` rule; all 41 are implemented by tsgolint (§7.3)                                                                                                                    | The same invocations as the syntactic layer — measured at 0.21 s for one file |
| **Workspace-scoped** | ESLint                                    | **2** — `@nx/enforce-module-boundaries` (needs the Nx project graph) and `@cspell/spellchecker` (no oxlint equivalent, 1555 ms, §3.5)                                                                    | Nx target only — `nx affected`, cached; **never per-file**                    |

Alongside it, a **TypeScript 7.0.2 upgrade** (§7.4): 5.09 s → 0.87 s across the four typechecked
projects, and it aligns the compiler's semantics with the TS 7 semantics tsgolint's embedded checker
already applies to this code.

**Rationale.**

- oxlint absorbs both measured lint costs, including the type-aware one. The per-invocation overhead
  disappears (single Rust binary, no Node boot, no plugin graph, no TS program), and type-aware
  analysis costs 0.17 s on top of a 0.04 s syntactic pass rather than the ~3.2 s ESLint spends before
  it checks anything.
- **ESLint stops being on the hot path at all**, which is what makes the residual layer's cost
  irrelevant: 2 rules, Nx-cached, `affected`-scoped, never per-file.
- It does not depend on the TypeScript upgrade — measured working on 5.9.2 — but it is what makes the
  upgrade possible, because after the migration nothing in the lint path needs the TypeScript JS API,
  which TS 7 no longer ships (§7.2).
- Rule coverage is provable rather than hoped for: all 41 type-aware rules appear as implemented in
  tsgolint's own list, and oxlint **hard-fails on an unknown rule name** (§7.3), so a config that
  parses is a config in which every rule it names is live.
- It still matches the tool authors' recommended ordering (fast checks first), and the residual ESLint
  layer is small enough that `eslint-plugin-oxlint` de-duplication becomes a two-rule concern rather
  than a 127-rule one.

**Alternatives rejected.**

| Alternative                                                                      | Rejected because                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hybrid: ESLint keeps the 41 type-aware rules as an Nx-only layer                 | The original decision, now superseded. It was chosen only because §3.3 believed oxlint could not do type-aware work here. It costs a second linter, a second config language, and `eslint-plugin-oxlint` de-duplication across 127 rules — and it **blocks the TypeScript upgrade indefinitely** (§7.2, §7.6). |
| Upgrade TypeScript to 7 **first**, keeping ESLint for the type-aware layer       | Not merely risky — impossible. `typescript@7` ships no JS compiler API, and typescript-eslint's TS 7 support issue is closed as _not planned_ (§7.2). Doing this first would take 41 rules out of enforcement, the exact FR-005 breach this feature exists to prevent.                                         |
| Upgrade TypeScript to 7 and pin a second TypeScript 6.0 copy for ESLint          | Technically available, and Microsoft's own suggested stopgap — but it means two TypeScript versions resolving in a `nodeLinker: hoisted` workspace where `@nx/eslint` already pins `typescript ~5.9.2` as a hard dependency. Real complexity, to preserve a layer the chosen decision deletes.                 |
| Keep ESLint, just drop `@cspell` from the per-file path                          | Genuinely cheap and worth ~62 % of rule time — but leaves ~3.2 s of fixed per-invocation overhead untouched, so it cannot reach SC-001 (< 1 s). **Kept as the first phase anyway**, since it is independently valuable and de-risks the rest.                                                                  |
| Keep ESLint, add caching (`--cache`) to `lint-staged`                            | ESLint's cache keys on file content; a staged file has just changed by definition, so every commit is a cache miss on exactly the files being linted. Does not address startup cost either.                                                                                                                    |
| Two independent linters, both in `lint-staged`                                   | Reintroduces the per-file TS program cost, the thing being removed. Also maximises duplicate-diagnostic and fix-fighting risk (FR-014, FR-017).                                                                                                                                                                |
| Run type-aware lint only in CI                                                   | Fails FR-011 (hook and CI must enforce the same set): a contributor could commit clean and be red in CI, which is the friction this feature exists to remove, relocated rather than fixed.                                                                                                                     |
| Skip the TypeScript upgrade; run tsgolint's TS 7 checker against a 5.9 workspace | Works, and is the documented fallback if the upgrade stalls — but it leaves linter and compiler disagreeing about types by construction (§7.5), which is a standing source of "lint says X, `tsc` says Y".                                                                                                     |

## 5. Open questions to resolve with a spike, before writing config

These are unknowns that documentation cannot settle and that would change the task list if they came
out badly. Each has a cheap, concrete resolution step (see `tasks.md`, Phase 3). **G10–G14 were added
when the TypeScript scope was folded in; G11 and G12 are already answered in §7 and are listed here so
the gap register stays complete.**

| #   | Question                                                                                                                                                                                                                                                                                                                                        | How to resolve                                                                                                                                                                                              | If the answer is bad                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Which of the 47 ESLint-core + 30 syntactic TS rules does oxlint actually implement, one by one?                                                                                                                                                                                                                                                 | `oxlint --rules` and diff against the 129-rule inventory. Note `--rules` printed nothing on 1.78.0 in this environment, so use the docs' rule index as the cross-check                                      | Any unimplemented rule stays in the ESLint layer; record in the inventory                                                                             |
| G2  | Do `eslint-plugin-import-x`, `eslint-plugin-check-file` and `eslint-plugin-prefer-arrow-functions` load and run correctly under `jsPlugins`?                                                                                                                                                                                                    | Enable each, run against the repo, compare diagnostics to ESLint's                                                                                                                                          | That plugin's rules stay in the ESLint layer — degrades speed, never coverage                                                                         |
| G3  | Does oxlint's `no-unused-vars` **auto-fix** remove unused imports the way `unused-imports/no-unused-imports` does? (`fixKind` may need to be `dangerous-fix`)                                                                                                                                                                                   | Plant an unused import, run `oxlint --fix`, inspect                                                                                                                                                         | Keep the ESLint rule for the fix, or accept report-only and fix by hand                                                                               |
| G4  | Is oxlint's React Compiler rule at parity with `eslint-plugin-react-compiler` 19.1.0-rc.2?                                                                                                                                                                                                                                                      | Compare on a file with a known violation                                                                                                                                                                    | Run the ESLint plugin as an oxlint JS plugin, or keep it in the ESLint layer                                                                          |
| G5  | What does a JS plugin actually cost? Does adding 4 of them keep the staged pass under 1 s?                                                                                                                                                                                                                                                      | Measure the staged pass with 0, then all JS plugins enabled                                                                                                                                                 | Move the most expensive plugin's rules to the ESLint layer                                                                                            |
| G6  | How much of the 30.7 s cold full lint remains once ESLint owns only 2 rules?                                                                                                                                                                                                                                                                    | `time` the new ESLint-residual target with `--skip-nx-cache`                                                                                                                                                | If SC-003 is missed, scope the ESLint layer with `nx affected` in the hook and re-measure                                                             |
| G7  | Does `@nx/enforce-module-boundaries` work correctly once ESLint runs only under Nx?                                                                                                                                                                                                                                                             | Plant a boundary violation, run `pnpm nx run <p>:lint-workspace`                                                                                                                                            | It already only works under Nx — Nx-only execution should _improve_ on today's silent skip                                                            |
| G8  | Do the two existing inline suppressions survive? `packages/env-validation-errors/src/index.ts:3` disables `@bluetel-ai/enforce-safe-env` (moving to oxlint → needs `oxlint-disable-next-line`); `src/index.test.ts:253` disables `@typescript-eslint/no-unnecessary-type-assertion` (**now also moving to oxlint**, so it needs converting too) | Run both layers and confirm zero errors                                                                                                                                                                     | Convert the comments with `@oxlint/migrate`, which handles this rewrite                                                                               |
| G9  | Does Nx invalidate the `lint` cache when `.oxlintrc.json` changes?                                                                                                                                                                                                                                                                              | Change a severity, re-run, confirm a cache miss                                                                                                                                                             | Add the oxlint config files to `namedInputs.sharedGlobals` in `nx.json`                                                                               |
| G10 | Do the 5 `.ts` divergences in §7.5 come from a genuine oxlint/typescript-eslint semantic difference, or from TS 7 type semantics?                                                                                                                                                                                                               | Re-run type-aware oxlint before and after the TS 7 bump and diff. Read each of the 5 sites                                                                                                                  | If they are real oxlint false positives, report upstream and keep that one rule with ESLint until fixed. If they are genuine, remove the 5 assertions |
| G11 | Does oxlint type-aware really work at TypeScript 5.9.2, contradicting the docs?                                                                                                                                                                                                                                                                 | **Answered — yes.** §7.2, including with no `typescript` package installed                                                                                                                                  | —                                                                                                                                                     |
| G12 | Can typescript-eslint run under TypeScript 7 at all?                                                                                                                                                                                                                                                                                            | **Answered — no.** §7.2: no JS compiler API, and upstream support is closed as not planned                                                                                                                  | —                                                                                                                                                     |
| G13 | Do Nx 22.6.1, `knip`, `vitest` and the `@nx/js/typescript` inference plugin all still work with `tsc` at 7.0.2? `@nx/eslint` hard-depends on `typescript ~5.9.2`, so two copies will resolve in a hoisted store                                                                                                                                 | Bump the pins on a scratch branch and run `pnpm nx run-many -t typecheck test build`, `pnpm knip`, `pnpm nx show projects`                                                                                  | If Nx's inference breaks, stay on TS 6.0.3 (still inside typescript-eslint's peer range) and revisit after Nx ships TS 7 support                      |
| G14 | Is `"types": ["node"]` the right fix for the TS 7 `@types/node` regression, or does it hide types some project needs implicitly (e.g. Vitest globals)?                                                                                                                                                                                          | All 4 projects pass with it under both 5.9.2 and 7.0.2 (§7.4). Before landing, check each project's `types` needs individually and prefer per-project `types` over a single base-level entry if they differ | Use `typeRoots`, or set `types` per project rather than in `tsconfig.base.json`                                                                       |

---

## 6. Sources

- [Oxlint JS Plugins Alpha (2026-03-11)](https://oxc.rs/blog/2026-03-11-oxlint-js-plugins-alpha)
- [JS Plugins — Oxlint docs](https://oxc.rs/docs/guide/usage/linter/js-plugins.html)
- [Built-in Plugins — Oxlint docs](https://oxc.rs/docs/guide/usage/linter/plugins.html)
- [Type-Aware Linting — Oxlint docs](https://oxc.rs/docs/guide/usage/linter/type-aware.html)
- [Migrate from ESLint — Oxlint docs](https://oxc.rs/docs/guide/usage/linter/migrate-from-eslint.md)
- [Config file reference — Oxlint docs](https://oxc.rs/docs/guide/usage/linter/config-file-reference)
- [`@oxlint/migrate` on npm](https://www.npmjs.com/package/@oxlint/migrate)
- [`eslint-plugin-oxlint` on npm](https://www.npmjs.com/package/eslint-plugin-oxlint)
- [oxc rules meta-issue #481](https://github.com/oxc-project/oxc/issues/481)
- [`oxlint-tsgolint` implemented rules](https://github.com/oxc-project/tsgolint#implemented-rules)
- [Announcing TypeScript 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
- [typescript-eslint #12518 — TypeScript 7.0.2 Support (closed as not planned)](https://github.com/typescript-eslint/typescript-eslint/issues/12518)
- [typescript-eslint #12521 — friendlier message when TS 7 is detected](https://github.com/typescript-eslint/typescript-eslint/issues/12521)
- [eslint/eslint #21070 — Change Request: Update to TypeScript 7](https://github.com/eslint/eslint/issues/21070)

---

## 7. TypeScript upgrade: correction, expansion, and measurements

**Added 2026-08-11**, after review feedback asking to expand the feature's scope to include the
TypeScript upgrade and to check whether it fixes the problems §3.3 described.

It does more than that: it shows §3.3 had the dependency backwards. The TypeScript upgrade is not what
_unlocks_ oxlint's type-aware mode (that already works), and the ESLint type-aware layer §4 originally
proposed is not a stepping stone toward TS 7 — it is the one thing that would make TS 7 unreachable.

### 7.1 Method

Same runner and workspace as §1: GitHub Actions `ubuntu`, Node v24.15.0, working tree at
`claude/issue-24-20260811-1039`. All tools were installed into `/tmp` scratch projects so the
workspace's own `node_modules` and lockfile were never modified; `oxlint-tsgolint` was copied into
`node_modules/` only for the duration of the runs and removed afterwards.

```bash
# scratch install, outside the workspace
cd /tmp/ts7 && npm i typescript@7.0.2 oxlint@1.78.0 oxlint-tsgolint@7.0.2001

# the 41 type-aware rules, written to a config from the live effective ESLint config
node ./node_modules/.bin/eslint --print-config packages/env-validation-errors/src/index.ts
#   → filter to enabled rules → split on each rule's own meta.docs.requiresTypeChecking

/usr/bin/time -f "%e s %M KB" /tmp/ts7/node_modules/.bin/oxlint \
  -c /tmp/oxlintrc-ta.json --type-aware packages/env-validation-errors/src/index.ts

for p in packages/env-validation-errors tooling/commit-conventions tooling/qlty-diff tooling/skills; do
  (cd $p && /usr/bin/time -f "%e s %M KB" ../../node_modules/.bin/tsc --noEmit         # 5.9.2
         && /usr/bin/time -f "%e s %M KB" /tmp/ts7/node_modules/.bin/tsc --noEmit)     # 7.0.2
done
```

The 129 / 41 / 30 rule counts in §2 were re-derived from scratch by this run and came out identical.

### 7.2 TypeScript 7 is real, and it removes the JS compiler API

`typescript@7.0.2` is the `latest` npm dist-tag, published **2026-07-08**; `7.0.1-rc` preceded it on
2026-06-18 and `6.0.3` on 2026-04-16. It is the Go port: `bin` exposes only `tsc` (6.0.3 also shipped
`tsserver`), and the implementation arrives through 20 platform-specific optional dependencies.

The consequence that matters here is in its `exports` map:

```json
{ ".": "./lib/version.cjs", "./unstable/sync": "./dist/api/sync/api.js", "./unstable/ast": "..." }
```

Measured, not inferred:

| Probe                                             | Result                                                            |
| ------------------------------------------------- | ----------------------------------------------------------------- |
| `require('typescript')`                           | `{ version: '7.0.2', versionMajorMinor: '7.0' }` — nothing else   |
| `import * as ts from 'typescript'`                | `['default', 'module.exports', 'version', 'versionMajorMinor']`   |
| `typeof ts.createProgram`, `typeof ts.SyntaxKind` | `undefined`, `undefined`                                          |
| `import * as api from 'typescript/unstable/sync'` | 40+ exports — `API`, `Checker`, `Program`, `Project`, `Symbol`, … |

So the programmatic compiler API has moved to a new, explicitly **`unstable/`**-namespaced, ESM-only
surface. Any tool that does `ts.createProgram(...)` — which is every type-aware ESLint rule — cannot
run under TypeScript 7.

Upstream confirms this is not a short wait:

- typescript-eslint's peer range is still `typescript: >=4.8.4 <6.1.0`, on `8.67.0` and on every
  `8.67.1-alpha.*`. TypeScript 7 sits entirely outside it.
- [typescript-eslint#12518](https://github.com/typescript-eslint/typescript-eslint/issues/12518),
  filed on TS 7 GA day, is **closed as not planned**. The reporter records both an install-time peer
  conflict and a runtime crash inside `@typescript-eslint/typescript-estree`.
- The stated blocker is that the API type-aware tooling needs is not expected before **TypeScript 7.1**,
  with "run TypeScript 6.0 side by side" as the interim workaround for tools that need it.

There is also a local wrinkle worth recording: `@nx/eslint` declares **`typescript: ~5.9.2` as a hard
dependency**, so 5.9.2 is in this tree whether or not any package asks for it. Under
`nodeLinker: hoisted`, a TS 7 upgrade means two TypeScript copies resolving, and which one `tsc`
resolves to depends on hoisting. That is gap **G13**.

### 7.3 oxlint's type-aware mode works today, at TypeScript 5.9.2

The `--type-aware` docs still say **"TypeScript 7.0+ is required"**. Tested rather than trusted:

| Experiment                                                                            | Result                                                                                                                               |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `oxlint --type-aware` in this workspace (TypeScript 5.9.2 installed)                  | Rules fire correctly                                                                                                                 |
| Same, in a `/tmp` project with **no `typescript` package installed at all**           | **Rules still fire correctly**                                                                                                       |
| Config naming a rule tsgolint does not implement                                      | `Failed to parse oxlint configuration file. × Rule 'no-such-rule-xyz' not found in plugin 'typescript'`                              |
| The 41 `requiresTypeChecking` rules vs `oxlint-tsgolint`'s own implemented-rules list | **41 / 41 implemented.** The 2 of 61 it lacks are `naming-convention` and `prefer-destructuring`, neither of which this repo enables |

`oxlint-tsgolint@7.0.2001` embeds a typechecker built from the TypeScript Go codebase; the version
string tracks TypeScript 7.0.2 (hence "TS 7.0+ required" — it describes the semantics it implements,
not a package it loads). It never reads the installed `typescript`.

The hard-fail on an unknown rule name is what makes the coverage claim checkable: if the config parses,
every rule it names is live. There is no silent-skip mode to be fooled by — unlike
`@nx/enforce-module-boundaries`, which is silently skipped in the current hook (§1).

Measured cost, three runs each, same file and method as the §1 baseline:

| Pass                                                             | Wall       | Peak RSS   | vs ESLint                              |
| ---------------------------------------------------------------- | ---------- | ---------- | -------------------------------------- |
| ESLint, 1 file, current `lint-staged` command                    | 5.68 s     | 798 648 KB | —                                      |
| oxlint, 1 file, syntactic only                                   | **0.04 s** | 61 800 KB  | **142× faster, 13× less memory**       |
| oxlint, 1 file, **+ all 41 type-aware rules**                    | **0.21 s** | 62 400 KB  | **27× faster, 13× less memory**        |
| oxlint, whole repo (`packages` + `tooling`), 41 type-aware rules | **0.70 s** | 172 000 KB | vs 30.7 s cold for the full ESLint run |

**This is the finding that changes the design.** Type-aware linting fits inside the pre-commit hook
with 5× headroom against the 1 s target (SC-001). The hybrid split in the original §4 existed only to
keep type-aware rules off the per-file path; there is no longer a reason to keep them off it.

### 7.4 TypeScript 7 typechecks this workspace clean, ~6× faster

Out of the box it does not: 16 errors, all `TS2591 Cannot find name 'process'`. TypeScript 7 does not
pick up `@types/node` from the hoisted root in this layout, whereas 5.9.2 does (confirmed with
`--listFiles`: 5.9.2 loads `node_modules/@types/node/**`, 7.0.2 does not).

Adding `"types": ["node"]` to `tsconfig.base.json` fixes it, and **5.9.2 still passes with that option
set** — so the tsconfig change is independently landable ahead of the version bump.

| Project                          | `tsc` 5.9.2         | `tsc` 7.0.2            | Speed-up |
| -------------------------------- | ------------------- | ---------------------- | -------- |
| `packages/env-validation-errors` | 1.51 s / 286 872 KB | **0.26 s / 94 752 KB** | 5.8×     |
| `tooling/commit-conventions`     | 1.28 s / 230 704 KB | **0.24 s / 74 016 KB** | 5.3×     |
| `tooling/qlty-diff`              | 1.09 s / 215 712 KB | **0.17 s / 61 920 KB** | 6.4×     |
| `tooling/skills`                 | 1.22 s / 226 744 KB | **0.20 s / 66 464 KB** | 6.1×     |
| **Total**                        | **5.09 s**          | **0.87 s**             | **5.9×** |

All four projects exit 0 under both versions. `pnpm typecheck` runs in the pre-commit hook on every
commit, so this is ~4 s off every commit on top of the lint win — the same order of magnitude as the
lint saving itself, from a change with no config surface of its own.

The measured 5–6× is below the 8–12× Microsoft quotes for full builds, which is expected: these are
tiny projects where process start-up is a large share of a 0.2 s run.

### 7.5 What oxlint type-aware actually reports on this repo

Running all 41 rules over `packages` + `tooling`:

| Configuration                    | Diagnostics | In `.ts` files |
| -------------------------------- | ----------- | -------------- |
| Before the `types: ["node"]` fix | 147         | 113            |
| After the `types: ["node"]` fix  | **39**      | **5**          |

The 108 that disappeared were downstream of the same missing `@types/node` — `process` resolved to an
`error` type, so every `process.env` access tripped `no-unsafe-member-access` and friends. One tsconfig
line, one root cause, two symptoms.

Of the 39 that remain:

- **34 are in `.mjs` files** (`tooling/eslint-config-base/rules/*.mjs`,
  `tooling/eslint-config-internal/index.mjs`) — files the current ESLint type-aware layer does not
  cover. This is a config-scoping difference, not new debt: the oxlint config must reproduce ESLint's
  file scoping, or those files must be brought up to standard deliberately as their own change.
- **5 are in one `.ts` file**, all `no-unnecessary-type-assertion` on
  `issues as readonly StandardSchemaV1.Issue[]` in
  `packages/env-validation-errors/src/index.test.ts` (lines 53, 85, 89, 129, 133), with the message
  "unnecessary since the receiver accepts the original type of the expression". ESLint reports nothing
  on that file today, so these are 5 genuine divergences. Five lines in one test file is well inside
  what US4 / FR-013 allows to be fixed in the migration commit rather than suppressed — but the cause
  must be established first (gap **G10**), because "the new linter is stricter" and "the new linter is
  wrong" are not the same finding.

Also worth noting for **G8**: `index.test.ts:253` suppresses
`@typescript-eslint/no-unnecessary-type-assertion`. Under this design that rule moves to oxlint, so
both existing inline suppressions need converting, not just the `enforce-safe-env` one.

### 7.6 Revised sequencing, and why the order is forced

The two workstreams are not independent, and only one order works:

| Order                                                      | Outcome                                                                                                                                                                                       |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **oxlint type-aware first, then TypeScript 7**             | Works. After the migration, nothing in the lint path needs the TypeScript JS API, so the upgrade is a version bump plus a tsconfig line. **Chosen.**                                          |
| TypeScript 7 first                                         | Breaks 41 rules the moment it lands, because typescript-eslint cannot load under TS 7 and oxlint has not yet taken over. Fixable only by pinning a second TypeScript copy for ESLint.         |
| Original plan: keep ESLint's type-aware layer indefinitely | Caps the workspace at TypeScript ≤ 6.0 for as long as that layer exists. The original §4 called the hybrid "a stepping stone, not a dead end" — with §7.2 in hand, that is exactly backwards. |

Neither workstream blocks the other's value: Phase 1 (cspell) and Phase 0 (the tsconfig fix) are still
independently landable, and the TypeScript bump can be deferred without weakening the lint design. What
cannot happen is TypeScript 7 arriving while ESLint still owns type-aware rules.
