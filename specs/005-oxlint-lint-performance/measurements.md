# Measurements

Evidence base for every success criterion in [spec.md](./spec.md). Every row is a real command run in
this repository, not an estimate.

**Environment**: GitHub Actions `ubuntu-latest`, Node v24.15.0, pnpm 11.3.0, 4 vCPU. Wall time and peak
RSS from `/usr/bin/time -f "%e s %M KB"`. Numbers from a CI runner are noisier than a developer laptop;
compare ratios, not absolutes.

---

## 1. Baseline — before any change (T001)

Taken at commit `4fefdda`, with no configuration modified.

| #   | What                                                     | Command                                                                                                                                          |        Wall |       Peak RSS |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------: | -------------: |
| B1  | ESLint, **one** staged file, exact `lint-staged` command | `node --max-old-space-size=8192 ./node_modules/.bin/eslint --flag v10_config_lookup_from_file --fix packages/env-validation-errors/src/index.ts` |  **5.58 s** | **825 512 KB** |
| B2  | Full lint, cold                                          | `pnpm lint:check --skip-nx-cache`                                                                                                                | **31.86 s** |              — |
| B3  | Full typecheck, cold                                     | `pnpm typecheck --skip-nx-cache`                                                                                                                 |  **7.38 s** |              — |

**B1 also emits** `warning No cached ProjectGraph is available. The rule will be skipped.
@nx/enforce-module-boundaries` — confirming research.md §1: that rule is **not** enforced on the
staged-file path today. Pre-existing; closed by T031.

### 1.1 Per-project `tsc --noEmit`, TypeScript 5.9.2, **before** `"types": ["node"]`

| Project                          |       Wall |   Peak RSS |
| -------------------------------- | ---------: | ---------: |
| `packages/env-validation-errors` |     1.62 s | 327 584 KB |
| `tooling/commit-conventions`     |     1.11 s | 241 668 KB |
| `tooling/qlty-diff`              |     1.08 s | 215 572 KB |
| `tooling/skills`                 |     1.16 s | 199 324 KB |
| **Total**                        | **4.97 s** |          — |

---

## 2. Phase 0 — `"types": ["node"]` (T047)

The SC-010 / SC-011 baseline. Taken **with** the option set so the Phase 6 comparison is like-for-like.

`pnpm typecheck --skip-nx-cache` — **passes**, 4/4 projects.

| Project                          |       Wall |   Peak RSS |
| -------------------------------- | ---------: | ---------: |
| `packages/env-validation-errors` |     1.47 s | 290 512 KB |
| `tooling/commit-conventions`     |     1.02 s | 180 788 KB |
| `tooling/qlty-diff`              |     1.03 s | 214 188 KB |
| `tooling/skills`                 |     1.20 s | 226 008 KB |
| **Total**                        | **4.72 s** |          — |

No measurable change, as expected — TypeScript 5.9.2 already resolved `@types/node` by auto-discovery;
the option only makes that resolution explicit. Its value is for TypeScript 7 (research.md §7.4), where
auto-discovery does **not** find the hoisted package.

**G14 resolved.** `tooling/skills/tsconfig.json` already set `"types": ["node"]` locally, so one project
had this shape before the change. No project depends on ambient types from any other `@types` package:
`@types/node` is the only `@types/*` any workspace member declares (the rest in `node_modules/@types`
are transitive), and all four projects import Vitest's `describe`/`it`/`expect` explicitly rather than
relying on globals — even `packages/env-validation-errors`, whose `vitest.config.ts` sets
`globals: true`. The option therefore belongs in `tsconfig.base.json`, not per project.

---

## 3. Phase 1 — cspell off the per-file path (T005)

| #   | What                         |       Wall |   Peak RSS | vs baseline    |
| --- | ---------------------------- | ---------: | ---------: | -------------- |
| B1  | ESLint, one file, **before** |     5.58 s | 825 512 KB | —              |
| P1  | ESLint, one file, **after**  | **3.12 s** | 501 280 KB | **−44 % wall** |
| P1b | same, second run             |     3.15 s | 490 292 KB | —              |

Command after: `node --max-old-space-size=8192 ./node_modules/.bin/eslint --config eslint.staged.config.mjs --fix packages/env-validation-errors/src/index.ts`

**−2.46 s**, larger than the ~1.5 s predicted from `TIMING=15`. `TIMING` attributes only rule execution;
it does not attribute the cost of _loading_ `@cspell/eslint-plugin` and its dictionaries, which is paid
during config resolution. Peak RSS fell 39 % (825 MB → 501 MB) for the same reason.

**Rule accounting** (`eslint --print-config packages/env-validation-errors/src/index.ts`):

| Config                                        | Enabled rules | `@cspell/spellchecker` |
| --------------------------------------------- | ------------: | ---------------------- |
| project `eslint.config.mjs` (Nx `lint`)       |       **129** | present                |
| root `eslint.staged.config.mjs` (lint-staged) |       **128** | absent                 |

