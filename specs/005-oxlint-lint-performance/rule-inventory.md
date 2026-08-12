# Rule Inventory

<!-- GENERATED FILE — do not edit by hand.
     Regenerate with: pnpm lint-inventory -->

Every lint rule this workspace enforces, with the layer accountable for it after the
migration. This is the FR-006 / SC-005 artifact: a rule that is not on this list is not
enforced, and a rule whose owner is `unassigned` is an unfinished migration, not a
detail.

## Totals

| Measure | Count |
| --- | ---: |
| Enabled rules | **147** |
| Type-aware (`meta.docs.requiresTypeChecking`) | 41 |
| Syntactic | 106 |
| Unassigned | 0 |
| Dropped | 0 |

Rules enabled for a TypeScript file: **129**, matching `research.md` §2.

## By plugin

| Plugin | Rules |
| --- | ---: |
| `@bluetel-ai` | 1 |
| `@cspell` | 1 |
| `@nx` | 1 |
| `@typescript-eslint` | 71 |
| `check-file` | 2 |
| `eslint` | 65 |
| `import-x` | 2 |
| `prefer-arrow-functions` | 1 |
| `react-compiler` | 1 |
| `unused-imports` | 2 |

## Rules

| Rule | Plugin | Severity | Options | Type-aware | Fixable | Owner | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | `@bluetel-ai/enforce-safe-env` | `@bluetel-ai` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@cspell/spellchecker` | `@cspell` | error | `{"autoFix":false,"checkComments":true,"checkIdentifiers":true,"checkJSXText":…` | no | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@nx/enforce-module-boundaries` | `@nx` | error | `{"allow":[],"depConstraints":[{"sourceTag":"*","onlyDependOnLibsWithTags":["*…` | no | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/await-thenable` | `@typescript-eslint` | error | — | yes | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/ban-ts-comment` | `@typescript-eslint` | error | `{"minimumDescriptionLength":10}` | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/consistent-type-definitions` | `@typescript-eslint` | error | `"interface"` | no | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/consistent-type-imports` | `@typescript-eslint` | error | `{"prefer":"type-imports"}` | no | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-array-constructor` | `@typescript-eslint` | error | — | no | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-array-delete` | `@typescript-eslint` | error | — | yes | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-base-to-string` | `@typescript-eslint` | error | — | yes | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-confusing-void-expression` | `@typescript-eslint` | error | `{"ignoreArrowShorthand":true,"ignoreVoidOperator":false}` | yes | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-deprecated` | `@typescript-eslint` | error | — | yes | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-duplicate-enum-values` | `@typescript-eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-duplicate-type-constituents` | `@typescript-eslint` | error | — | yes | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-dynamic-delete` | `@typescript-eslint` | error | — | no | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-empty-object-type` | `@typescript-eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-explicit-any` | `@typescript-eslint` | error | — | no | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-extra-non-null-assertion` | `@typescript-eslint` | error | — | no | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-extraneous-class` | `@typescript-eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-floating-promises` | `@typescript-eslint` | error | — | yes | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-for-in-array` | `@typescript-eslint` | error | — | yes | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-implied-eval` | `@typescript-eslint` | error | — | yes | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-invalid-void-type` | `@typescript-eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-meaningless-void-operator` | `@typescript-eslint` | error | — | yes | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-misused-new` | `@typescript-eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-misused-promises` | `@typescript-eslint` | error | — | yes | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-misused-spread` | `@typescript-eslint` | error | — | yes | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-mixed-enums` | `@typescript-eslint` | error | — | yes | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-namespace` | `@typescript-eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-non-null-asserted-nullish-coalescing` | `@typescript-eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-non-null-asserted-optional-chain` | `@typescript-eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-non-null-assertion` | `@typescript-eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-redundant-type-constituents` | `@typescript-eslint` | error | — | yes | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-require-imports` | `@typescript-eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-this-alias` | `@typescript-eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-unnecessary-boolean-literal-compare` | `@typescript-eslint` | error | — | yes | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-unnecessary-condition` | `@typescript-eslint` | error | — | yes | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-unnecessary-template-expression` | `@typescript-eslint` | error | — | yes | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-unnecessary-type-arguments` | `@typescript-eslint` | error | — | yes | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-unnecessary-type-assertion` | `@typescript-eslint` | error | — | yes | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-unnecessary-type-constraint` | `@typescript-eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-unnecessary-type-conversion` | `@typescript-eslint` | error | — | yes | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-unnecessary-type-parameters` | `@typescript-eslint` | error | — | yes | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-unsafe-argument` | `@typescript-eslint` | error | — | yes | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-unsafe-assignment` | `@typescript-eslint` | error | — | yes | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-unsafe-call` | `@typescript-eslint` | error | — | yes | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-unsafe-declaration-merging` | `@typescript-eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-unsafe-enum-comparison` | `@typescript-eslint` | error | — | yes | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-unsafe-function-type` | `@typescript-eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-unsafe-member-access` | `@typescript-eslint` | error | — | yes | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-unsafe-return` | `@typescript-eslint` | error | — | yes | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-unsafe-unary-minus` | `@typescript-eslint` | error | — | yes | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-unused-expressions` | `@typescript-eslint` | error | `{"allowShortCircuit":false,"allowTaggedTemplates":false,"allowTernary":false}` | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-unused-vars` | `@typescript-eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-useless-constructor` | `@typescript-eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/no-wrapper-object-types` | `@typescript-eslint` | error | — | no | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/only-throw-error` | `@typescript-eslint` | error | — | yes | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/prefer-as-const` | `@typescript-eslint` | error | — | no | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/prefer-literal-enum-member` | `@typescript-eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/prefer-namespace-keyword` | `@typescript-eslint` | error | — | no | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/prefer-nullish-coalescing` | `@typescript-eslint` | error | `{"ignoreTernaryTests":false,"ignoreConditionalTests":false}` | yes | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/prefer-optional-chain` | `@typescript-eslint` | error | — | yes | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/prefer-promise-reject-errors` | `@typescript-eslint` | error | — | yes | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/prefer-reduce-type-parameter` | `@typescript-eslint` | error | — | yes | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/prefer-return-this-type` | `@typescript-eslint` | error | — | yes | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/related-getter-setter-pairs` | `@typescript-eslint` | error | — | yes | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/require-await` | `@typescript-eslint` | error | — | yes | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/restrict-plus-operands` | `@typescript-eslint` | error | `{"allowAny":false,"allowBoolean":false,"allowNullish":false,"allowNumberAndSt…` | yes | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/restrict-template-expressions` | `@typescript-eslint` | error | `{"allowNumber":true,"allowBoolean":false,"allowNullish":false,"allowRegExp":t…` | yes | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/return-await` | `@typescript-eslint` | error | `"error-handling-correctness-only"` | yes | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/triple-slash-reference` | `@typescript-eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/unbound-method` | `@typescript-eslint` | error | — | yes | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/unified-signatures` | `@typescript-eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `@typescript-eslint/use-unknown-in-catch-callback-variable` | `@typescript-eslint` | error | — | yes | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `arrow-body-style` | `eslint` | error | `"as-needed"` | no | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `check-file/filename-naming-convention` | `check-file` | error | `[{"**/*.{ts,tsx}":"KEBAB_CASE"},{"ignoreMiddleExtensions":true}]` | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `check-file/folder-naming-convention` | `check-file` | error | `{"src/components/**/":"KEBAB_CASE","src/lib/**/":"KEBAB_CASE"}` | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `constructor-super` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `for-direction` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `getter-return` | `eslint` | error | `{"allowImplicit":false}` | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `import-x/no-duplicates` | `import-x` | error | — | no | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `import-x/order` | `import-x` | error | `{"groups":["builtin","external","internal","parent","sibling","index"],"newli…` | no | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-async-promise-executor` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-case-declarations` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-class-assign` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-compare-neg-zero` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-cond-assign` | `eslint` | error | `"except-parens"` | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-const-assign` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-constant-binary-expression` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-constant-condition` | `eslint` | error | `{"checkLoops":"allExceptWhileTrue"}` | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-control-regex` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-debugger` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-delete-var` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-dupe-args` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-dupe-class-members` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-dupe-else-if` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-dupe-keys` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-duplicate-case` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-empty` | `eslint` | error | `{"allowEmptyCatch":false}` | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-empty-character-class` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-empty-pattern` | `eslint` | error | `{"allowObjectPatternsAsParameters":false}` | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-empty-static-block` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-ex-assign` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-extra-boolean-cast` | `eslint` | error | `{}` | no | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-fallthrough` | `eslint` | error | `{"allowEmptyCase":false,"reportUnusedFallthroughComment":false}` | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-func-assign` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-global-assign` | `eslint` | error | `{"exceptions":[]}` | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-import-assign` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-invalid-regexp` | `eslint` | error | `{}` | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-irregular-whitespace` | `eslint` | error | `{"skipComments":false,"skipJSXText":false,"skipRegExps":false,"skipStrings":t…` | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-loss-of-precision` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-misleading-character-class` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-new-native-nonconstructor` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-nonoctal-decimal-escape` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-obj-calls` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-octal` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-prototype-builtins` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-redeclare` | `eslint` | error | `{"builtinGlobals":true}` | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-regex-spaces` | `eslint` | error | — | no | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-self-assign` | `eslint` | error | `{"props":true}` | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-setter-return` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-shadow-restricted-names` | `eslint` | error | `{"reportGlobalThis":false}` | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-sparse-arrays` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-this-before-super` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-undef` | `eslint` | error | `{"typeof":false}` | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-unreachable` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-unsafe-finally` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-unsafe-negation` | `eslint` | error | `{"enforceForOrderingRelations":false}` | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-unsafe-optional-chaining` | `eslint` | error | `{"disallowArithmeticOperators":false}` | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-unused-labels` | `eslint` | error | — | no | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-unused-private-class-members` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-useless-backreference` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-useless-catch` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-useless-escape` | `eslint` | error | `{"allowRegexCharacters":[]}` | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-useless-return` | `eslint` | error | — | no | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-var` | `eslint` | error | — | no | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `no-with` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `prefer-arrow-functions/prefer-arrow-functions` | `prefer-arrow-functions` | error | `{"allowedNames":[],"allowNamedFunctions":false,"allowObjectProperties":false,…` | no | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `prefer-const` | `eslint` | error | `{"destructuring":"any","ignoreReadBeforeAssign":false}` | no | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `prefer-rest-params` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `prefer-spread` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `react-compiler/react-compiler` | `react-compiler` | error | — | no | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `require-yield` | `eslint` | error | — | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `unused-imports/no-unused-imports` | `unused-imports` | error | — | no | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `unused-imports/no-unused-vars` | `unused-imports` | error | `{"vars":"all","varsIgnorePattern":"^_","args":"all","argsIgnorePattern":"^_"}` | no | yes | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `use-isnan` | `eslint` | error | `{"enforceForIndexOf":false,"enforceForSwitchCase":true}` | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
 | `valid-typeof` | `eslint` | error | `{"requireStringLiterals":false}` | no | no | eslint | covered | Pre-migration: the single ESLint layer enforces every rule. | 
