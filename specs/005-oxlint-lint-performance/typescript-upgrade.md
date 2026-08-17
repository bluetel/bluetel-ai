# TypeScript Upgrade — compatibility evidence (T050–T053)

**Outcome: TypeScript `6.0.3`, not `7.0.2`.** This is the FR-026 fallback, taken because a
workspace tool cannot run on TypeScript 7 — not because the upgrade was untested. It was
tested, it typechecks this repository clean and ~5.4× faster, and it still cannot land.

## What was tried, in order

### 1. TypeScript 7.0.2 — `tsc` works, and is dramatically faster

Installed at the root and in `packages/env-validation-errors`. Resolution asserted rather than
assumed (**FR-024**): `tsc --version` → `7.0.2` and
`node -e "require('typescript/package.json').version"` → `7.0.2` agree.

Every project typechecks clean, with no `tsconfig` option relaxed (**FR-023**) — the
`"types": ["node"]` line landed in Phase 0 is what makes that true, and it is a no-op under
5.9.2.

| Project                          |      5.9.2 |  **7.0.2** | Peak RSS 5.9.2 → 7.0.2          |
| -------------------------------- | ---------: | ---------: | ------------------------------- |
| `packages/env-validation-errors` |     1.47 s | **0.29 s** | 290 512 KB → **94 308 KB**      |
| `tooling/commit-conventions`     |     1.02 s | **0.22 s** | 180 788 KB → **75 296 KB**      |
| `tooling/qlty-diff`              |     1.03 s | **0.16 s** | 214 188 KB → **61 984 KB**      |
| `tooling/skills`                 |     1.20 s | **0.20 s** | 226 008 KB → **66 148 KB**      |
| **Total**                        | **4.72 s** | **0.87 s** | **5.4× faster, −67 % peak RSS** |

`pnpm typecheck --skip-nx-cache` fell from 7.38 s to **2.19 s**.

### 2. …and then Nx cannot build its project graph

```text
NX  Failed to process project graph.
5 errors occurred while processing files for the @nx/js/typescript plugin
  - packages/env-validation-errors/tsconfig.json: Cannot read properties of undefined (reading 'Ts')
  - tooling/commit-conventions/tsconfig.json: Cannot read properties of undefined (reading 'Ts')
  - tooling/lint-coverage/tsconfig.json: Cannot read properties of undefined (reading 'Ts')
  - tooling/qlty-diff/tsconfig.json: Cannot read properties of undefined (reading 'Ts')
  - tooling/skills/tsconfig.json: Cannot read properties of undefined (reading 'Ts')
An error occurred while processing files for the @nx/eslint/plugin plugin.
  - eslint.config.mjs: Cannot read properties of undefined (reading 'Intrinsic')
The "nx/js/dependencies-and-lockfile" plugin threw an error while creating dependencies:
  tsModule.readConfigFile is not a function
```

`ts.ScriptKind.Ts`, `ts.TypeFlags.Intrinsic` and `ts.readConfigFile` are all part of the
JavaScript compiler API, which TypeScript 7 does not ship. Nx's inference plugins call them at
graph-construction time, so this is not a warning: **`pnpm nx show projects` fails, and with it
every `nx run`, `nx affected` and CI job.**

This is **gap G13** and plan **C4** arriving together. `@nx/eslint` hard-depends on
`typescript: ~5.9.2`, so a second copy exists in the tree regardless — but with
`nodeLinker: hoisted`, the root pin wins the hoisted slot and Nx loads whichever version is
there. There is no way to give Nx 5.9 and `tsc` 7 from one hoisted tree.

**A tool that fails loudly is the good case.** Nx aborts rather than silently producing an
empty graph, so the blocker is unmissable. This is the same property that made the oxlint
migration checkable, and it is worth noting that the check found the blocker in one command.

### 3. TypeScript 6.0.3 — the FR-026 landing spot

The last release carrying the JavaScript compiler API, and inside typescript-eslint's
`>=4.8.4 <6.1.0` peer range.

| Gate                                                      | Result                   |
| --------------------------------------------------------- | ------------------------ |
| `pnpm nx show projects`                                   | 9 projects, graph builds |
| `pnpm typecheck --skip-nx-cache`                          | 5/5 pass                 |
| `pnpm test --skip-nx-cache`                               | 6/6 pass                 |
| `pnpm nx run-many -t lint lint-workspace --skip-nx-cache` | 9/9 pass, both layers    |

| Project                          |      5.9.2 |      6.0.3 |
| -------------------------------- | ---------: | ---------: |
| `packages/env-validation-errors` |     1.47 s |     1.49 s |
| `tooling/commit-conventions`     |     1.02 s |     0.95 s |
| `tooling/qlty-diff`              |     1.03 s |     1.03 s |
| `tooling/skills`                 |     1.20 s |     1.17 s |
| **Total**                        | **4.72 s** | **4.64 s** |

**No speed gain, and none expected.** 6.0.3 is the same JavaScript compiler; the ~6× belongs
entirely to the Go port. What it buys is a rung: one release closer, still inside every peer
range, with the blocker written down instead of rediscovered.

## What has to happen before TypeScript 7 can land

One thing, and it is not ours:

- **Nx must stop calling the JavaScript compiler API** in `@nx/js/typescript` and
  `@nx/eslint`, or must pin its own TypeScript in a way a hoisted workspace cannot override.
  Until then the version bump is a hard CI failure, not a degraded experience.

Two things that are **no longer** blockers, and were expected to be:

- **typescript-eslint's peer range.** It does not matter any more. Phase 4 took typescript-eslint
  off the rule set entirely; the ESLint layer retains only `@typescript-eslint/parser`, and only
  to read `.ts` files at all for four rules. The 41 type-aware rules now run under
  `oxlint-tsgolint`, which embeds its own typechecker and never loads the installed
  `typescript` — so **the lint gate is already TypeScript-7-ready and the rule set will not
  shrink by one rule on the day the compiler moves.** That was the whole point of the ordering.
- **`@types/node` discovery.** Handled in Phase 0. TypeScript 7 does not auto-discover it from
  the hoisted root in this layout; `"types": ["node"]` in `tsconfig.base.json` fixes it and is a
  no-op under 5.9.2 and 6.0.3 alike.

## Re-verification after the bump (T053)

- `rule-inventory.md` regenerated: **146 rules, 41 type-aware, 0 unassigned, 0 dropped** —
  unchanged by the compiler version, which is what one would expect now that nothing on the
  lint path reads it.
- The parity suite passes: every enforced rule still fires on its planted violation.
- The type-aware layer's diagnostics are **identical** before and after the bump. tsgolint
  applies TypeScript 7 semantics regardless of the installed compiler, so moving from 5.9.2 to
  6.0.3 changes nothing it sees. The linter/compiler semantic mismatch recorded in
  `research.md` §7.5 therefore still stands, and closing it still needs TypeScript 7.
