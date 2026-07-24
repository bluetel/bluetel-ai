# Phase 1 Data Model: AI Skill Installer

Entities are file-based, all **shell-parseable** (`KEY=value` files + Markdown) so the target needs no JSON parser, no `jq`, and no Node. Authoritative formats live in [contracts/catalog.schema.md](./contracts/catalog.schema.md).

## Catalog acquisition (how the data reaches the target) — MUST for the plan

The catalog data is **not** bundled with the bootstrap and **not** downloaded as an archive. The bootstrap MUST obtain it with a **shallow, sparse `git clone`** of the source repo at a pinned ref, checking out **only the required directories** — the `tooling/skills/` subtree — into a temp dir:

```sh
git clone --depth 1 --filter=blob:none --sparse \
  --branch "<ref>" https://github.com/harrytwigg/universal-react-monorepo.git "$TMP"
git -C "$TMP" sparse-checkout set tooling/skills   # only the required dirs; narrow to catalog/<name> once selected
```

- `--depth 1` → no git history.
- `--filter=blob:none --sparse` + `sparse-checkout set tooling/skills` → fetch/checkout **only the required directories**, not the whole monorepo.
- The clone lands in a temp dir; the install proceeds only if it completes (preserves the no-partial-install guarantee).
- Target dependency: `git` ≥ 2.27. Rationale and alternatives in [research.md](./research.md) R2.

The rest of this document describes the data once it is present in that snapshot (source side) and in the target project (installed side).

## Catalog (directory-based)

The catalog is not a manifest file — it **is** the set of directories under `tooling/skills/catalog/`. Listing = scanning `catalog/*/skill.meta`. This makes the available list inherently in sync with the content (FR-014/FR-015).

## SkillCatalogEntry (`catalog/<name>/`)

One directory per installable skill.

| Part           | Source                  | Notes                                                                |
| -------------- | ----------------------- | -------------------------------------------------------------------- |
| `name`         | `skill.meta` + dir name | Kebab-case; must equal the directory name; unique.                   |
| `description`  | `skill.meta`            | One line; shown at selection and written into the stub.              |
| `version`      | `skill.meta`            | Semver; bumped whenever content changes → drives "update available". |
| `argumentHint` | `skill.meta` (optional) | Passed through to the stub frontmatter when present.                 |
| `requires`     | `skill.meta` (optional) | Space-separated skill names; must reference existing entries.        |
| content files  | files in the dir        | Everything except `skill.meta`; always includes `SKILL.md`.          |

**Validation**: valid `skill.meta` (kebab `name`, semver `version`, single-line `description`); `SKILL.md` present; `requires` resolve. A malformed entry is a catalog error (CLI exit `2`). No source-side content hash is stored — see SkillState.

**State**: catalog entries are immutable within a downloaded snapshot; they change only when the source repo republishes at a new ref.

## InstalledSkillRecord (`.agents/skills/<name>/.skill` in the target)

Per-skill `KEY=value` record written into the target so later runs detect install vs update and local modification.

| Field                       | Notes                                                                         |
| --------------------------- | ----------------------------------------------------------------------------- |
| `name`                      | Matches the catalog entry.                                                    |
| `version`                   | Catalog version at install/update time.                                       |
| `installed_hash`            | `sha256` of the files as written — baseline for local-modification detection. |
| `source_repo`, `source_ref` | Origin of the snapshot.                                                       |
| `installed_at`              | ISO-8601 UTC, stamped at write time.                                          |

**Validation**: present + parseable ⇒ installed. Missing/lacking `version` or `installed_hash` ⇒ `unknown` (never treated as up-to-date; prompt before overwrite).

## SkillState (derived, not stored)

Computed from catalog `version` + on-disk content hash + record. Drives what the helper reports and what the skill offers.

| State              | Condition                                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `not-installed`    | No record and no content in the target.                                                                           |
| `up-to-date`       | Record present, `record.version == catalog.version`, current hash == `record.installed_hash`.                     |
| `outdated`         | Record present, `catalog.version > record.version` (awk semver compare), current hash == `record.installed_hash`. |
| `locally-modified` | Record present, current hash != `record.installed_hash` (any version).                                            |
| `inconsistent`     | `.agents` content and `.claude` stub disagree (one missing), or content exists without a record.                  |
| `unknown`          | Content + record exist but the record lacks `version`/`installed_hash`.                                           |

## InstallAction (derived, not stored)

Per-skill plan the helper produces from `SkillState` + user intent, emitted as `NAME<TAB>ACTION<TAB>VERSION` lines.

| Action           | When                                                                           | Effect                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `install`        | `not-installed`, selected.                                                     | Write content + stub + record.                                                                                       |
| `update`         | `outdated`, selected.                                                          | Overwrite content + stub, rewrite record.                                                                            |
| `skip`           | `up-to-date`, or not selected.                                                 | No change.                                                                                                           |
| `conflict`       | `locally-modified` / `inconsistent` / `unknown`, and no resolution mode given. | Reported and left untouched; caller must pick a resolution (`--on-conflict`). Exit `3`.                              |
| `keep`           | conflict + resolution `keep`.                                                  | Local files left byte-for-byte unchanged; update skipped for this skill.                                             |
| `merge`          | conflict + resolution `resolve`, no overlapping hunks.                         | Incoming changes merged onto local via 3-way `git merge-file`; content + stub + record rewritten to the new version. |
| `merge-conflict` | conflict + resolution `resolve`, overlapping hunks.                            | Merged file written **with conflict markers**; record **not** advanced; manual resolution required. Exit `6`.        |

Resolution mode (`keep` / `overwrite` / `resolve`) is chosen interactively by the skill or passed via `--on-conflict`; `overwrite` maps to the `update` effect (`--force` is its alias). See [research.md](./research.md) R11 and [contracts/cli.md](./contracts/cli.md).

### Merge base (for `resolve`)

A three-way merge needs the version as **originally installed** as its base. It is not stored in the target; it is reconstructed on demand by a shallow sparse checkout of `catalog/<name>` at the record's `source_ref` (the same clone mechanism as the acquisition section above, narrowed to one skill). If the base cannot be obtained (offline, ref removed, missing `source_ref`), `resolve` is unavailable and the choice degrades to `keep` / `overwrite`, with the incoming version written to a `<file>.incoming` sidecar for manual merge.

## Relationships

```text
catalog/  ─contains─*  SkillCatalogEntry (dir + skill.meta)
SkillCatalogEntry  1───0..1  InstalledSkillRecord   (matched by name, in a target)
(catalog version + on-disk hash + record) ──▶ SkillState ──▶ InstallAction
```

## Target on-disk layout (per installed skill)

```text
<target>/
├── .agents/skills/<name>/
│   ├── SKILL.md            # canonical content (verbatim from catalog)
│   ├── …supporting files…  # remaining catalog content files
│   └── .skill              # InstalledSkillRecord (KEY=value)
└── .claude/skills/<name>/
    └── SKILL.md            # generated activation stub (frontmatter + pointer)
```
