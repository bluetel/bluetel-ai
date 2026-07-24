# AI Agent Guidelines

This document describes the conventions and processes for AI agents working on this repository.

## Branch Naming Conventions

All branches must follow these patterns:

- `main` - Production branch (direct commits discouraged)
- `staging` - Staging branch
- `feature/<name>` - Feature branches (e.g., `feature/add-login`, `feature/URM-123-implement-auth`)

Branch names should follow these patterns for consistency across the repo.

## Commit Message Conventions

Commit messages must follow this format:

- **Ticket branches** (`feature/URM-123-*`): `URM-123: <description>`
- **Feature branches** (`feature/<name>` without ticket): `feature/<name>: <description>`
- **Protected branches** (`main`, `staging`): `<branch>: <description>` (though direct commits are bad practice)
- **Auto-generated commits**: `Merge ...`, `Revert ...`, `Amend ...`, `fixup! ...`, `squash! ...` are auto-allowed

Examples:

```bash
# ✅ Valid
URM-123: add user authentication
feature/add-login: implement login form
main: hotfix critical security issue

# ❌ Invalid (will fail CI)
fix: something
feat: add feature
URM-123 add missing colon
```

## Validation

- **Local**: Husky `commit-msg` hook runs `tooling/commit-conventions/src/validate-commit-msg.ts`

## Pull Request Process

1. Create branch following naming conventions
2. Make commits following commit message conventions
3. Open PR against `main`
4. Review the PR to ensure conventions are followed

## Common Mistakes by AI Agents

1. **Using `fix:` or `feat:` prefixes** - These are NOT valid in this repo. Use branch-based prefixes.
2. **Missing colon after ticket/branch name** - Always use `URM-123: description`, not `URM-123 description`
3. **Committing directly to `main`** - Always use a feature branch
4. **Bypassing hooks** - Always run hooks locally to catch issues early

## Tooling

- Validation logic: `tooling/commit-conventions/src/validate.ts`
- Husky hook: `.husky/commit-msg`
