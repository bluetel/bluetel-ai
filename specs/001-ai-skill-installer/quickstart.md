# Quickstart & Validation: AI Skill Installer

Runnable scenarios that prove the feature works end-to-end. The installer is pure shell (Claude + `git`/`curl`/POSIX tools) — **no Node on the target**. Paths and command shapes reference [contracts/cli.md](./contracts/cli.md) and [data-model.md](./data-model.md).

## Prerequisites

- **Target-side (the real experience)**: a POSIX shell, `git` ≥ 2.27, `curl`, `sha256sum` or `shasum`, and the **Claude CLI**. No Node, no `jq`, no `tar`.
- **Source-repo / CI (for the automated tests only)**: Node v24, `pnpm@11.3.0`, repo bootstrapped (`pnpm install`).
- Catalog populated (User Story 4 consolidation done), with each `catalog/<name>/skill.meta` present.

## A. Deterministic core (shell only, no Claude, no network) — CI-friendly

Run the helper directly against a throwaway target. Validates the shell contract.

```bash
CATALOG=tooling/skills/catalog
TARGET=$(mktemp -d)

# 1. List — everything reports not-installed (SC-002 baseline, SC-006)
sh tooling/skills/lib/skills.sh list --catalog "$CATALOG" --target "$TARGET"
# expect: one line per catalog skill, STATE=not-installed

# 2. Fresh install one skill (User Story 1)
sh tooling/skills/lib/skills.sh install merging --catalog "$CATALOG" --target "$TARGET"
ls "$TARGET/.agents/skills/merging/SKILL.md"   # canonical content
ls "$TARGET/.agents/skills/merging/.skill"     # install record (KEY=value)
ls "$TARGET/.claude/skills/merging/SKILL.md"   # activation stub
# expect: nothing written outside .agents/.claude (SC-002)

# 3. Idempotency — second run routes to skip/update, never duplicates (SC-003)
sh tooling/skills/lib/skills.sh install merging --catalog "$CATALOG" --target "$TARGET"
# expect: ACTION=skip, exit 0

# 4. Local-modification protection + conflict resolution (FR-012 / FR-012a / FR-012b)
echo "local edit" >> "$TARGET/.agents/skills/merging/SKILL.md"

# 4a. No mode + non-interactive → refuse, nothing changed
sh tooling/skills/lib/skills.sh update merging --catalog "$CATALOG" --target "$TARGET"; echo "exit=$?"
# expect: ACTION=conflict, file unchanged, exit=3

# 4b. keep → local version preserved
sh tooling/skills/lib/skills.sh update merging --on-conflict keep --catalog "$CATALOG" --target "$TARGET"; echo "exit=$?"
# expect: ACTION=keep, file still has the local edit, exit=0

# 4c. resolve, non-overlapping → auto-merge (bump catalog version first, edit a different region)
sh tooling/skills/lib/skills.sh update merging --on-conflict resolve --catalog "$CATALOG" --target "$TARGET"; echo "exit=$?"
# expect: ACTION=merge, both changes present, NO conflict markers, record advanced, exit=0

# 4d. resolve, overlapping → conflict markers, record not advanced
sh tooling/skills/lib/skills.sh update merging --on-conflict resolve --catalog "$CATALOG" --target "$TARGET"; echo "exit=$?"
# expect: ACTION=merge-conflict, file has <<<<<<</=======/>>>>>>> markers, exit=6

# 4e. overwrite (alias --force) → incoming version wins
sh tooling/skills/lib/skills.sh update merging --on-conflict overwrite --catalog "$CATALOG" --target "$TARGET"; echo "exit=$?"
# expect: ACTION=update, overwritten to catalog version, exit=0

rm -rf "$TARGET"
```

**Update-detection check**: bump a `catalog/<name>/skill.meta` `version`, then `status` on a target where that skill is installed → `outdated` (FR-011).

**Merge-base-unavailable check**: point `source_ref` in a `.skill` at a nonexistent ref (or run offline), then `update <name> --on-conflict resolve` → merge reported unavailable, `<file>.incoming` sidecar written, falls back to the keep/overwrite decision (FR-012b), target not corrupted.

**Atomicity check**: make a target path unwritable partway (or inject a failure in a test) → target byte-for-byte unchanged, exit `4` (SC-005).

**Missing-tool check**: run with `sha256sum`/`shasum` off PATH → exit `5` with guidance.

## B. Automated tests (source repo / CI)

```bash
pnpm nx test skills        # vitest shells out to lib/skills.sh against temp targets
pnpm nx typecheck skills
```

Cover: catalog scan + `skill.meta` validation, awk semver compare, `skill_hash` determinism, every `SkillState` in the data-model table, stub generation (frontmatter + pointer, quote escaping), atomic staged-write rollback, and the contract-test expectations in [contracts/cli.md](./contracts/cli.md).

## C. End-to-end user flow (manual, with Claude CLI)

Simulates the published experience in a scratch project.

```bash
SCRATCH=$(mktemp -d); cd "$SCRATCH"
# Stand-in for the published one-liner (curl … | sh):
sh /path/to/tooling/skills/bootstrap/install.sh
```

Expected:

1. Bootstrap verifies `claude`, `git` (≥ 2.27), and a hash tool; if any is missing, prints actionable guidance and exits without changes (FR-013/FR-014).
2. Bootstrap shallow sparse-clones only `tooling/skills/` into a temp dir (no history, no unrelated content; atomic — no partial state).
3. Claude runs the install skill; it lists skills with descriptions (User Story 3) and prompts for a selection.
4. On selection, chosen skills materialize under `$SCRATCH/.agents/skills/*` + `$SCRATCH/.claude/skills/*`.
5. A summary lists what was installed and where, and confirms discoverability (SC-004).
6. Re-running enters the update flow, not a fresh install (User Story 2 / SC-003).

## D. Source-repo consolidation check (User Story 4 / SC-007)

```bash
ls tooling/skills/catalog/                       # canonical content lives here, each dir has skill.meta
grep -rl "tooling/skills/catalog" .claude/skills/ | head   # repo-root stubs point at the catalog
```

Expected: canonical content only under `tooling/skills/catalog/`; no canonical duplicates in the repo root; the source repo's own skills still resolve and run (e.g. invoking `merging` works via the repointed stub).

## Traceability

| Validated by       | Requirement / criterion                     |
| ------------------ | ------------------------------------------- |
| A.1, A.2           | User Story 1, FR-003–FR-008, SC-001, SC-002 |
| A.3                | FR-009, SC-003                              |
| A.4 (a–e)          | FR-012, FR-012a, FR-012b, SC-008            |
| status / update    | User Story 2, FR-009–FR-011                 |
| Atomicity check    | FR-013, SC-005                              |
| Missing-tool check | FR-014                                      |
| C.1                | FR-013, FR-014                              |
| C.3                | User Story 3, FR-003, SC-006                |
| C.5                | FR-008, SC-004                              |
| D                  | User Story 4, FR-006, FR-017, SC-007        |
