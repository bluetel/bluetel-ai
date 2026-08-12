/**
 * One planted violation per previously-enforced rule.
 *
 * The point of this file is FR-005 / SC-006: a green lint run proves nothing on its own,
 * because a rule that has silently stopped running looks exactly like clean code. Each
 * fixture below is a minimal source file that a specific rule must object to, so the
 * harness can assert that the rule ID still appears in the diagnostics.
 *
 * Fixtures are materialised into a gitignored directory at test time rather than committed
 * as source. They are deliberately full of violations; leaving them on disk inside a linted
 * tree would fail the repo's own gates for exactly the reason the fixtures exist.
 *
 * Fixtures are not required to typecheck. Several of them cannot — `no-unsafe-unary-minus`
 * needs a unary minus on a string — and ESLint reports rule violations regardless.
 */

/** A source file that must trigger exactly the rule it names. */
export interface RuleFixture {
  /** The rule ID the harness asserts on. Asserting on exit code alone would not be coverage. */
  rule: string
  /** File name within the generated fixture directory. Some rules key off the name itself. */
  filename: string
  code: string
}

/** A rule that cannot be planted as a standalone file, with the reason and where it is covered instead. */
export interface ExcusedRule {
  rule: string
  /** Why a standalone fixture cannot express a violation of this rule. */
  reason: string
  /** The check that covers it instead. */
  coveredBy: string
}

const ts = (rule: string, filename: string, code: string): RuleFixture => ({
  rule,
  filename,
  code: `${code.trim()}\n`,
})

/** Rules the workspace configures by hand, i.e. everything outside the `recommended` presets. */
export const SYNTACTIC_FIXTURES: readonly RuleFixture[] = [
  ts(
    '@typescript-eslint/no-explicit-any',
    'no-explicit-any.ts',
    `export const takesAny = (value: any): void => { void value }`,
  ),
  ts(
    '@typescript-eslint/consistent-type-imports',
    'consistent-type-imports.ts',
    `import { Buffer } from 'node:buffer'

export type Bytes = Buffer`,
  ),
  ts(
    '@typescript-eslint/consistent-type-definitions',
    'consistent-type-definitions.ts',
    `export type Shape = { width: number }`,
  ),
  ts(
    '@typescript-eslint/no-non-null-assertion',
    'no-non-null-assertion.ts',
    `declare const maybe: string | null

export const definitely = (): string => maybe!`,
  ),
  ts(
    'unused-imports/no-unused-imports',
    'no-unused-imports.ts',
    `import path from 'node:path'

export const unrelated = 1`,
  ),
  ts(
    'unused-imports/no-unused-vars',
    'no-unused-vars.ts',
    `export const holder = (): void => {
  const neverRead = 1
}`,
  ),
  ts(
    'import-x/no-duplicates',
    'no-duplicates.ts',
    `import { join } from 'node:path'
import { resolve } from 'node:path'

export const paths = [join, resolve]`,
  ),
  ts(
    'import-x/order',
    'order.ts',
    `import fc from 'fast-check'
import path from 'node:path'

export const both = [fc, path]`,
  ),
  ts(
    'prefer-arrow-functions/prefer-arrow-functions',
    'prefer-arrow-functions.ts',
    `export function declared(): number {
  return 1
}`,
  ),
  ts(
    'arrow-body-style',
    'arrow-body-style.ts',
    `export const wrapped = (): number => {
  return 1
}`,
  ),
  ts(
    'no-useless-return',
    'no-useless-return.ts',
    `export const pointless = (): void => {
  return
}`,
  ),
  // check-file keys off the file name itself, so the violation *is* the name.
  ts('check-file/filename-naming-convention', 'notKebabCase.ts', `export const named = 1`),
  // cspell:ignore mispeled Identifierr quik brwn — the misspellings are the fixture.
  ts(
    '@cspell/spellchecker',
    'spellchecker.ts',
    `export const mispeledIdentifierr = 'teh quik brwn fox'`,
  ),
  ts(
    '@bluetel-ai/enforce-safe-env',
    'enforce-safe-env.ts',
    `import { createEnv } from '@t3-oss/env-core'

export const env = createEnv`,
  ),
  // The two rules that stayed with ESLint because oxlint does not implement them. Both
  // plant as `.cjs`, and they have to: a legacy octal literal and a duplicate parameter
  // name are *syntax errors* in strict mode, so in a `.ts` or `.mjs` fixture the parser
  // fails before either rule is consulted and the file reports `Parsing error` with a null
  // rule ID — which the harness reads, correctly, as the rule not firing. Sloppy-mode
  // script is the only place a violation of either is expressible at all, which is also
  // why typescript-eslint switches `no-dupe-args` off for TypeScript.
  ts(
    'no-octal',
    'no-octal.cjs',
    `const mode = 0755
module.exports = { mode }`,
  ),
  ts(
    'no-dupe-args',
    'no-dupe-args.cjs',
    `function dupe(a, a) {
  return a
}
module.exports = { dupe }`,
  ),
]

