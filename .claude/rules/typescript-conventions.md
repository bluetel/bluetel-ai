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