129 matches research.md §2 exactly. **T004**: a planted misspelling
(`export const mispeledWordHere = 'teh quik brwn fox'`) produces 3 `@cspell/spellchecker` errors under
the project config and **zero** diagnostics under the staged config. The rule moved; it did not leave.

---

## 4. Phase 3 — spike (T013–T018, T048)

Method: oxlint **fails config parsing on an unknown rule name**, so "the config parses" is a
direct proof that a rule exists. All 129 rules enabled for a `.ts` file were probed by writing
a one-rule config and checking whether it parsed. No documentation was taken on trust.

| Question | Answer |
| --- | --- |
| **G1** — native rule coverage | **120 / 129**. The 9 without a native rule: `no-octal`, `@nx/enforce-module-boundaries`, `@cspell/spellchecker`, `unused-imports/no-unused-imports`, `import-x/order`, `prefer-arrow-functions/prefer-arrow-functions`, both `check-file` rules, `@bluetel-ai/enforce-safe-env` |
| **G1b** — the 18 core rules only enabled for `.js`/`.mjs` | 17 native; `no-dupe-args` absent |
| **G2** — JS plugin loading | All four ESLint plugins load unchanged through `jsPlugins`. `import-x` and `unused-imports` collide with built-in oxlint namespaces and must be **aliased** — oxlint refuses the collision rather than silently shadowing |
| **G5 / SC-001** — cost with every JS plugin loaded | **0.78 s** for one file including type-aware rules, against a 1 s target and a 5.58 s baseline |
| **T048** — do the type-aware rules fire? | **41 / 41**, and 39 of them report nothing without `--type-aware`, so the flag is demonstrably doing the work |
| **G10** — the 5 `no-unnecessary-type-assertion` divergences | **oxlint is right.** `tsc --noEmit` passes with all six `issues as readonly StandardSchemaV1.Issue[]` assertions removed, so they were unnecessary and ESLint was missing them. Removed in the migration commit |
| **G10b** — the divergence in the other direction | ESLint reports one assertion oxlint does not (`(await importOriginal()) as Record<string, unknown>`). It was already suppressed, so nothing changes in enforcement — but it is a real gap in oxlint's implementation and is recorded rather than assumed away |

### Two findings that would have silently weakened the rule set

1. **`"categories": {}` does not disable oxlint's defaults.** Listing a plugin turns on its
   `correctness` category, and an empty `categories` object leaves that alone — a
   `unicorn/no-useless-spread` diagnostic appeared on existing code from a rule nobody had
   asked for, breaching FR-013. Every category has to be set to `off` **by name**.
2. **`restrict-plus-operands` and `restrict-template-expressions` fire on nothing at their
   oxlint defaults.** Both are configured here with non-default options, and with the
   workspace's own options supplied they fire correctly. A migration that carried rule names
   without their options would have left two rules enabled, green, and doing nothing.

### A third: `extends` is lossy

`.oxlintrc.json` extending `tooling/oxlint-config/oxlintrc.base.json` merged `rules` and
`overrides` but **silently dropped `ignorePatterns`, `env`, `globals` and `categories`** — the
resolved config showed `ignorePatterns: []` against three authored entries. The root
`.oxlintrc.json` is therefore the complete config, and `tooling/oxlint-config` holds the JS
plugins. Checked with `oxlint --print-config`, which is the only way to see it.

---

## 5. Phase 5 — success criteria (T036–T038)

| SC | Target | Before | After | Verdict |
| --- | --- | ---: | ---: | --- |
| **SC-001** | staged-file lint < 1 s | 5.58 s | **0.78 s** | **met** (7.2× faster) |
| **SC-004** | staged-file peak RSS well below 780 MB | 825 512 KB | **119 208 KB** | **met** (−86 %); `--max-old-space-size=8192` dropped |
| **SC-003** | cold full lint ≤ 15 s combined | 31.86 s | **33.1 s** (9.96 s oxlint + 23.1 s ESLint) | **missed** — see below |

**SC-003 is missed, and the reason is not oxlint.** The oxlint layer does all 142 rules across
the workspace in **9.96 s** cold, or **1.52 s** as a single invocation over the whole repo. The
23.1 s is the ESLint layer: four rules, but nine separate Node processes each paying ~2.5 s of
flat-config resolution and `@cspell/eslint-plugin` dictionary loading. The per-project split is
what Nx needs for caching and `affected`, and it is what makes the pre-commit step cheap in the
case that actually matters — one project changed, warm cache. A cold full run of every project
is the worst case for it and the rarest.

The route to SC-003 is `research.md` §3.5 option B: run `cspell` as its own workspace-wide Nx
target instead of as an ESLint rule, leaving ESLint with two rules and no dictionary load. That
is a separate change with its own dependency, and it is queued rather than smuggled in here.

---

---

## 6. Phase 6 — TypeScript 7.0.2 (T052)

_Pending._