/**
 * The 41 rules whose `meta.docs.requiresTypeChecking` is true. These carry the real
 * regression risk of the migration — they are the ones changing owner from
 * typescript-eslint to `oxlint-tsgolint`.
 */
export const TYPE_AWARE_FIXTURES: readonly RuleFixture[] = [
  ts(
    '@typescript-eslint/await-thenable',
    'await-thenable.ts',
    `export const f = async (): Promise<void> => {
  await 1
}`,
  ),
  ts(
    '@typescript-eslint/no-array-delete',
    'no-array-delete.ts',
    `export const f = (xs: number[]): void => {
  delete xs[0]
}`,
  ),
  ts(
    '@typescript-eslint/no-base-to-string',
    'no-base-to-string.ts',
    `export const f = (value: object): string => \`\${value}\``,
  ),
  ts(
    '@typescript-eslint/no-confusing-void-expression',
    'no-confusing-void-expression.ts',
    `const returnsVoid = (): void => undefined

export const f = (): void => {
  const captured = returnsVoid()
  void captured
}`,
  ),
  ts(
    '@typescript-eslint/no-deprecated',
    'no-deprecated.ts',
    `/** @deprecated use something else */
export const old = (): number => 1

export const f = (): number => old()`,
  ),
  ts(
    '@typescript-eslint/no-duplicate-type-constituents',
    'no-duplicate-type-constituents.ts',
    `export type Repeated = string | string`,
  ),
  ts(
    '@typescript-eslint/no-floating-promises',
    'no-floating-promises.ts',
    `const work = async (): Promise<void> => undefined

export const f = (): void => {
  work()
}`,
  ),
  ts(
    '@typescript-eslint/no-for-in-array',
    'no-for-in-array.ts',
    `export const f = (xs: number[]): number => {
  let total = 0
  for (const index in xs) {
    total += Number(index)
  }
  return total
}`,
  ),
  ts(
    '@typescript-eslint/no-implied-eval',
    'no-implied-eval.ts',
    `declare const source: string

export const f = (): void => {
  setTimeout(source, 0)
}`,
  ),
  ts(
    '@typescript-eslint/no-meaningless-void-operator',
    'no-meaningless-void-operator.ts',
    `const returnsVoid = (): void => undefined

export const f = (): void => void returnsVoid()`,
  ),
  ts(
    '@typescript-eslint/no-misused-promises',
    'no-misused-promises.ts',
    `const check = async (): Promise<boolean> => true

export const f = (): number => {
  if (check()) {
    return 1
  }
  return 0
}`,
  ),
  ts(
    '@typescript-eslint/no-misused-spread',
    'no-misused-spread.ts',
    `export const f = (text: string): string[] => [...text]`,
  ),
  ts(
    '@typescript-eslint/no-mixed-enums',
    'no-mixed-enums.ts',
    `export enum Mixed {
  First = 0,
  Second = 'second',
}`,
  ),
  ts(
    '@typescript-eslint/no-redundant-type-constituents',
    'no-redundant-type-constituents.ts',
    `export type Swallowed = string | any`,
  ),
  ts(
    '@typescript-eslint/no-unnecessary-boolean-literal-compare',
    'no-unnecessary-boolean-literal-compare.ts',
    `export const f = (flag: boolean): boolean => flag === true`,
  ),
  ts(
    '@typescript-eslint/no-unnecessary-condition',
    'no-unnecessary-condition.ts',
    `export const f = (text: string): boolean => text !== undefined`,
  ),
  ts(
    '@typescript-eslint/no-unnecessary-template-expression',
    'no-unnecessary-template-expression.ts',
    `export const f = (): string => \`\${'literal'}tail\``,
  ),
  ts(
    '@typescript-eslint/no-unnecessary-type-arguments',
    'no-unnecessary-type-arguments.ts',
    `const identity = <T = string,>(value: T): T => value

export const f = (): string => identity<string>('a')`,
  ),
  ts(
    '@typescript-eslint/no-unnecessary-type-assertion',
    'no-unnecessary-type-assertion.ts',
    `export const f = (text: string): string => text as string`,
  ),
  ts(
    '@typescript-eslint/no-unnecessary-type-conversion',
    'no-unnecessary-type-conversion.ts',
    `export const f = (text: string): string => String(text)`,
  ),
  ts(
    '@typescript-eslint/no-unnecessary-type-parameters',
    'no-unnecessary-type-parameters.ts',
    `export const f = <T,>(value: T): void => {
  void value
}`,
  ),
  ts(
    '@typescript-eslint/no-unsafe-argument',
    'no-unsafe-argument.ts',
    `declare const loose: any

const takesNumber = (value: number): void => {
  void value
}

export const f = (): void => {
  takesNumber(loose)
}`,
  ),
  ts(
    '@typescript-eslint/no-unsafe-assignment',
    'no-unsafe-assignment.ts',
    `declare const loose: any

export const f = (): void => {
  const typed: number = loose
  void typed
}`,
  ),
  ts(
    '@typescript-eslint/no-unsafe-call',
    'no-unsafe-call.ts',
    `declare const loose: any

export const f = (): void => {
  loose()
}`,
  ),
  ts(
    '@typescript-eslint/no-unsafe-enum-comparison',
    'no-unsafe-enum-comparison.ts',
    `enum Level {
  Low = 1,
}

export const f = (level: Level): boolean => level === 1`,
  ),
  ts(
    '@typescript-eslint/no-unsafe-member-access',
    'no-unsafe-member-access.ts',
    `declare const loose: any

export const f = (): unknown => loose.property`,
  ),
  ts(
    '@typescript-eslint/no-unsafe-return',
    'no-unsafe-return.ts',
    `declare const loose: any

export const f = (): number => loose`,
  ),
  ts(
    '@typescript-eslint/no-unsafe-unary-minus',
    'no-unsafe-unary-minus.ts',
    `declare const text: string

export const f = (): number => -text`,
  ),
  ts(
    '@typescript-eslint/only-throw-error',
    'only-throw-error.ts',
    `export const f = (): void => {
  throw 'a bare string'
}`,
  ),
  ts(
    '@typescript-eslint/prefer-promise-reject-errors',
    'prefer-promise-reject-errors.ts',
    `export const f = (): Promise<never> => Promise.reject('a bare string')`,
  ),
  ts(
    '@typescript-eslint/prefer-reduce-type-parameter',
    'prefer-reduce-type-parameter.ts',
    `export const f = (xs: string[]): string[] =>
  xs.reduce((accumulator, item) => [...accumulator, item], [] as string[])`,
  ),
  ts(
    '@typescript-eslint/prefer-return-this-type',
    'prefer-return-this-type.ts',
    `export class Builder {
  self(): Builder {
    return this
  }
}`,
  ),
  ts(
    '@typescript-eslint/related-getter-setter-pairs',
    'related-getter-setter-pairs.ts',
    `export class Mismatched {
  get value(): number {
    return 1
  }

  set value(next: string) {
    void next
  }
}`,
  ),
  ts(
    '@typescript-eslint/require-await',
    'require-await.ts',
    `export const f = async (): Promise<number> => 1`,
  ),
  ts(
    '@typescript-eslint/restrict-plus-operands',
    'restrict-plus-operands.ts',
    `declare const text: string
declare const count: number

export const f = (): string => text + count`,
  ),
  ts(
    '@typescript-eslint/restrict-template-expressions',
    'restrict-template-expressions.ts',
    `declare const flag: boolean

export const f = (): string => \`\${flag}\``,
  ),
  ts(
    '@typescript-eslint/return-await',
    'return-await.ts',
    `export const f = async (): Promise<number> => {
  try {
    return Promise.resolve(1)
  } catch {
    return 0
  }
}`,
  ),
  ts(
    '@typescript-eslint/unbound-method',
    'unbound-method.ts',
    `export class Holder {
  method(): void {
    void this
  }
}

declare const holder: Holder

export const f = (): (() => void) => holder.method`,
  ),
  ts(
    '@typescript-eslint/use-unknown-in-catch-callback-variable',
    'use-unknown-in-catch-callback-variable.ts',
    `export const f = (promise: Promise<number>): Promise<number | void> =>
  promise.catch((error: Error) => {
    void error
  })`,
  ),
  ts(
    '@typescript-eslint/prefer-nullish-coalescing',
    'prefer-nullish-coalescing.ts',
    `declare const maybe: string | null

export const f = (): string => maybe || 'fallback'`,
  ),
  ts(
    '@typescript-eslint/prefer-optional-chain',
    'prefer-optional-chain.ts',
    `declare const outer: { inner?: { value: number } } | null

export const f = (): unknown => outer && outer.inner && outer.inner.value`,
  ),
]

