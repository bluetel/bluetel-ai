# Phase 0 Research: oxlint Compatibility With This Workspace's ESLint Setup

**Feature**: `005-oxlint-lint-performance` | **Date**: 2026-08-11 | **Spec**: [spec.md](./spec.md)

This document answers the question the issue asks: _is the existing ESLint setup compatible with
oxlint, and if not, exactly where does it break?_ Every claim below is either a measurement taken on
this branch or a citation to oxlint's documentation as of 2026-08-11.

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
guessed. **41 of 129 rules (32 %) require a TypeScript program.** That single fact drives the whole
design, for the reason in §4.

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

### 3.3 Type-aware mode — the one hard blocker

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

> **Conclusion: oxlint cannot own the 41 type-aware rules today.** A TypeScript 7 upgrade is a
> separate, much larger feature and is explicitly out of scope in `spec.md`. This is the finding that
> forces a hybrid design rather than a clean replacement.

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

## 4. Decision: hybrid, split by whether a rule needs types

**Decision.** Two lint layers, with rules assigned by whether they need a TypeScript program.

| Layer                | Tool                               | Rules                                                                                                                                                                                                    | Where it runs                                                             |
| -------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Fast / syntactic** | oxlint (native rules + JS plugins) | **86** of 129 — ESLint core (47), syntactic TS (30), import order + no-duplicates (2), unused imports (2), file/folder naming (2), arrow functions (1), react-compiler (1), local `enforce-safe-env` (1) | `lint-staged` on staged files, plus an Nx target and a standalone command |
| **Type-aware**       | ESLint, `strictTypeChecked` only   | **42** — the 41 `requiresTypeChecking` rules, plus `@nx/enforce-module-boundaries` (needs the project graph, not a per-file rule)                                                                        | Nx target only — `nx affected`, cached; **never per-file**                |
| **Spelling**         | `@cspell/spellchecker`, unchanged  | **1** — same rule, same `cspell.json`                                                                                                                                                                    | Joins the type-aware ESLint layer (§3.5, option A); **never per-file**    |

**Rationale.**

- It attacks both measured costs at once. The per-invocation overhead disappears from the hook (oxlint
  is a single Rust binary; no Node boot, no plugin graph, no TS program), and the 62 %-of-rule-time
  cspell rule leaves the per-file path entirely.
- It is not blocked on TypeScript 7. The 41 type-aware rules keep running under ESLint at full
  strictness, so FR-005 and FR-008 hold with no rule relaxed. When the workspace does reach
  TypeScript 7, the same split collapses into oxlint `--type-aware` with no change to the rule set —
  the design is a stepping stone, not a dead end.
- It matches the tool authors' own recommended hybrid ordering (`oxlint && eslint`), and the
  de-duplication problem has a supported, non-manual solution (`eslint-plugin-oxlint`).
- Moving the type-aware layer to Nx-only makes it **cacheable and `affected`-scoped**, which is what
  the current `lint-staged` invocation structurally cannot be.

**Alternatives rejected.**

| Alternative                                             | Rejected because                                                                                                                                                                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Full oxlint replacement, drop ESLint                    | Needs oxlint `--type-aware`, which needs TypeScript 7.0+. Would mean dropping 41 rules — a direct FR-005 violation and a failure of the issue's first condition of satisfaction.                                                                       |
| Upgrade TypeScript to 7 first, then migrate wholesale   | Turns a lint-performance change into a TypeScript major upgrade across the workspace: new blast radius, new failure modes, no P1 value until it completes. Explicitly out of scope in `spec.md`. Revisit as a follow-up that _simplifies_ this design. |
| Keep ESLint, just drop `@cspell` from the per-file path | Genuinely cheap and worth ~62 % of rule time — but leaves ~3.2 s of fixed per-invocation overhead untouched, so it cannot reach SC-001 (< 1 s). **Kept as the first task anyway**, since it is independently valuable and de-risks the rest.           |
| Keep ESLint, add caching (`--cache`) to `lint-staged`   | ESLint's cache keys on file content; a staged file has just changed by definition, so every commit is a cache miss on exactly the files being linted. Does not address startup cost either.                                                            |
| Two independent linters, both in `lint-staged`          | Reintroduces the per-file TS program cost, the thing being removed. Also maximises duplicate-diagnostic and fix-fighting risk (FR-014, FR-017).                                                                                                        |
| Run type-aware lint only in CI                          | Fails FR-011 (hook and CI must enforce the same set): a contributor could commit clean and be red in CI, which is the friction this feature exists to remove, relocated rather than fixed.                                                             |

