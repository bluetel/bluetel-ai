---
globs: '**/*.{ts,tsx,js,jsx,mjs,cjs}'
---

# TypeScript / JavaScript Conventions

## Colocate Tests

- Every module file should have its test file colocated in the same directory.
- Test files use the naming pattern `<filename>.test.ts` (or `.test.tsx`, `.test.js`, etc.).

**Example structure:**

```
src/
  utils/
    parse.ts
    parse.test.ts
    format.ts
    format.test.ts
```

## Export Through index.ts Barrel Files

- Public API for a directory or package must be exported through an `index.ts` barrel file.
- Consumers import from the barrel, not from internal module paths.

**Correct:**

```typescript
// src/utils/index.ts
export { parse } from './parse'
export { format } from './format'

// consumer
import { parse, format } from './utils'
```

**Incorrect:**

```typescript
// consumer reaching into internals
import { parse } from './utils/parse'
```

## Break Up Large Files Into Modules

- Avoid large monolithic files. Split logically distinct concerns into separate modules.
- Each module should have a single, clear responsibility.
- Group related modules in a directory and re-export them through an `index.ts` barrel file.

**Example — refactoring a large file:**

```
// Before: one large file
src/
  validation.ts  (500+ lines covering schemas, rules, and helpers)

// After: broken into focused modules
src/
  validation/
    schemas.ts
    schemas.test.ts
    rules.ts
    rules.test.ts
    helpers.ts
    helpers.test.ts
    index.ts        // re-exports public API
```

## Import Rules

- Import statements MUST NOT include `.js` extensions.
- Use extensionless imports for local modules.

**Correct:**

```typescript
import { foo } from './module'
import { bar } from '../utils/helper'
```

**Incorrect:**

```typescript
import { foo } from './module.js'
import { bar } from '../utils/helper.js'
```

## Linting

`oxlint` enforces 142 of the 146 rules, including every type-aware one; ESLint enforces the
remaining 4 as the Nx `lint-workspace` target. Run `pnpm lint:fast` (≈1.5 s for the whole
repo) while editing rather than a narrower command.

New rules go in the root `.oxlintrc.json`, **with their options** — several rules fire on
nothing at oxlint's defaults. Never enable an oxlint category: it lights up existing code
with rules nobody chose.

Every enforced rule has a planted-violation fixture in `tooling/lint-coverage`. Moving a rule
between layers means updating its fixture in the same change.
