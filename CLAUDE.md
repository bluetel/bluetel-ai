# Universal React Monorepo

## Commands

- Build: `pnpm build` (nx run-many -t build)
- Typecheck: `pnpm typecheck`
- Lint: `pnpm lint` (eslint --fix via nx)
- Lint check only: `pnpm lint:check`
- Format: `pnpm format` (prettier --write via nx)
- Test: `pnpm test`
- Dev: `pnpm dev`
- Dead code: `pnpm knip`

## Stack

- TypeScript (strict), Node v24
- Nx monorepo with pnpm workspaces
- React 19, functional components only
- Next.js (web), React Native (mobile)
- SST for infrastructure
- Husky + commitlint for git hooks

## Git Workflow

- Feature branches: `feature/URM-XXX`
- PRs target `main`; merges to `staging` are direct (not via PR)
- Never rebase staging onto feature branch — always `git merge --no-ff`
- Never merge a PR — user merges PRs to main manually
- Commits use conventional format: `URM-XXX: description`

## Rules

- Named exports, never default exports
- Tests colocated: `foo.ts` → `foo.test.ts` in same directory
- Public API exported through `index.ts` barrel files
- No `.js` extensions in imports
- Break large files into focused modules with single responsibility

<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

## General Guidelines for working with Nx

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