export const ALL_FIXTURES: readonly RuleFixture[] = [...SYNTACTIC_FIXTURES, ...TYPE_AWARE_FIXTURES]

/**
 * Rules a standalone fixture file cannot express, each with the check that covers it
 * instead. Nothing is allowed to be merely absent: `parity.test.ts` asserts that every rule
 * left on the ESLint layer is either fixture-covered above or listed here with a reason —
 * the set where a silent rule would otherwise be invisible, since those rules no longer run
 * anywhere the oxlint config can be diffed against.
 *
 * The claim this comment does *not* make: fixture coverage is not universal across all 146
 * enabled rules. The corpus is the 41 type-aware rules, the rules this workspace configures
 * by hand, and everything left on ESLint. The remaining preset rules are accounted for by
 * `rule-inventory.md` having an owner for every one of them, and by oxlint hard-failing on an
 * unknown rule name rather than skipping it.
 */
export const EXCUSED_RULES: readonly ExcusedRule[] = [
  {
    rule: '@nx/enforce-module-boundaries',
    reason:
      'Needs the Nx project graph and a real cross-project import; it is skipped entirely outside an Nx invocation, which is the pre-existing gap research.md §1 records.',
    coveredBy:
      'Task T031 — a planted module-boundary violation run through `nx run <project>:lint-workspace`.',
  },
  {
    rule: 'check-file/folder-naming-convention',
    reason:
      'Keys off directory names under `src/components/` and `src/lib/`, so the violation is a folder layout rather than a file.',
    coveredBy:
      'Preset assertion — the rule and its options are asserted present in the resolved config by `parity.test.ts`.',
  },
  {
    rule: 'react-compiler/react-compiler',
    reason:
      'Requires a React component that breaks the rules of React; no React dependency exists in this workspace yet.',
    coveredBy:
      'Preset assertion, plus task T016, which compares oxlint against eslint-plugin-react-compiler on a known violation.',
  },
]
