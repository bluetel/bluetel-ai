# Phase 0 Research: AI Skill Installer

All decisions below resolve the "deferred to planning" items from the spec's Assumptions section. No `NEEDS CLARIFICATION` markers remain.

**Overarching constraint (per user direction)**: the target machine runs the installer with **only the Claude CLI + `git` + `curl` + standard POSIX shell tools** — **no Node/tsx on the target**. All execution ("usage") is performed by Claude driving shell commands. Node/vitest are used only in the _source repo / CI_ to test the shell logic.

## R1. Tooling package location & name

- **Decision**: New package at `tooling/skills/`, published name `@chalkboard/skills`, canonical content in the `catalog/` subfolder.
- **Rationale**: `tooling/*` is already a pnpm workspace glob and an Nx project location; `@chalkboard/*` is the established scope for internal tooling (`qlty-diff`, `eslint-config-*`). The package now holds content + shell scripts + tests rather than a runtime TS CLI, but the Nx `test`/`typecheck` target shape still mirrors `qlty-diff`.
- **Alternatives rejected**: `packages/*` (runtime scope, not tooling); a standalone repo (breaks single-source model + dogfooding).

## R2. Distribution / download surface — shallow sparse git clone of required dirs

- **Decision**: The user fetches **one** file — `bootstrap/install.sh` — via `curl … | sh`. The bootstrap performs a **shallow, sparse `git clone`** of the source repo at a pinned ref into a temp dir, checking out **only the required directories** (the `tooling/skills/` subtree), then launches `claude` pointed at the snapshot's `skill/SKILL.md`. Concretely:

  ```sh
  git clone --depth 1 --filter=blob:none --sparse \
    --branch "<ref>" https://github.com/harrytwigg/universal-react-monorepo.git "$TMP"
  git -C "$TMP" sparse-checkout set tooling/skills
  ```

  `--depth 1` fetches no history; `--filter=blob:none` + `--sparse` fetch blobs only for the checked-out paths; `sparse-checkout set tooling/skills` restricts the working tree to the one required directory (the catalog, the shell helper, and the install skill) instead of the whole monorepo. The set can be narrowed further to specific `tooling/skills/catalog/<name>` dirs once a selection is known, but the whole `tooling/skills` subtree is small enough to take in one pass.

