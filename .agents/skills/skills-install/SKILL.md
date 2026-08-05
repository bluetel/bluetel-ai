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

**Project scaffolding.** Some skills need files outside those two roots to work at all — the
`speckit-*` family is inert without the `.specify/` templates and scripts its procedures run. Those
skills declare an **asset bundle**, and the helper seeds it into the target root, reporting each
path on a `#`-prefixed line:

```
# assets (speckit):
#   + .specify/templates/spec-template.md
#   = .specify/templates/plan-template.md (kept; differs from the bundle — --force to overwrite)
# assets (speckit): 11 file(s) written under /path/to/project
```

Bundle files are **data**: a missing one is seeded (so a target whose `.specify/` was deleted heals
by re-running install), and an existing one is never silently replaced. If any line reports `kept`,
surface it in the final summary — the project's copy has diverged from the catalog, and the user
decides whether to keep it or re-run with `--force`. Never hand-write these files yourself.

### 5. Handle already-installed selections

If any selected skill is `outdated` or in a conflict state, follow the **update flow** in the
"Updating" section below rather than `install`.

### 6. Configure per-repo conventions

Some skills (`pr-creation`, `merging`, `jira-ticket`, and any future workflow skills) are
repo-agnostic: they read this project's ticket prefix, branch pattern, staging branch, target repo,
and Jira coordinates from a small per-repo config file at `.agents/skills.config`. This config is
**data** — it is never hashed and never overwritten by an `update`, so it is safe to populate once.

Run this step **whenever a config-consuming skill (`pr-creation`, `merging`, or `jira-ticket`) is
among the skills installed or updated in this run.** Skip it otherwise, and skip it when there is no
interactive TTY.

**Only ask for the keys the installed skills actually use** — don't walk the Jira keys for a repo
that only installed `pr-creation`, and don't walk the git keys for a Jira-only install:

| Installed skill | Keys to walk                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------- |
| `pr-creation`   | `ticket_prefix`, `branch_pattern`, `commit_format`, `base_branch`, `repo_owner`, `repo_name` |
| `merging`       | the above plus `staging_branch`                                                              |
| `jira-ticket`   | `jira_site`, `jira_project_key`, `jira_board_id`, `jira_epic_key` (+ `ticket_prefix`)        |

**Only prompt when it is actually necessary** — the config is data and is preserved across updates,
so a repo that is already configured must not be re-nagged:

1. Show the current effective values (defaults until the user sets them):

   ```sh
   sh "$SKILLS_SNAPSHOT/lib/skills.sh" config show --target "$SKILLS_TARGET"
   ```

   Each line is `KEY<TAB>VALUE<TAB>SOURCE` where `SOURCE` is `default` or `set`.
   - **Fresh install** of a config-consuming skill → walk the keys (step 2).
   - **Update** of an already-configured repo (at least one key shows `SOURCE=set`) → **do not
     re-walk**. Print the current config for confirmation and continue; only prompt for a specific
     key if it still shows `SOURCE=default` **and** a newly updated skill now needs it (e.g. an
     update added a config key the file predates). Offer a one-line "want to change any of these?"
     escape hatch rather than stepping through every value.
   - **No config yet** (every key `SOURCE=default`) → walk the keys (step 2), same as a fresh install.

2. **Ask the user for each value** (only in the walk cases above), presenting the current value as the default they can accept
   with Enter. Pre-fill smart guesses where you can (e.g. infer `ticket_prefix` from recent
   `git branch --list` names or the project's `AGENTS.md` (then `CLAUDE.md`), and `repo_owner` / `repo_name` from
   `git remote get-url origin`). The keys:
   - `ticket_prefix` — ticket namespace (e.g. `BTAI`, `ACME`).
   - `branch_pattern` — feature-branch shape; keep the literal `{ticket}` placeholder (e.g. `feature/{ticket}`).
   - `commit_format` — commit subject shape; keep `{ticket}` and `{description}` (e.g. `{ticket}: {description}`).
   - `staging_branch` — branch feature work merges into (e.g. `staging`).
   - `base_branch` — branch PRs target (e.g. `main`).
   - `repo_owner` / `repo_name` — the GitHub target.

   Jira keys (only when `jira-ticket` is involved):
   - `jira_site` — Atlassian host (e.g. `bluetel.atlassian.net`).
   - `jira_project_key` — project key for new issues. **Defaults to `ticket_prefix`**, so accept the
     default unless the Jira project genuinely differs from the branch/ticket prefix.
   - `jira_board_id` — numeric board id, used to find the active sprint. No default; if the user
     doesn't know it, it's in the board URL (`…/boards/<id>`). Leaving it empty is fine — the sprint
     step is then skipped rather than guessed.
   - `jira_epic_key` — parent epic every new ticket is linked to (e.g. `ACME-100`). No default; empty
     means tickets are created without `--parent`.

   **Never** prompt for or store credentials. `JIRA_EMAIL` is per-user (shell profile) and the API
   token lives in the OS keychain — the config file is committed, so neither belongs there. If the
   user asks, point them at the setup notes in `jira-ticket/scripts/jira-sprint.sh`.

