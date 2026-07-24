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
curl -fsSL https://raw.githubusercontent.com/bluetel/bluetel-ai/main/tooling/skills/bootstrap/install.sh | sh
```

The bootstrap verifies prerequisites, shallow-sparse-clones only this `tooling/skills/` subtree
into a temp dir, and launches Claude on the `skills-install` skill. Override the source with
`SKILLS_REPO_URL` / `SKILLS_REPO_REF` env vars.

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

## Publishing (maintainers)

The catalog **is** the set of directories under `catalog/` — there is no build or publish
pipeline. To make new/updated skills available to targets:

1. Add or edit a skill under `catalog/<name>/` (a `SKILL.md` + a `skill.meta` with a bumped
   semver `version` whenever content changes — that version drives "update available").
2. Commit and push to the branch/tag the bootstrap pins (`SKILLS_REPO_REF`, default `main`).
   Pin a **release tag** for a stable snapshot so a target's catalog and content never disagree
   mid-run; point `SKILLS_REPO_REF` at that tag in the published one-liner.
3. `pnpm nx test skills` / `pnpm nx typecheck skills` must pass — the tests validate `skill.meta`
   and the shell contract.

## Source-repo / CI only

The TypeScript + `vitest` surface here exists solely to test the shell logic in CI (`pnpm nx
test skills`, `pnpm nx typecheck skills`). Nothing Node-based is shipped to or executed on a
target. Tests shell out to `lib/skills.sh` against throwaway temp targets.
