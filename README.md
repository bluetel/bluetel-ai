# bluetel-ai

Demonstrating AI capabilities for use across bluetel.

## Skills Auto-Installer

Pulls curated Claude skills from this repo's catalog into any target project with a single command — no clone of the monorepo, no Node required on the target.

```sh
TMP=$(mktemp -d) && git clone -q --depth 1 --filter=blob:none --sparse https://github.com/bluetel/bluetel-ai.git "$TMP" && git -C "$TMP" sparse-checkout set --no-cone /tooling/skills/bootstrap/install.sh && sh "$TMP/tooling/skills/bootstrap/install.sh"; rm -rf "$TMP"
```

**Prerequisite:** the [Claude CLI](https://docs.claude.com/en/docs/claude-code) must be installed — it drives the install via `git`/`curl` on your behalf.

**Tip:** run `gh auth setup-git` once beforehand so `git` reuses your GitHub CLI credentials. Without it, the `git clone` inside `install.sh` can stop midway to prompt for authentication.

## Prompt Quality Gate

Checks this repo's AI-authored artifacts — the skill catalog, the installed skill trees, the repo-level agent guidance, the Spec Kit templates and the constitution — against a rule catalogue. It runs in `.husky/pre-commit` and blocks any pull request whose artifacts break a rule.

```sh
pnpm prompt-lint       # every declared artifact
pnpm prompt-lint:diff  # only the artifacts this branch changed
```

### Prerequisites

- **Node and pnpm** — the Node version in `.nvmrc`, and the pnpm version in `package.json`'s `packageManager` field. `pnpm install` is all the setup there is: the rules run in this workspace's own process, so there is no separate binary or language runtime to provide.
- **The base ref, fetched** — `pnpm prompt-lint:diff` scopes itself to the diff against `origin/main` (override with `PROMPT_LINT_BASE_REF`). On a shallow clone that ref does not resolve, and the gate exits `4` — _scope could not be established_ — rather than reporting a clean pass over the zero artifacts it managed to look at. Fetch the base ref (`git fetch --no-tags origin main`), or run `pnpm prompt-lint` to evaluate the whole declared set regardless of git state.