- **Rationale**: Satisfies "single file piped to bash" literally. Shallow + partial-clone + sparse-checkout means the target downloads **only the required directories, no git history, and no unrelated monorepo content** — fast and small. The clone lands in a temp dir and the install only proceeds if it completes, preserving the "no partial install" guarantee (SC-005). A pinned ref gives a consistent snapshot so catalog and content never disagree mid-run.
- **Target dependency**: `git` (with partial-clone/sparse-checkout support — git ≥ 2.27, standard on current macOS/Linux). `tar` is no longer needed; `curl` is still used to fetch the bootstrap one-liner itself.
- **Alternatives rejected**: tarball snapshot from GitHub codeload (pulls the _entire_ repo archive, not just required dirs — wasteful for a large monorepo, and needs `tar`); per-file `raw.githubusercontent.com` fetches (non-atomic, rate limits); full `git clone` (history + whole tree); npm publish (heavier pipeline; skills aren't runtime packages).

## R3. Catalog format — directory-based, shell-parseable (no JSON manifest)

- **Decision**: The catalog **is** the set of directories under `catalog/`. Each `catalog/<name>/` contains the canonical skill files plus a `skill.meta` file in `KEY=value` form (`name`, `version`, `description`, optional `argument_hint`, optional `requires`). Listing the catalog = scanning `catalog/*/skill.meta`. No `catalog.json` manifest is parsed on the target.
- **Rationale**: `KEY=value` is trivially read in POSIX shell (`while IFS='=' read`), so **no `jq` dependency**. A directory scan can never drift from the actual content (directly satisfies FR-014/FR-015). Content files are everything in the dir except `skill.meta`.
- **Alternatives rejected**: a `catalog.json` manifest — would require `jq` on the target or fragile shell JSON parsing, and can drift from the on-disk content. (An optional generated `catalog.json` may still be produced for _external_ consumers, but it is not on the install path.)

## R4. Version metadata & update detection (shell hashing)

- **Decision**: Each skill's `skill.meta` carries a **semver `version`**. At install time the installer computes a **`sha256` content hash** of the written files and records it in the target. Detection:
  - **Newer available** = source (snapshot) `version` > installed `version` (awk-based numeric semver compare — avoids relying on `sort -V`, which is not portable to stock macOS `sort`).
  - **Locally modified** = current on-disk content hash ≠ the `installed_hash` recorded at install time.
  - No source-side content hash is needed — the hash is only ever compared against the target's own recorded baseline.
- **Hash tool**: a single `_sha256` shell wrapper selects `sha256sum` (Linux) or `shasum -a 256` (macOS), used for both the install-time record and the later re-check, so the two are guaranteed to agree.
- **Rationale**: version answers "offer an update?" (FR-011); hash answers "will I clobber edits?" (FR-012). Both computable with base shell tools.
- **Alternatives rejected**: git-diff detection (needs git + tracked skill); mtime comparison (unreliable); version-only (can't detect local edits → violates FR-012).

## R5. Execution model — Claude + shell, no Node on target

- **Decision**: Three pieces, all shell/markdown:
  - **`bootstrap/install.sh`** (POSIX sh) — verify `claude`, `git`, and a hash tool present; shallow sparse-clone the required `tooling/skills/` subtree into a temp dir (R2); launch `claude` on `skill/SKILL.md`. No Node check.
  - **`skill/SKILL.md`** — the install skill: interactive selection UX, confirmation prompts, summary. It invokes the shell helper for every deterministic step and reads the filesystem directly to inspect state.
  - **`lib/skills.sh`** (POSIX sh) — deterministic helper with subcommands `list | status | install | update`, implementing catalog scan, semver compare, hashing, atomic staged writes, stub generation, and stable exit codes. Human/line-based output (no JSON).
- **Rationale**: Removes the target-side Node/tsx dependency the user asked to drop, while still isolating the correctness-critical logic in one script that is unit-testable (see R9). Claude owns conversation; `lib/skills.sh` owns determinism.
- **Alternatives rejected**: all logic inline in `SKILL.md` (untestable, easy to leave partial state); a Node/tsx CLI on the target (the dependency being removed).

## R6. Target write model & atomicity

- **Decision**: For each selected skill, `lib/skills.sh` stages files into a temp dir inside the target (e.g. `.agents/skills/.staging-<name>/`), validates, then `mv`s content into `.agents/skills/<name>/` and the stub into `.claude/skills/<name>/`; on any error it `rm -rf`s the staging dir and leaves the target untouched. Missing `.agents/skills` / `.claude/skills` are created without disturbing siblings.
- **Rationale**: Delivers FR-013 and SC-005 and the "interrupted install" / "missing target folders" edge cases; same-filesystem `mv` is atomic per path.
- **Alternatives rejected**: writing directly to final paths (interruption leaves a half-written SKILL.md / mismatched stub-content pair).

## R7. Source-repo consolidation (User Story 4)

- **Decision**: Move each skill's canonical content from repo-root `.agents/skills/<name>/` into `tooling/skills/catalog/<name>/` (adding `skill.meta`). Repoint the repo's own `.claude/skills/<name>/SKILL.md` stubs at `tooling/skills/catalog/<name>/SKILL.md`. No canonical copy remains in the repo root (SC-007); the source repo's agents resolve every skill through the catalog pointer (FR-017).
- **Asymmetry (intentional)**: in the **source** repo, `.claude` stubs point at `catalog/`; in a **target** repo, the installer materializes real content into `.agents/skills/<name>/` + a stub into `.claude/skills/<name>/`. Targets have no in-repo catalog, so they need a materialized copy.
- **Alternatives rejected**: dogfooding the installer against the source repo (recreates canonical duplicates → violates SC-007).

## R8. Activation stub generation

- **Decision**: `lib/skills.sh` generates the target `.claude/skills/<name>/SKILL.md` from `skill.meta`: YAML frontmatter (`name`, `description`, optional `argument-hint`) via a small `printf`/heredoc template, followed by the standard pointer line to `.agents/skills/<name>/SKILL.md`. Canonical content is copied verbatim to `.agents/skills/<name>/`.
- **Rationale**: Reproduces the convention in `.agents/skills/README.md`, so installed skills are discoverable exactly as the source repo's are. Frontmatter is data-driven from `skill.meta`, so it never drifts from the description shown at selection time.
- **Alternatives rejected**: pre-baked per-skill stub files (duplicate the description → drift).

## R9. Testing the shell logic (source repo / CI only)

- **Decision**: `lib/skills.sh` is exercised by **vitest tests that shell out** to it against temp target dirs (`lib/skills.test.ts`), run via the existing Nx `test` target — no new test framework, and no target-side Node (tests run only in the source repo/CI where Node already exists).
- **Rationale**: Reuses `vitest` (already a workspace dep) and keeps colocated-test conventions, while the _installer itself_ stays pure shell.
- **Alternatives rejected**: bats-core (new tool to introduce); leaving the shell logic untested (correctness-critical paths — atomicity, local-mod detection — must be covered).

## R10. Non-interactive / CI behavior

- **Decision**: `lib/skills.sh` accepts explicit skill names + `--force`, so it is fully scriptable without Claude. When `SKILL.md` detects no interactive TTY and no explicit selection, it fails with a clear message rather than hanging.
- **Rationale**: Covers the non-interactive edge case and makes the deterministic core directly testable.
- **Alternatives rejected**: defaulting to "install everything" non-interactively (violates least-astonishment).

## R11. Conflict resolution for locally-modified skills — keep / overwrite / resolve

- **Decision**: When an update targets a skill whose current on-disk hash ≠ its recorded `installed_hash` (state `locally-modified`; also `inconsistent`/`unknown`), `lib/skills.sh` never overwrites blindly. It surfaces the conflict and supports three explicit resolutions, selected by `--on-conflict <mode>` (or interactively by the skill):
  - **keep** — leave the local files untouched; report `ACTION=keep`, skip the update.
  - **overwrite** — replace with the incoming catalog version (the old `--force` behavior); `--force` remains a scriptable alias for `--on-conflict overwrite`.
  - **resolve** — attempt a **three-way merge** per content file: `base` = the originally-installed version, `local` = current on-disk, `incoming` = new catalog version. Implemented with `git merge-file -p base local incoming` (git is already a target dependency). Non-overlapping changes merge automatically → `ACTION=merge`, record rewritten to the new version. Overlapping changes → the merged file is written **with standard conflict markers** (`<<<<<<< / ======= / >>>>>>>`), the skill is left in a clearly-marked unresolved state, `ACTION=merge-conflict`, exit `6`; the record is **not** advanced to the new version (so a later run still sees work to do).
- **Obtaining the merge base**: the base is the content as originally installed. It is reconstructed by a second shallow sparse checkout of `catalog/<name>` at the record's `source_ref` (recorded in `.skill`) — the same clone mechanism as R2, narrowed to one skill. This needs no extra target-side storage. If the base cannot be obtained (offline, ref removed, missing `source_ref`), **merge is unavailable**: the helper reports this and the choice degrades to keep/overwrite (it also writes the incoming version to a sidecar `<file>.incoming` so a human/Claude can merge by hand).
- **Claude-assisted resolution (skill layer)**: after a `merge-conflict`, `SKILL.md` can offer to let Claude propose a resolution of the marked regions for the user to review — an AI-native "try to resolve" on top of the deterministic git merge. The shell helper stays deterministic (git merge only); anything semantic is the skill's job and always user-reviewed.
- **Rationale**: Gives the user the real choice they expect (FR-012a/FR-012b) instead of a binary force flag; reuses the git dependency and the existing sparse-clone path for the base; keeps the destructive step gated behind an explicit selection; and never records a conflicted file as a successful update.
- **Alternatives rejected**: binary `--force` only (no "resolve" path — the gap this change closes); storing a full base copy in the target (bloats every install to enable an occasional merge — reconstruct on demand instead); `diff3(1)` (not universally present on stock macOS; `git merge-file` ships with the required git); auto-resolving conflicts by preferring one side (silently drops changes — violates FR-012).

## Resolved unknowns summary

| Deferred item (from spec)               | Resolution                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| Tooling package name + subfolder layout | `@chalkboard/skills` at `tooling/skills/`, content in `catalog/` (R1)                      |
| Download/publish surface                | Single `install.sh` bootstrap → shallow, sparse `git clone` of only `tooling/skills/` (R2) |
| Catalog format                          | Directory scan + per-skill `skill.meta` (KEY=value), no JSON/jq (R3)                       |
| Version-metadata mechanism              | semver in `skill.meta` + `sha256` (shasum/sha256sum); target records `installed_hash` (R4) |
| Execution runtime                       | Claude + `git`/`curl`/POSIX shell, **no Node on target** (R5)                              |
| Activation-stub registration            | Generated `.claude` stub + pointer, content copied to `.agents` (R8)                       |
| Local-modification conflict handling    | keep / overwrite / resolve; 3-way `git merge-file`, base re-fetched at `source_ref` (R11)  |
