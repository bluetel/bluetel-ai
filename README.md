# bluetel-ai

Demonstrating AI capabilities for use across bluetel.

## Skills Auto-Installer

Pulls curated Claude skills from this repo's catalog into any target project with a single command — no clone of the monorepo, no Node required on the target.

```sh
TMP=$(mktemp -d) && git clone -q --depth 1 --filter=blob:none --sparse https://github.com/bluetel/bluetel-ai.git "$TMP" && git -C "$TMP" sparse-checkout set --no-cone /tooling/skills/bootstrap/install.sh && sh "$TMP/tooling/skills/bootstrap/install.sh"; rm -rf "$TMP"
```

**Prerequisite:** the [Claude CLI](https://docs.claude.com/en/docs/claude-code) must be installed — it drives the install via `git`/`curl` on your behalf.
