# Shared Skills

Shared skill definitions used across multiple AI agents (Kiro, Claude, Copilot, etc.).

## Canonical content lives in the skills catalog

The canonical content for each shared skill now lives in the **`@chalkboard/skills` catalog**:

```
tooling/skills/catalog/<skill-name>/
├── SKILL.md      # canonical procedure
├── skill.meta    # KEY=value metadata (name, version, description, argument_hint?, requires?)
└── …             # any supporting files (e.g. references/)
```

This is the **single distribution source** — the same catalog the installer publishes to other
projects (see [tooling/skills/README.md](../../tooling/skills/README.md)). Keeping the content in
one place means the source repo's own agents and every installed target share exactly the same
procedure, with no drift.

## How It Works

1. **Shared content** lives in `tooling/skills/catalog/<skill-name>/SKILL.md`.
2. **Agent-specific stubs** in each agent's skills directory retain their own frontmatter (name,
   description, triggers) but point to the catalog file:

   ```markdown
   > **IMPORTANT:** You MUST read and follow the shared skill file at `tooling/skills/catalog/<skill-name>/SKILL.md` for the full procedure.
   ```

3. Agents that have **unique procedures** (e.g. `.github/skills/pr-creation` with CI build steps)
   keep their own full content — only truly duplicated skills are shared.

## Adding a New Shared Skill

1. Create `tooling/skills/catalog/<skill-name>/` with a `SKILL.md` (canonical procedure) and a
   `skill.meta` (`name`, semver `version`, single-line `description`, optional `argument_hint`,
   optional space-separated `requires`).
2. In each agent's skills directory, create a stub with the appropriate frontmatter and a pointer
   to the catalog file (see above).
