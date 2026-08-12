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

## 4. Phase 3 — spike measurements (T017, T048)

_Pending._

---

## 5. Phase 5 — success criteria (T036–T038)

_Pending._

---

## 6. Phase 6 — TypeScript 7.0.2 (T052)

_Pending._
