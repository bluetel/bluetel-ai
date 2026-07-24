# Implementation Plan: AI Skill Installer

**Branch**: `feature/spec-kit` (spec dir `001-ai-skill-installer`) | **Date**: 2026-07-23 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-ai-skill-installer/spec.md`

## Summary

Deliver a one-command installer that lets any target project pull selected shared skills (merging, pr-creation, speckit-\*, …) from this repo. A single publishable bootstrap script is fetched and piped to a shell; it verifies prerequisites, performs a **shallow, sparse `git clone`** of only the required `tooling/skills/` subtree of the source repo (no history, no unrelated monorepo content) into a temp dir, and launches the Claude CLI to run an interactive **install skill**. The skill lists the catalog, captures the user's selection, distinguishes fresh install from update (with local-modification protection), and writes each chosen skill into the target's `.agents/skills/<name>/` (canonical content) plus `.claude/skills/<name>/` (activation stub). **All execution on the target is done by Claude driving `git`/`curl`/POSIX shell — there is no Node/tsx on the target.** Deterministic work (catalog scan, semver + hash comparison, atomic writes, stub generation) lives in a testable POSIX shell helper (`lib/skills.sh`) in a new `tooling/skills` package; the SKILL.md orchestrates and owns interactive UX. As a prerequisite, the repo's existing canonical skills are consolidated into that package's `catalog/` subfolder (the single distribution source) and the repo's own agent stubs are repointed at it.

## Technical Context

**Runtime language (installer)**: POSIX `sh` — the installer runs entirely in shell driven by Claude. No Node, no `jq` on the target.

**Source-repo language (tests/build)**: TypeScript (strict), Node v24, ESM — used only in this repo/CI to test the shell logic and validate `skill.meta` files. Not shipped to or run on targets.

**Primary Dependencies**: Target: **Claude CLI**, **`git` ≥ 2.27** (shallow partial clone + sparse-checkout), `curl` (to fetch the bootstrap one-liner), and base POSIX utilities (`sh`, `cp`, `mv`, `mkdir`, `rm`, `find`, `sort`, `awk`, `sed`, and `sha256sum` **or** `shasum`). `tar` is not required. Source repo/CI: `vitest` (tests shell out to `lib/skills.sh`), `@chalkboard/eslint-config-internal`.

**Storage**: Filesystem only. Per-skill `skill.meta` (KEY=value) in the source catalog; per-skill installed record (`.skill`, KEY=value) in target projects. No database, no JSON manifest on the install path.

**Testing**: `vitest run` (Nx `test` target) with colocated `*.test.ts` that invoke `lib/skills.sh` against temp target dirs — mirrors how `tooling/qlty-diff` is tested, no new framework, no target-side Node.

**Target Platform**: Developer machines with a POSIX shell, `git` ≥ 2.27, `curl`, and the Claude CLI (macOS/Linux). Windows out of scope for v1.

**Project Type**: Nx monorepo tooling package — content + shell scripts + shell-out tests (Nx `test`/`typecheck` targets like `@chalkboard/qlty-diff`).

**Performance Goals**: Not performance-sensitive; a full install/update of the selected skills completes in a few seconds on a normal connection.

**Constraints**: Single-file bootstrap; download only the required directories (shallow, sparse, no history); atomic install (no partial writes on failure); **target dependencies limited to Claude CLI + `git` + `curl` + base shell — no Node, no jq, no tar**; canonical content must not be duplicated in the source repo root (`.claude`/`.agents`).

**Scale/Scope**: ~12 skills in the catalog today; expected to stay in the tens. Small per-skill file counts.

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

`.specify/memory/constitution.md` is an unratified template (all placeholders). In its absence the gate is evaluated against the ratified repo conventions in `CLAUDE.md` and `.claude/rules/typescript-conventions.md`. These conventions govern the TypeScript in the repo (the shell-out **tests** and any repo-side validation helper); the installer itself is POSIX shell and follows shell conventions (POSIX-only, `set -eu`, no bashisms).

| Convention                                 | Design compliance                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Named exports only, no default exports     | ✅ Repo-side TS test helpers use named exports                                             |
| Tests colocated (`foo.ts` → `foo.test.ts`) | ✅ `lib/skills.sh` → `lib/skills.test.ts` (vitest shells out)                              |
| Public API through `index.ts` barrel       | ✅ Any repo-side TS API exposed via `src/index.ts`                                         |
| No `.js` extensions in imports             | ✅ Extensionless local imports                                                             |
| Break large files into focused modules     | ✅ Shell helper split into focused functions; content, bootstrap, skill, lib kept separate |
| Run tasks through Nx                       | ✅ `typecheck` + `test` targets, mirroring qlty-diff `project.json`                        |
| POSIX shell portability (installer)        | ✅ `set -eu`, `sha256sum`/`shasum` fallback, awk-based semver compare (no `sort -V`)       |

**Result**: PASS — no violations, Complexity Tracking not required.

## Project Structure

### Documentation (this feature)

```text
specs/001-ai-skill-installer/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── cli.md           # Shell helper contract (lib/skills.sh: list/status/install/update)
│   └── catalog.schema.md # skill.meta + installed-record + stub formats, hash definition
└── checklists/
    └── requirements.md  # Spec quality checklist (from /speckit-specify)
```

### Source Code (repository root)

```text
tooling/skills/                     # NEW package — @chalkboard/skills (single distribution source)
├── package.json                    # name @chalkboard/skills, type module (for CI tests only)
├── project.json                    # Nx typecheck + test targets (mirrors qlty-diff)
├── tsconfig.json
├── vitest.config.ts
├── eslint.config.mjs
├── catalog/                        # Canonical skill content (moved out of repo-root .agents/.claude)
│   ├── merging/
│   │   ├── SKILL.md
│   │   └── skill.meta              # KEY=value: name, version, description, argument_hint?, requires?
│   ├── pr-creation/{SKILL.md,skill.meta}
│   ├── speckit-plan/{SKILL.md,skill.meta}
│   └── …                           # one dir per skill (+ supporting files)
├── bootstrap/
│   └── install.sh                  # THE single publishable file (curl … | sh); shallow sparse git clone; POSIX, no Node
├── skill/
│   └── SKILL.md                    # The interactive "install" skill procedure Claude runs
└── lib/
    ├── skills.sh                   # POSIX shell helper: list | status | install | update
    └── skills.test.ts              # vitest shells out to skills.sh against temp targets (CI only)

# Consolidation (User Story 4) — canonical content leaves the repo root:
.agents/skills/<name>/  →  content moves to tooling/skills/catalog/<name>/
.claude/skills/<name>/SKILL.md  →  stub repointed at tooling/skills/catalog/<name>/SKILL.md
```

**Structure Decision**: A single new package `@chalkboard/skills` under `tooling/` (already a pnpm/Nx workspace glob). It holds four concerns in separate folders: the canonical skill **catalog/** (distribution source, directory-based, each with `skill.meta`), the single **bootstrap/** file, the interactive **skill/** procedure, and the deterministic **lib/** shell helper (with colocated shell-out tests). The package's Node/vitest surface exists only for CI testing of the shell logic — nothing Node-based is shipped to or executed on targets, which need only Claude CLI + `git` + `curl` + base shell.

## Complexity Tracking

> No constitution violations — section intentionally empty.