3. Write only the keys the user changed (unchanged keys keep their value automatically, and keys left
   at their default are deliberately not written out). **Quote each pair** so values containing
   spaces survive:

   ```sh
   sh "$SKILLS_SNAPSHOT/lib/skills.sh" config set \
     'ticket_prefix=ACME' 'branch_pattern=feature/{ticket}' 'repo_owner=acme' 'repo_name=web' \
     --target "$SKILLS_TARGET"
   ```

   The helper validates keys (unknown key → exit 1, nothing written) and rewrites the file
   atomically. If the config already exists and the user is happy with it, skip the write.

4. If `jira-ticket` was installed, note in the summary that it also needs the `acli` CLI
   (`acli jira auth`) plus `JIRA_EMAIL` + a keychain token before first use.

### 7. Recommend follow-up actions

Installing a skill is rarely the last thing a project needs: `speckit-*` is only half-configured
until the constitution is ratified, `jira-ticket` is inert until `acli` is authenticated. Each skill
states its own follow-up in its `skill.meta`, so **read them from the helper — never invent them**:

```sh
sh "$SKILLS_SNAPSHOT/lib/skills.sh" next-steps <names...> --catalog "$SKILLS_SNAPSHOT/catalog" --target "$SKILLS_TARGET"
```

Pass the skills installed or updated in this run. With no names it reports for every installed
skill — useful when the user asks "what else should I set up?" later. Each line is
`NAME<TAB>ACTION<TAB>WHY<TAB>WHEN`; identical recommendations are already deduped across skills, so
the nine `speckit-*` skills yield one constitution recommendation, not nine. (`install` and `update`
also print these as `# next: …` lines, so you may already have them.)

**`WHEN` is a precondition in prose, and checking it is your job** — the helper never evaluates it.
For each recommendation:

1. If `WHEN` is empty, the recommendation always applies.
2. Otherwise **check it against the actual project** before showing anything — run the command it
   names (`gh auth status`, `acli jira auth status`), grep the file it names, or inspect the config.
   If the project has already done it, **drop the recommendation silently**. A repo that authenticated
   `gh` months ago must not be told to authenticate `gh`.
3. Never run the action yourself. These are the user's decisions — several (ratifying a constitution,
   choosing a Jira epic) require judgement you do not have, and one (`/speckit-constitution`) starts a
   whole interactive workflow. Offer, and let them choose.

Present what survives as a short list, **`ACTION` first and `WHY` verbatim** — the reason is what
lets the user decide whether the step matters for their project rather than just following an
instruction. Don't paraphrase it into "recommended best practice". If nothing survives the checks,
say so in one line and move on; an already-configured project deserves silence, not a checklist.

**Group by `ACTION`.** The helper only dedupes lines that match on _both_ action and why, so one
action can arrive several times with different reasons — `gh auth status` is asked for by
`pr-creation`, `review`, and `speckit-taskstoissues`, each for its own reason. Present that as **one**
action carrying all of its reasons, not three near-identical bullets. And check its `WHEN` once: if
`gh` is already authenticated, the whole group disappears.

### 8. Final summary (SC-004)

After the helper runs, print a human summary:

- What was installed / updated / skipped / kept, with versions.
- The exact paths written (the helper prints these indented under each action line).
- Any project scaffolding seeded, plus any bundle file reported as `kept` (see step 4).
- The follow-up actions that survived step 7, if any.
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
4. If the update touched a config-consuming skill (`pr-creation` / `merging`), finish by running
   **step 6 (Configure per-repo conventions)** under its "necessary only" rule — it re-prompts only
   when the config is missing or a needed key is still at its default, never for an
   already-configured repo.
5. Then run **step 7 (Recommend follow-up actions)** for the updated skills. An update can introduce
   a new recommendation, and the `WHEN` checks keep already-done steps out of the way.
