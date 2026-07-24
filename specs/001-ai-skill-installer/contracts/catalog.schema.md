# Contract: Catalog, Record & Stub Formats

The persisted shapes exchanged between the source repo (produces the catalog), the shell helper (`lib/skills.sh`), and targets (hold records). All formats are **shell-parseable** — `KEY=value` files and Markdown — so the target needs no `jq` and no Node.

## `skill.meta` (source: `tooling/skills/catalog/<name>/skill.meta`)

One file per skill; the sole metadata the catalog scan reads.

```sh
name=merging
version=1.2.0
description=Merging a feature branch into staging. Use when: user explicitly asks to merge into staging or deploy to staging.
argument_hint=The feature branch name to merge into staging
requires=
```

**Rules**:

- `name` — kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`), must equal the directory name.
- `version` — semver `MAJOR.MINOR.PATCH` (`^[0-9]+\.[0-9]+\.[0-9]+$`).
- `description` — single line (no newlines); becomes the stub's `description`.
- `argument_hint` — optional; single line; becomes the stub's `argument-hint` when non-empty.
- `requires` — optional; space-separated skill names; each must exist in the catalog.
- Parsed with `while IFS='=' read -r key val`; unknown keys ignored; `#` comment lines skipped.
- **Content files** = every file under `catalog/<name>/` **except** `skill.meta` (always includes `SKILL.md`). A directory with no `SKILL.md` or no valid `skill.meta` is a catalog error (exit `2`).

## Installed record (target: `.agents/skills/<name>/.skill`)

Written by `install`/`update`; read on later runs to derive state.

```sh
name=merging
version=1.2.0
installed_hash=9f2c…64hex
source_repo=harrytwigg/universal-react-monorepo
source_ref=v1.4.0
installed_at=2026-07-23T10:15:00Z
```

**Rules**:

- Present and parseable ⇒ skill is installed. `version` + `installed_hash` drive update/local-mod detection.
- Missing or lacking `version`/`installed_hash` ⇒ state `unknown` (never treated as up-to-date; prompt before overwrite).
- `installed_at` — ISO-8601 UTC, stamped by the helper at write time (`date -u +%Y-%m-%dT%H:%M:%SZ`).
- Excluded from the content hash (see below).

## Generated stub (target: `.claude/skills/<name>/SKILL.md`)

Markdown with YAML frontmatter, produced by `skills.sh` from `skill.meta`:

```markdown
---
name: <name>
description: '<skill.meta description>'
argument-hint: '<skill.meta argument_hint — line omitted entirely if empty>'
---

> **IMPORTANT:** You MUST read and follow the shared skill file at `.agents/skills/<name>/SKILL.md` for the full procedure.
```

Single-quotes in `description`/`argument_hint` are escaped (`'` → `''`) when emitting YAML.

## `installed_hash` definition (single implementation, shell)

Computed identically at install time and at every later re-check, so the recorded baseline and the current value are directly comparable (local-modification detection):

```sh
# _sha256 picks the available tool once:
#   sha256sum        -> `sha256sum | cut -d' ' -f1`
#   shasum (macOS)   -> `shasum -a 256 | cut -d' ' -f1`
skill_hash() {          # args: <dir>
  cd "$1" || return 1
  find . -type f ! -name skill.meta ! -name .skill | LC_ALL=C sort | while IFS= read -r f; do
    printf '%s\0' "$f"   # relative path + NUL separator
    cat "$f"             # raw bytes
  done | _sha256
}
```

- Files are sorted with `LC_ALL=C sort` for a stable, locale-independent order.
- `skill.meta` (source) and `.skill` (target record) are **excluded** so metadata never affects the hash.
- Because the same `skill_hash` runs on the source content (at install, to record `installed_hash`) and on the target content (at re-check), no separate source-side hash needs to be published — update-availability uses the semver `version`, local modification uses the recorded `installed_hash`.

## Optional external manifest (not on the install path)

A `catalog.json` MAY be generated in the source repo for external consumers/humans, but the installer never reads it — the directory scan of `catalog/*/skill.meta` is authoritative, which keeps the available list in lockstep with the actual content (FR-014/FR-015).