---

## 5. Open questions to resolve with a spike, before writing config

These are unknowns that documentation cannot settle and that would change the task list if they came
out badly. Each has a cheap, concrete resolution step (see `tasks.md`, Phase 1).

| #   | Question                                                                                                                                                                                                                                                                                                             | How to resolve                                                      | If the answer is bad                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| G1  | Which of the 47 ESLint-core + 30 syntactic TS rules does oxlint actually implement, one by one?                                                                                                                                                                                                                      | `npx oxlint@latest --rules` and diff against the 129-rule inventory | Any unimplemented rule stays in the ESLint layer; record in the inventory                  |
| G2  | Do `eslint-plugin-import-x`, `eslint-plugin-check-file` and `eslint-plugin-prefer-arrow-functions` load and run correctly under `jsPlugins`?                                                                                                                                                                         | Enable each, run against the repo, compare diagnostics to ESLint's  | That plugin's rules stay in the ESLint layer — degrades speed, never coverage              |
| G3  | Does oxlint's `no-unused-vars` **auto-fix** remove unused imports the way `unused-imports/no-unused-imports` does? (`fixKind` may need to be `dangerous-fix`)                                                                                                                                                        | Plant an unused import, run `oxlint --fix`, inspect                 | Keep the ESLint rule for the fix, or accept report-only and fix by hand                    |
| G4  | Is oxlint's React Compiler rule at parity with `eslint-plugin-react-compiler` 19.1.0-rc.2?                                                                                                                                                                                                                           | Compare on a file with a known violation                            | Run the ESLint plugin as an oxlint JS plugin, or keep it in the ESLint layer               |
| G5  | What does a JS plugin actually cost? Does adding 4 of them keep the staged pass under 1 s?                                                                                                                                                                                                                           | Measure the staged pass with 0, then all JS plugins enabled         | Move the most expensive plugin's rules to the ESLint layer                                 |
| G6  | How much of the 30.7 s cold full lint remains once the type-aware layer is all that ESLint does?                                                                                                                                                                                                                     | `time` the new type-aware-only target with `--skip-nx-cache`        | If SC-003 is missed, scope the ESLint layer with `nx affected` in the hook and re-measure  |
| G7  | Does `@nx/enforce-module-boundaries` work correctly in the ESLint layer once that layer is Nx-only?                                                                                                                                                                                                                  | Plant a boundary violation, run `pnpm nx run <p>:lint`              | It already only works under Nx — Nx-only execution should _improve_ on today's silent skip |
| G8  | Do the two existing inline suppressions survive? `packages/env-validation-errors/src/index.ts:3` disables `@bluetel-ai/enforce-safe-env` (moving to oxlint → needs `oxlint-disable-next-line`); `src/index.test.ts:253` disables `@typescript-eslint/no-unnecessary-type-assertion` (type-aware → stays with ESLint) | Run both layers and confirm zero errors                             | Convert the comment with `@oxlint/migrate`, which handles this rewrite                     |
| G9  | Does Nx invalidate the `lint` cache when `.oxlintrc.json` changes?                                                                                                                                                                                                                                                   | Change a severity, re-run, confirm a cache miss                     | Add the oxlint config files to `namedInputs.sharedGlobals` in `nx.json`                    |

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
