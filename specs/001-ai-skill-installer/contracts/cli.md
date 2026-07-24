# Contract: `lib/skills.sh` shell helper

The deterministic core, a POSIX shell script run from the downloaded snapshot: `sh lib/skills.sh <command> [args]`. The install `SKILL.md` calls these; they are also directly runnable in tests/CI without Claude and without Node. Output is human/line-based (no JSON, no `jq`); Claude reads it and inspects the filesystem directly. Stable exit codes let both Claude and tests branch reliably.

## Global

- **Invocation**: `sh lib/skills.sh <command> [name...] [--force] [--on-conflict <mode>] [--target <dir>] [--catalog <dir>]`
- `--on-conflict <mode>` where `mode` ∈ `keep | overwrite | resolve`, governs how `install`/`update` treat a `locally-modified`/`inconsistent`/`unknown` skill. Omitted + interactive ⇒ the skill prompts; omitted + non-interactive ⇒ exit `3` (nothing changed). `--force` is a scriptable alias for `--on-conflict overwrite`.
- `--target <dir>` defaults to `$PWD` (the target project root).
- `--catalog <dir>` defaults to the snapshot's `catalog/` (resolved relative to the script). The script never fetches over the network — the bootstrap owns downloading (a shallow, sparse `git clone` of only `tooling/skills/`; see research R2).
- Requires on PATH: `sh`, `cp`, `mv`, `mkdir`, `rm`, `find`, `sort`, `awk`, `sed`, and `sha256sum` **or** `shasum`. The script probes for the hash tool and errors with guidance if neither is present.
- Runs under `set -eu`; a failed stage triggers rollback (see `install`/`update`).

### Exit codes

| Code | Meaning                                                                                               |
| ---- | ----------------------------------------------------------------------------------------------------- |
| 0    | Success (including "nothing to do").                                                                  |
| 1    | Usage error (bad args/flags).                                                                         |
| 2    | Catalog invalid or unreadable (missing `skill.meta`, bad `version`).                                  |
| 3    | Conflict needing a decision (locally-modified / inconsistent / unknown) and no resolution mode given. |
| 4    | Target write failure (rolled back — target left unchanged).                                           |
| 5    | Required tool missing (no `sha256sum`/`shasum`, etc.).                                                |
| 6    | `resolve` produced conflict markers — manual resolution required (record not advanced).               |

## `skills.sh list`

Lists catalog skills (scan of `catalog/*/skill.meta`) and, for the target, each one's state.

- **Output**: one line per skill — `NAME<TAB>STATE<TAB>CATALOG_VERSION<TAB>INSTALLED_VERSION<TAB>DESCRIPTION`.
- `STATE` ∈ `not-installed | up-to-date | outdated | locally-modified | inconsistent | unknown` (see data-model).
- Reads descriptions from `skill.meta` so the selection list can never drift from content (FR-014/FR-015).

## `skills.sh status`

Like `list` but only entries already present in the target (installed / inconsistent / unknown). Powers the update flow's "current vs outdated" view (FR-011).

## `skills.sh install <name...> [--force] [--on-conflict <mode>]`

Fresh-install the named skills into the target.

- **Preconditions**: each name exists in the catalog; each is `not-installed` (else it is reported as needing `update`, not duplicated — FR-009).
- **Behavior**: for each name, stage into `<target>/.agents/skills/.staging-<name>/`, then move content → `.agents/skills/<name>/`, generated stub → `.claude/skills/<name>/`, record → `.agents/skills/<name>/.skill`. Atomic per skill; on any failure, roll back every skill written in this invocation and exit `4`.
- **`requires`**: transitively include required skills; print the added set.
- **Output**: one line per skill — `NAME<TAB>ACTION<TAB>VERSION` where `ACTION` ∈ `install | update | skip | conflict | keep | merge | merge-conflict`, followed by an indented list of written paths.

## `skills.sh update <name...> [--force] [--on-conflict <mode>]` / `skills.sh update --all [...]`

Update already-installed skills to the catalog version.

- **Behavior**: `outdated` selected skills are overwritten (content + stub + record). `up-to-date` → `skip`. Unselected skills are never touched (FR-010). `--all` targets every installed `outdated` skill. Atomic + rollback as in `install`.
- **Conflicts** (`locally-modified` / `inconsistent` / `unknown`, FR-012/FR-012a/FR-012b): resolved by `--on-conflict <mode>` (interactive prompt if omitted, exit `3` if non-interactive and omitted):
  - `keep` → `ACTION=keep`, files untouched.
  - `overwrite` (or `--force`) → `ACTION=update`, incoming version written.
  - `resolve` → three-way `git merge-file` with base re-fetched from `catalog/<name>` at the record's `source_ref` (research R11). Non-overlapping ⇒ `ACTION=merge`, record advanced. Overlapping ⇒ `ACTION=merge-conflict`, file written with conflict markers, record **not** advanced, exit `6`. If the base is unobtainable ⇒ report merge unavailable, write `<file>.incoming` sidecar, and fall back to the keep/overwrite decision.
- **Output**: same shape as `install`.

## Behaviors the SKILL.md layers on top

- Interactive selection + confirmation prompts (not the script's job).
- Non-interactive guard: if there is no TTY and no explicit selection, fail clearly rather than hang (FR — non-interactive edge case).
- Final human summary of what was installed/updated and where (SC-004).

## Contract test expectations (vitest shells out to `skills.sh`)

- `list` on a clean target reports every catalog skill as `not-installed`.
- `install merging` then `list` reports `merging` `up-to-date`; files exist at `.agents/skills/merging/{SKILL.md,.skill}` and `.claude/skills/merging/SKILL.md`; nothing written outside `.agents`/`.claude` (SC-002).
- Re-running `install merging` exits `0` with the skill routed to `skip`/`update`, never duplicated (SC-003).
- Editing the installed `SKILL.md` then `update merging` (no mode) reports `conflict`, leaves the file unchanged, exits `3` (FR-012).
- `update merging --on-conflict keep` reports `keep`, leaves the file byte-for-byte unchanged, exits `0`.
- `update merging --on-conflict overwrite` (and `--force`) reports `update`, writes the incoming version, exits `0`.
- `update merging --on-conflict resolve` with a **non-overlapping** local edit + bumped catalog version reports `merge`, the file contains both changes with no conflict markers, record advanced, exits `0` (FR-012b).
- `update merging --on-conflict resolve` with an **overlapping** edit reports `merge-conflict`, the file contains `<<<<<<<`/`=======`/`>>>>>>>` markers, the record is **not** advanced, exits `6` (FR-012b).
- Bumping a catalog `skill.meta` `version` flips the skill to `outdated` in `status`.
- A write forced to fail mid-run leaves the target byte-for-byte unchanged and exits `4` (SC-005).
- Removing `sha256sum`/`shasum` from PATH exits `5` with guidance.
