<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

# General Guidelines for working with Nx

- For navigating/exploring the workspace, invoke the `nx-workspace` skill first - it has patterns for querying projects, targets, and dependencies
- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- Prefix nx commands with the workspace's package manager (e.g., `pnpm nx build`, `npm exec nx test`) - avoids using globally installed CLI
- You have access to the Nx MCP server and its tools, use them to help the user
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`. Not all plugins have this file - proceed without it if unavailable.
- NEVER guess CLI flags - always check nx_docs or `--help` first when unsure

## Scaffolding & Generators

- For scaffolding tasks (creating apps, libs, project structure, setup), ALWAYS invoke the `nx-generate` skill FIRST before exploring or calling MCP tools

## When to use nx_docs

- USE for: advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- DON'T USE for: basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally - don't call nx_docs just to look up generator syntax

<!-- nx configuration end-->

# Linting

Two layers. Neither is optional, and they enforce disjoint rule sets — a rule belongs to
exactly one of them.

| Layer | Tool | Rules | Nx target | Runs |
| --- | --- | --: | --- | --- |
| Per-file | oxlint (+ `oxlint-tsgolint`) | 142 | `lint` | `lint-staged` on every commit, CI, and on demand |
| Workspace | ESLint | 4 | `lint-workspace` | pre-commit via `nx affected`, and CI |

**Use `pnpm lint:fast` while editing.** It is `oxlint --type-aware .` over the whole
repository — about 1.5 s, including every type-aware rule. There is no reason to reach for a
narrower command.

- `pnpm lint` — both layers, with `--fix` on the oxlint layer only.
- `pnpm lint:check` — both layers, no fixing.
- `pnpm lint-inventory` — regenerate `specs/005-oxlint-lint-performance/rule-inventory.md`.

## Adding a rule

Add it to the **oxlint** layer, in the root `.oxlintrc.json`:

- a rule needing type information goes in the `**/*.{ts,tsx}` override;
- a rule with no native oxlint implementation goes through the JS plugin API — add the plugin
  under `tooling/oxlint-config/plugins/` and register it in `jsPlugins`;
- **always give a rule its options.** Several rules (`restrict-plus-operands`,
  `restrict-template-expressions`) fire on nothing at oxlint's defaults, so a rule added by
  name alone can be enabled, green, and doing nothing.
- **never enable a category.** `categories` is explicitly `off` for all seven; enabling one
  lights up existing code with rules nobody chose.

The ESLint layer is for rules oxlint cannot run at all: it currently holds
`@nx/enforce-module-boundaries` (needs the Nx project graph), `@cspell/spellchecker` (no
oxlint equivalent), `no-octal` and `no-dupe-args` (not implemented). Adding anything else
there needs a reason recorded in `tooling/lint-coverage/src/owners.ts`.

## Proving a rule still runs

`tooling/lint-coverage` plants a violation of every enforced rule and asserts the rule ID
appears in the diagnostics. A green lint run is not evidence on its own: a rule that silently
stopped running looks exactly like clean code. If you move a rule between layers, add or
update its fixture in `tooling/lint-coverage/src/fixtures.ts` in the same change.
