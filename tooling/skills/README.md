# @bluetel-ai/skills

The **single distribution source** for this repo's shared AI skills. Any target project pulls
selected skills from here with a one-command installer — no clone of the whole monorepo, no
Node on the target.

## Layout

| Folder       | Purpose                                                                                                                                                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog/`   | Canonical skill content. One dir per skill (`<name>/SKILL.md` + `skill.meta`). The catalog **is** the directory scan — no manifest file. This includes `skills-install/`, the interactive install procedure, so it is itself an installable skill. |
| `bootstrap/` | `install.sh` — the one publishable file (`curl … \| sh`). Verifies tools, shallow-sparse-clones this subtree, launches Claude on `catalog/skills-install/SKILL.md`.                                                                                |
| `lib/`       | `skills.sh` — the deterministic POSIX-shell core (`list`/`status`/`install`/`update`) + colocated vitest shell-out tests.                                                                                                                          |
| `assets/`    | Shared **asset bundles** — project scaffolding a skill needs outside `.agents/`/`.claude/` (currently `speckit/`, holding the `.specify/` tree the `speckit-*` skills drive). See below.                                                           |

## Target requirements

The installer runs entirely as **Claude driving `git` / `curl` / POSIX shell** — there is
**no target-side Node, `jq`, or `tar`**. A target needs only:

- the **Claude CLI**,
- **`git` ≥ 2.27** (shallow partial clone + sparse-checkout),
- **`curl`**,
- base POSIX utilities and **`sha256sum` or `shasum`**.

## Installing skills into another project

From the target project root, run the published one-liner:

```sh
TMP=$(mktemp -d) && git clone -q --depth 1 --filter=blob:none --sparse https://github.com/bluetel/bluetel-ai.git "$TMP" && git -C "$TMP" sparse-checkout set --no-cone /tooling/skills/bootstrap/install.sh && sh "$TMP/tooling/skills/bootstrap/install.sh"; rm -rf "$TMP"
```

The bootstrap verifies prerequisites, shallow-sparse-clones only this `tooling/skills/` subtree
into a temp dir, and launches Claude on the `skills-install` skill. Override the source with
`SKILLS_REPO_URL` / `SKILLS_REPO_REF` env vars, or the equivalent `--repo <url>` / `--branch <ref>`
flags:

```sh
TMP=$(mktemp -d) && git clone -q --depth 1 --filter=blob:none --sparse https://github.com/bluetel/bluetel-ai.git "$TMP" && git -C "$TMP" sparse-checkout set --no-cone /tooling/skills/bootstrap/install.sh && sh "$TMP/tooling/skills/bootstrap/install.sh" --branch <branch-name>; rm -rf "$TMP"
```

This is the fast path for developing a skill: push your changes to a branch, then point a test
project's installer at it directly — no need to merge to `main` first, and no env vars to
remember to unset afterwards.

**Self-service updates (no `curl`):** `skills-install` is itself a catalog skill, so a target can
install it once (via the one-liner above) and thereafter run `/skills-install` directly. When
invoked from an installed copy, it re-fetches a fresh catalog snapshot on demand (using the
`source_repo` / `source_ref` recorded in its `.skill`), then runs the same list/install/update
flow — closing the loop without re-piping the bootstrap.

**Non-interactive / scripted** (no Claude, directly against the catalog):

```sh
sh lib/skills.sh install merging pr-creation --catalog ./catalog --target /path/to/project
sh lib/skills.sh update --all --catalog ./catalog --target /path/to/project
```

## Per-repo configuration

Workflow skills (`pr-creation`, `merging`, `jira-ticket`) are **repo-agnostic**: the ticket prefix,
branch pattern, staging/base branch, GitHub target, and Jira coordinates differ per project, so
those values live in a small `.agents/skills.config` (`key=value`) file in the target — **not** baked
into the skill content. This keeps every installed skill byte-identical to the catalog, so the
hash-based update model never sees a personalised repo as "locally-modified". The config is data:
never hashed, never overwritten by `update`.

`skills-install` prompts for these values during install (step 6) whenever a config-consuming skill
is installed, asking only for the keys those skills actually use. You can also manage them directly:

```sh
sh lib/skills.sh config show                 # KEY<TAB>VALUE<TAB>SOURCE (default|set)
sh lib/skills.sh config get branch_pattern
sh lib/skills.sh config set 'ticket_prefix=ACME' 'repo_owner=acme' --target /path/to/project
```

| Key                | Default                        | Used by                      |
| ------------------ | ------------------------------ | ---------------------------- |
| `ticket_prefix`    | `BTAI`                         | `pr-creation`, `merging`     |
| `branch_pattern`   | `feature/{ticket}`             | `pr-creation`, `merging`     |
| `commit_format`    | `{ticket}: {description}`      | `pr-creation`, `merging`     |
| `staging_branch`   | `staging`                      | `merging`                    |
| `base_branch`      | `main`                         | `pr-creation`, `merging`     |
| `repo_owner`       | `bluetel`                      | `pr-creation`, `merging`     |
| `repo_name`        | `bluetel-ai`                   | `pr-creation`, `merging`     |
| `jira_site`        | `bluetel.atlassian.net`        | `jira-ticket`                |
| `jira_project_key` | _derived from_ `ticket_prefix` | `jira-ticket`                |
| `jira_board_id`    | _(empty)_                      | `jira-ticket` (sprint moves) |
| `jira_epic_key`    | _(empty)_                      | `jira-ticket` (`--parent`)   |

Only explicitly-set keys are written to the file; anything absent resolves to the default, so
derived values (`jira_project_key`) keep tracking their source. Keys with an empty default have no
sensible cross-repo value — the consuming skill asks rather than guessing, and degrades gracefully
(no `jira_board_id` → the sprint step is skipped, not guessed). Skills substitute `{ticket}` /
`{description}` per task.

**Credentials are never stored here** — the file is committed. `JIRA_EMAIL` is per-user (shell
profile) and the Jira API token lives in the OS keychain; see the header of
`catalog/jira-ticket/scripts/jira-sprint.sh` for the one-time setup.

## Asset bundles (project scaffolding)

Most skills are self-contained: a `SKILL.md` is all the agent needs. Some are not. The
`speckit-*` family drives a **Spec Kit** project — its procedures run `.specify/scripts/bash/*.sh`
and read `.specify/templates/*.md` — so installing those skills into a project that has never run
the Spec Kit CLI leaves them inert, pointing at files that do not exist.

A skill declares the scaffolding it needs with an `assets=<bundle>` key in its `skill.meta`. A
bundle is a directory under `assets/` whose file tree is laid out **relative to the target root**:

```
assets/speckit/
  .specify/templates/*.md        → <target>/.specify/templates/*.md
  .specify/scripts/bash/*.sh     → <target>/.specify/scripts/bash/*.sh
  .specify/memory/constitution.md → <target>/.specify/memory/constitution.md
```

Bundle files are **data, like `.agents/skills.config`** — Spec Kit's templates are meant to be
tailored per project (`/speckit-constitution` rewrites them in place), so:

- they are **never hashed** into the skill's content hash — editing a template never flips a skill
  to `locally-modified`;
- a **missing** file is seeded, on `install` _and_ on `skip`/`update`, so a target whose `.specify/`
  was deleted heals by re-running the installer;
- an **existing** file that differs from the bundle is **kept** and reported, never silently
  replaced. `--force` (`--on-conflict overwrite`) replaces it;
- only files created in this run are removed if the install rolls back — a pre-existing file is
  never touched.

Several skills may share one bundle (all nine `speckit-*` skills do); it is seeded once per run.

## Post-install recommendations

Installing a skill is rarely the last thing a project needs — `speckit-*` is only half-configured
until the constitution is ratified, `jira-ticket` is inert until `acli` is authenticated. Each skill
states its own follow-up in its `skill.meta`, as one or more repeatable lines:

```
next_step=<action>|<why>[|<when>]
```

| Field    | Meaning                                                                                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action` | The concrete thing to do — `/speckit-constitution`, `gh auth status`, `Set jira_board_id`.                                                                                   |
| `why`    | Why it matters. Shown **verbatim**, so the user can judge whether it applies to their project instead of following an instruction blindly.                                   |
| `when`   | _Optional._ A precondition **in prose**. The shell never evaluates it — the agent checks it and drops steps the project has already done, so a configured repo isn't nagged. |

`install` and `update` print them as `# next: …` advisory lines; `next-steps` emits them as plain
TSV (`NAME<TAB>ACTION<TAB>WHY<TAB>WHEN`) for an agent to consume:

```sh
sh lib/skills.sh next-steps                       # every installed skill
sh lib/skills.sh next-steps speckit-plan review   # just these
```

Recommendations are **deduped by `action`+`why`**, so all nine `speckit-*` skills asking for
`/speckit-constitution` produce one line, not nine. Matching on both fields means one action can
still appear more than once when the reasons genuinely differ (`gh auth status` matters to
`pr-creation`, `review`, and `speckit-taskstoissues` for three different reasons) — `skills-install`
groups those into one action carrying all its reasons when it presents them.

That step also checks each `when` against the real project and presents only what survives. It never
runs the action itself: these are the user's decisions, and `/speckit-constitution` is a whole
interactive workflow.

## Publishing (maintainers)

The catalog **is** the set of directories under `catalog/` — there is no build or publish
pipeline. To make new/updated skills available to targets:

1. Add or edit a skill under `catalog/<name>/` (a `SKILL.md` + a `skill.meta` with a bumped
   semver `version` whenever content changes — that version drives "update available"). If the
   skill needs project scaffolding, add it under `assets/<bundle>/` and point at it with
   `assets=<bundle>`; a declared bundle that does not exist is a catalog error (exit `2`).
2. Commit and push to the branch/tag the bootstrap pins (`SKILLS_REPO_REF`, default `main`).
   Pin a **release tag** for a stable snapshot so a target's catalog and content never disagree
   mid-run; point `SKILLS_REPO_REF` at that tag in the published one-liner.
3. `pnpm nx test skills` / `pnpm nx typecheck skills` must pass — the tests validate `skill.meta`
   and the shell contract.

## Source-repo / CI only

The TypeScript + `vitest` surface here exists solely to test the shell logic in CI (`pnpm nx
test skills`, `pnpm nx typecheck skills`). Nothing Node-based is shipped to or executed on a
target. Tests shell out to `lib/skills.sh` against throwaway temp targets.
