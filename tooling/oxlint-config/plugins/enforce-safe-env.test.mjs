import * as parser from '@typescript-eslint/parser'
import { RuleTester, Linter } from 'eslint'
import * as fc from 'fast-check'
import { describe, it, expect } from 'vitest'

import { enforceSafeEnv } from './enforce-safe-env.mjs'

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

const ruleTester = new RuleTester({
  languageOptions: {
    parser,
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

/** Linter instance for property-based tests (programmatic verification). */
const lint = (code) => {
  const linter = new Linter()
  return linter.verify(code, {
    languageOptions: {
      parser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    plugins: {
      '@bluetel-ai': { rules: { 'enforce-safe-env': enforceSafeEnv } },
    },
    rules: {
      '@bluetel-ai/enforce-safe-env': 'error',
    },
  })
}

// ---------------------------------------------------------------------------
// 7.2 — Unit tests (RuleTester)
// ---------------------------------------------------------------------------

describe('enforce-safe-env: rule meta structure', () => {
  it('has correct meta.type', () => {
    expect(enforceSafeEnv.meta.type).toBe('problem')
  })

  it('has hasSuggestions set to true', () => {
    expect(enforceSafeEnv.meta.hasSuggestions).toBe(true)
  })

  it('has expected message IDs', () => {
    expect(enforceSafeEnv.meta.messages).toHaveProperty('noDirectCreateEnv')
    expect(enforceSafeEnv.meta.messages).toHaveProperty('replaceWithSafeEnv')
  })

  it('has an empty schema', () => {
    expect(enforceSafeEnv.meta.schema).toEqual([])
  })
})

describe('enforce-safe-env: RuleTester cases', () => {
  it('passes all valid and invalid RuleTester cases', () => {
    ruleTester.run('enforce-safe-env', enforceSafeEnv, {
      valid: [
        {
          name: 'type-only import from @t3-oss/env-core',
          code: "import type { StandardSchemaV1 } from '@t3-oss/env-core'",
        },
        {
          name: 'non-createEnv value import from @t3-oss/env-core',
          code: "import { someOtherExport } from '@t3-oss/env-core'",
        },
        {
          name: 'import from a different module',
          code: "import { createEnv } from 'some-other-package'",
        },
        {
          name: 'createSafeEnv from @bluetel-ai/env-validation-errors',
          code: "import { createSafeEnv } from '@bluetel-ai/env-validation-errors'",
        },
        {
          name: 'inline type specifier for createEnv',
          code: "import { type createEnv } from '@t3-oss/env-core'",
        },
        {
          name: 'mixed inline type createEnv with value non-createEnv',
          code: "import { type createEnv, someOther } from '@t3-oss/env-core'",
        },
      ],
      invalid: [
        {
          name: 'direct createEnv import',
          code: "import { createEnv } from '@t3-oss/env-core'",
          errors: [
            {
              messageId: 'noDirectCreateEnv',
              suggestions: [
                {
                  messageId: 'replaceWithSafeEnv',
                  output: "import { createSafeEnv } from '@bluetel-ai/env-validation-errors'",
                },
              ],
            },
          ],
        },
        {
          name: 'aliased createEnv import',
          code: "import { createEnv as ce } from '@t3-oss/env-core'",
          errors: [
            {
              messageId: 'noDirectCreateEnv',
              suggestions: [
                {
                  messageId: 'replaceWithSafeEnv',
                  output: "import { createSafeEnv as ce } from '@bluetel-ai/env-validation-errors'",
                },
              ],
            },
          ],
        },
        {
          name: 'mixed value + type specifiers (only createEnv flagged)',
          code: "import { createEnv, type StandardSchemaV1 } from '@t3-oss/env-core'",
          errors: [
            {
              messageId: 'noDirectCreateEnv',
              suggestions: [
                {
                  messageId: 'replaceWithSafeEnv',
                  output:
                    "import { createSafeEnv, type StandardSchemaV1 } from '@bluetel-ai/env-validation-errors'",
                },
              ],
            },
          ],
        },
      ],
    })
  })
})

describe('enforce-safe-env: no fix, only suggest', () => {
  it('errors have no fix property, only suggestions', () => {
    const messages = lint("import { createEnv } from '@t3-oss/env-core'")
    expect(messages).toHaveLength(1)
    expect(messages[0].fix).toBeUndefined()
    expect(messages[0].suggestions).toBeDefined()
    expect(messages[0].suggestions).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// fast-check generators
// ---------------------------------------------------------------------------

/**
 * Reserved words, which match the identifier pattern but are not bindable.
 *
 * Without this filter the generator eventually produces `import { createEnv as in } from …`,
 * which is a **syntax error**: the rule is never consulted, the parser's own message comes back
 * with no `suggestions`, and the property fails on a counterexample that says nothing about the
 * rule. Observed at roughly 1 run in 7 (`seed: -2058363188`,
 * `Counterexample: ["import { createEnv as in } from '@t3-oss/env-core'"]`), i.e. a flaky gate
 * rather than a found bug.
 */
const RESERVED = new Set([
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
])

/** Generate a valid JS identifier (for import aliases and other specifiers). */
const identifierArb = fc
  .stringMatching(/^[a-zA-Z_$][a-zA-Z0-9_$]{0,15}$/)
  .filter(
    (s) => s !== 'createEnv' && s !== 'type' && s !== 'from' && s !== 'import' && !RESERVED.has(s),
  )

/** Generate random whitespace (1-4 spaces). */
const wsArb = fc.integer({ min: 1, max: 4 }).map((n) => ' '.repeat(n))

/**
 * Generate an import statement that imports `createEnv` (value) from `@t3-oss/env-core`.
 * May include additional specifiers, aliases, and varying whitespace.
 */
const flaggedImportArb = fc
  .record({
    alias: fc.option(identifierArb, { nil: undefined }),
    extraSpecifiers: fc.array(identifierArb, { minLength: 0, maxLength: 3 }),
    extraTypeSpecifiers: fc.array(identifierArb, { minLength: 0, maxLength: 2 }),
    ws1: wsArb,
    ws2: wsArb,
  })
  .map(({ alias, extraSpecifiers, extraTypeSpecifiers, ws1, ws2 }) => {
    const parts = []

    // Add extra value specifiers before createEnv
    for (const s of extraSpecifiers) {
      parts.push(s)
    }

    // Add createEnv (possibly aliased)
    parts.push(alias ? `createEnv as ${alias}` : 'createEnv')

    // Add extra type specifiers
    for (const s of extraTypeSpecifiers) {
      parts.push(`type ${s}`)
    }

    return `import${ws1}{${ws2}${parts.join(', ')}${ws2}}${ws1}from '@t3-oss/env-core'`
  })

/**
 * Generate a safe import from `@t3-oss/env-core` that should NOT be flagged.
 * Either a type-only import or a value import of non-createEnv bindings.
 */
const safeImportArb = fc.oneof(
  // Type-only import
  fc
    .array(identifierArb, { minLength: 1, maxLength: 3 })
    .map((names) => `import type { ${names.join(', ')} } from '@t3-oss/env-core'`),
  // Value import of non-createEnv names
  fc
    .array(identifierArb, { minLength: 1, maxLength: 3 })
    .map((names) => `import { ${names.join(', ')} } from '@t3-oss/env-core'`),
  // Inline type specifier for createEnv
  fc.constant("import { type createEnv } from '@t3-oss/env-core'"),
  // Mixed inline type createEnv with other value specifiers
  fc
    .array(identifierArb, { minLength: 1, maxLength: 2 })
    .map((names) => `import { type createEnv, ${names.join(', ')} } from '@t3-oss/env-core'`),
)

// ---------------------------------------------------------------------------
// 7.3 — Property 1: Flagged import detection with correct message
// ---------------------------------------------------------------------------

describe('Feature: eslint-enforce-safe-env, Property 1: Flagged import detection with correct message', () => {
  /**
   * **Validates: Requirements 1.1, 1.2**
   *
   * For any valid import declaration that imports `createEnv` as a value
   * from `@t3-oss/env-core`, the rule reports exactly one error with
   * message ID `noDirectCreateEnv`.
   */
  it('flags createEnv value imports with correct message ID', () => {
    fc.assert(
      fc.property(flaggedImportArb, (code) => {
        const messages = lint(code)
        expect(messages).toHaveLength(1)
        expect(messages[0].messageId).toBe('noDirectCreateEnv')
        expect(messages[0].message).toContain('createSafeEnv')
        expect(messages[0].message).toContain('@bluetel-ai/env-validation-errors')
      }),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// 7.4 — Property 2: Safe imports are never flagged
// ---------------------------------------------------------------------------

describe('Feature: eslint-enforce-safe-env, Property 2: Safe imports are never flagged', () => {
  /**
   * **Validates: Requirements 1.3, 1.4**
   *
   * For any import from `@t3-oss/env-core` that does NOT import `createEnv`
   * as a value binding, the rule reports zero errors.
   */
  it('does not flag type-only or non-createEnv imports', () => {
    fc.assert(
      fc.property(safeImportArb, (code) => {
        const messages = lint(code)
        expect(messages).toHaveLength(0)
      }),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// 7.5 — Property 3: Suggestion fix correctness
// ---------------------------------------------------------------------------

describe('Feature: eslint-enforce-safe-env, Property 3: Suggestion fix correctness', () => {
  /**
   * **Validates: Requirements 9.1, 9.2, 9.3**
   *
   * For any flagged import, the suggestion output contains `createSafeEnv`
   * and `@bluetel-ai/env-validation-errors`, and no automatic `fix` is present.
   */
  it('suggestion replaces with createSafeEnv and correct source, no auto-fix', () => {
    fc.assert(
      fc.property(flaggedImportArb, (code) => {
        const messages = lint(code)
        expect(messages).toHaveLength(1)

        const error = messages[0]

        // No automatic fix
        expect(error.fix).toBeUndefined()

        // Has exactly one suggestion
        expect(error.suggestions).toBeDefined()
        expect(error.suggestions).toHaveLength(1)

        const suggestion = error.suggestions[0]

        // Suggestion has a description
        expect(suggestion.desc).toBeTruthy()

        // Apply the suggestion to the source and verify the output
        const fixedCode = applyFix(code, suggestion.fix)
        expect(fixedCode).toContain('createSafeEnv')
        expect(fixedCode).toContain('@bluetel-ai/env-validation-errors')
        expect(fixedCode).not.toContain('@t3-oss/env-core')
      }),
      { numRuns: 100 },
    )
  })
})

/**
 * Apply a single ESLint fix object to source code.
 * A fix has { range: [start, end], text }.
 * When the rule returns an array of fixes, ESLint merges them into a single
 * fix object covering the full range. The Linter.verify() suggestions already
 * contain the merged fix.
 */
const applyFix = (source, fix) =>
  source.slice(0, fix.range[0]) + fix.text + source.slice(fix.range[1])
