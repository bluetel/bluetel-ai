---
name: skills-install
description: 'Interactively install, list, and update shared AI skills from the @bluetel-ai/skills catalog into the current project.'
argument-hint: 'Optional: space-separated skill names to install non-interactively'
---

# Install & Update Shared Skills

Your job is to help the user choose which shared skills to install (or update) into their
project, then materialize the selection deterministically via the shell helper. **All
deterministic work is done by `lib/skills.sh`** — you own conversation, selection, and the final
summary. Never hand-write skill files; always go through the helper.

This skill runs in two ways, and step 0 makes them equivalent:

- **From the bootstrap** (`curl … | sh`) — a fresh snapshot is already downloaded and the
  `SKILLS_*` env vars below are exported. Skip straight to step 1.
- **From an installed copy** — the user invoked this skill inside a target project (it was
  itself installed from the catalog). No snapshot exists yet, so **step 0 re-fetches one**.

## 0. Ensure a snapshot exists

If `SKILLS_SNAPSHOT` is already set and points at a dir containing `lib/skills.sh`, use it as-is
and continue to step 1.

Otherwise, re-fetch the catalog + helper from the recorded source. Read this skill's own install
record to learn where it came from, then shallow-sparse-clone only the `tooling/skills` subtree
into a temp dir (same approach as the bootstrap — no full monorepo, no history):

```sh
REC=".agents/skills/skills-install/.skill"
REPO=$(sed -n 's/^source_repo=//p' "$REC")
REF=$(sed -n 's/^source_ref=//p' "$REC")
[ -n "$REPO" ] || REPO="https://github.com/bluetel/bluetel-ai.git"
[ -n "$REF" ] || REF="main"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/skills-refresh.XXXXXX")
git clone --depth 1 --filter=blob:none --sparse --branch "$REF" "$REPO" "$TMP/repo" >/dev/null 2>&1
git -C "$TMP/repo" sparse-checkout set tooling/skills >/dev/null 2>&1

export SKILLS_SNAPSHOT="$TMP/repo/tooling/skills"
export SKILLS_TARGET="$PWD"
export SKILLS_SOURCE_REPO="$REPO"
export SKILLS_SOURCE_REF="$REF"
```

If the clone fails (bad ref, no network), stop and report it — change nothing. Clean up `$TMP`
when you finish.

## Environment

- `SKILLS_SNAPSHOT` — the snapshot's `tooling/skills/` dir. The helper is `$SKILLS_SNAPSHOT/lib/skills.sh`; the catalog is `$SKILLS_SNAPSHOT/catalog`.
- `SKILLS_TARGET` — the target project root (defaults to `$PWD`).
- `SKILLS_SOURCE_REPO`, `SKILLS_SOURCE_REF` — origin, recorded into each installed skill.

Every helper invocation uses the form:

```sh
sh "$SKILLS_SNAPSHOT/lib/skills.sh" <command> [names...] --catalog "$SKILLS_SNAPSHOT/catalog" --target "$SKILLS_TARGET"
```

## Procedure

### 1. Determine the mode

- If skill names were passed as arguments, treat them as an **explicit selection** (non-interactive).
- **Non-interactive guard (FR / research R10):** if there is **no interactive TTY** (e.g. piped, CI) **and** no explicit selection, do **not** prompt or hang. Print a clear message explaining the scriptable path and exit without changes:

  > No skills selected and no interactive terminal. Re-run with explicit names, e.g.
  > `sh lib/skills.sh install merging pr-creation --catalog … --target …`

### 2. List what's available

Run `list`:

```sh
sh "$SKILLS_SNAPSHOT/lib/skills.sh" list --catalog "$SKILLS_SNAPSHOT/catalog" --target "$SKILLS_TARGET"
```

Each line is `NAME<TAB>STATE<TAB>CATALOG_VERSION<TAB>INSTALLED_VERSION<TAB>DESCRIPTION`.

### 3. Present the selection (interactive)

Render each option as **`name — description`** (read from the `DESCRIPTION` column, never invented).
Group by state so the user understands the current situation:

- `not-installed` → available to install.
- `up-to-date` → already installed, current.
- `outdated` → installed, an update is available (`CATALOG_VERSION` > `INSTALLED_VERSION`).
- `locally-modified` / `inconsistent` / `unknown` → needs a conflict decision on update.

The user may pick **multiple** skills in one run. Confirm the selection before writing.
**If the user selects nothing, exit and change nothing** (spec AS-4).

**Self-service updates:** `skills-install` appears in the catalog like any other skill. Offer to
install it into the target so future installs/updates are a plain `/skills-install` invocation —
no `curl … | sh` needed. When it is installed, step 0 above re-fetches the catalog on demand.

### 4. Install fresh selections

For skills that are `not-installed`, run:

```sh
sh "$SKILLS_SNAPSHOT/lib/skills.sh" install <names...> --catalog "$SKILLS_SNAPSHOT/catalog" --target "$SKILLS_TARGET"
```

`requires` are expanded transitively and reported (`# also installing required: …`). Each
skill lands at `.agents/skills/<name>/` (content + `.skill` record) and `.claude/skills/<name>/` (stub).

### 5. Handle already-installed selections

If any selected skill is `outdated` or in a conflict state, follow the **update flow** in the
"Updating" section below rather than `install`.

### 6. Final summary (SC-004)

After the helper runs, print a human summary:

- What was installed / updated / skipped / kept, with versions.
- The exact paths written (the helper prints these indented under each action line).
- A **discoverability confirmation**: the skills are now available under `.claude/skills/<name>/`
  and their canonical content under `.agents/skills/<name>/`, so the user's agents can find them.

Report the helper's exit code faithfully. Non-zero codes mean something needs attention:
`2` catalog problem, `3` unresolved conflict, `4` write failure (rolled back), `5` missing tool,
`6` merge produced conflict markers.

## Updating (installed skills)

See the companion behavior for `status` / `update` / conflict resolution. In brief:

1. Run `status` to show current-vs-outdated for installed skills only.
2. For `outdated` skills the user selects, run `update <names>` — unselected skills are never touched.
3. For a `locally-modified` skill, present the three-way choice **keep / overwrite / resolve**
   _before any write_ and pass it via `--on-conflict`. After a `merge-conflict` (exit `6`), show
   the marked regions and, only if the user asks, offer a Claude-proposed resolution for them to
   review — never auto-apply it.
