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
| Enabled rules | **146** |
| Type-aware (`meta.docs.requiresTypeChecking`) | 41 |
| Syntactic | 105 |
| Unassigned | 0 |
| Dropped | 0 |

Rules enforced across both layers: **146**, matching `research.md` §2 plus the 18 core rules typescript-eslint switches off for TypeScript.

## By plugin

| Plugin | Rules |
| --- | ---: |
| `@cspell` | 1 |
| `@nx` | 1 |
| `@typescript-eslint` | 70 |
| `bluetel-ai` | 1 |
| `check-file` | 2 |
| `eslint` | 66 |
| `import-x` | 1 |
| `import-x-js` | 1 |
| `prefer-arrow-functions` | 1 |
| `react` | 1 |
| `unused-imports-js` | 1 |

## Rules

| Rule | Plugin | Severity | Options | Type-aware | Fixable | Owner | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
 | `@cspell/spellchecker` | `@cspell` | error | `{"autoFix":false,"checkComments":true,"checkIdentifiers":true,"checkJSXText":…` | no | yes | eslint-workspace | covered | No oxlint equivalent. ~1555 ms per invocation, none of it scaling with file count, so it belongs to a cached per-project target. | 
 | `@nx/enforce-module-boundaries` | `@nx` | error | `{"allow":[],"depConstraints":[{"sourceTag":"*","onlyDependOnLibsWithTags":["*…` | no | yes | eslint-workspace | covered | Needs the Nx project graph, which only exists inside an Nx invocation. It was silently skipped on the pre-migration staged path for exactly that reason — research.md §1. | 
 | `@typescript-eslint/await-thenable` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/ban-ts-comment` | `@typescript-eslint` | error | `{"minimumDescriptionLength":10}` | no | no | oxlint-native | relocated | — | 
 | `@typescript-eslint/consistent-type-definitions` | `@typescript-eslint` | error | `"interface"` | no | no | oxlint-native | relocated | — | 
 | `@typescript-eslint/consistent-type-imports` | `@typescript-eslint` | error | `{"prefer":"type-imports"}` | no | no | oxlint-native | relocated | — | 
 | `@typescript-eslint/no-array-constructor` | `@typescript-eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `@typescript-eslint/no-array-delete` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/no-base-to-string` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/no-confusing-void-expression` | `@typescript-eslint` | error | `{"ignoreArrowShorthand":true,"ignoreVoidOperator":false}` | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/no-deprecated` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/no-duplicate-enum-values` | `@typescript-eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `@typescript-eslint/no-duplicate-type-constituents` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/no-dynamic-delete` | `@typescript-eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `@typescript-eslint/no-empty-object-type` | `@typescript-eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `@typescript-eslint/no-explicit-any` | `@typescript-eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `@typescript-eslint/no-extra-non-null-assertion` | `@typescript-eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `@typescript-eslint/no-extraneous-class` | `@typescript-eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `@typescript-eslint/no-floating-promises` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/no-for-in-array` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/no-implied-eval` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/no-invalid-void-type` | `@typescript-eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `@typescript-eslint/no-meaningless-void-operator` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/no-misused-new` | `@typescript-eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `@typescript-eslint/no-misused-promises` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/no-misused-spread` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/no-mixed-enums` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/no-namespace` | `@typescript-eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `@typescript-eslint/no-non-null-asserted-nullish-coalescing` | `@typescript-eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `@typescript-eslint/no-non-null-asserted-optional-chain` | `@typescript-eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `@typescript-eslint/no-non-null-assertion` | `@typescript-eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `@typescript-eslint/no-redundant-type-constituents` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/no-require-imports` | `@typescript-eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `@typescript-eslint/no-this-alias` | `@typescript-eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `@typescript-eslint/no-unnecessary-boolean-literal-compare` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/no-unnecessary-condition` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/no-unnecessary-template-expression` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/no-unnecessary-type-arguments` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/no-unnecessary-type-assertion` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/no-unnecessary-type-constraint` | `@typescript-eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `@typescript-eslint/no-unnecessary-type-conversion` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/no-unnecessary-type-parameters` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/no-unsafe-argument` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/no-unsafe-assignment` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/no-unsafe-call` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/no-unsafe-declaration-merging` | `@typescript-eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `@typescript-eslint/no-unsafe-enum-comparison` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/no-unsafe-function-type` | `@typescript-eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `@typescript-eslint/no-unsafe-member-access` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/no-unsafe-return` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/no-unsafe-unary-minus` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/no-unused-expressions` | `@typescript-eslint` | error | `{"allowShortCircuit":false,"allowTaggedTemplates":false,"allowTernary":false}` | no | no | oxlint-native | relocated | — | 
 | `@typescript-eslint/no-useless-constructor` | `@typescript-eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `@typescript-eslint/no-wrapper-object-types` | `@typescript-eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `@typescript-eslint/only-throw-error` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/prefer-as-const` | `@typescript-eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `@typescript-eslint/prefer-literal-enum-member` | `@typescript-eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `@typescript-eslint/prefer-namespace-keyword` | `@typescript-eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `@typescript-eslint/prefer-nullish-coalescing` | `@typescript-eslint` | error | `{"ignoreTernaryTests":false,"ignoreConditionalTests":false}` | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/prefer-optional-chain` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/prefer-promise-reject-errors` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/prefer-reduce-type-parameter` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/prefer-return-this-type` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/related-getter-setter-pairs` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/require-await` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/restrict-plus-operands` | `@typescript-eslint` | error | `{"allowAny":false,"allowBoolean":false,"allowNullish":false,"allowNumberAndSt…` | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/restrict-template-expressions` | `@typescript-eslint` | error | `{"allowNumber":true,"allowBoolean":false,"allowNullish":false,"allowRegExp":t…` | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/return-await` | `@typescript-eslint` | error | `"error-handling-correctness-only"` | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/triple-slash-reference` | `@typescript-eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `@typescript-eslint/unbound-method` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `@typescript-eslint/unified-signatures` | `@typescript-eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `@typescript-eslint/use-unknown-in-catch-callback-variable` | `@typescript-eslint` | error | — | yes | no | oxlint-type-aware | relocated | Runs under oxlint-tsgolint, which embeds its own typechecker. | 
 | `arrow-body-style` | `eslint` | error | `"as-needed"` | no | no | oxlint-native | relocated | — | 
 | `bluetel-ai/enforce-safe-env` | `bluetel-ai` | error | — | no | no | oxlint-js-plugin | relocated | No native oxlint implementation; runs through the ESLint-compatible JS plugin API. | 
 | `check-file/filename-naming-convention` | `check-file` | error | `[{"**/*.{ts,tsx}":"KEBAB_CASE"},{"ignoreMiddleExtensions":true}]` | no | no | oxlint-js-plugin | relocated | No native oxlint implementation; runs through the ESLint-compatible JS plugin API. | 
 | `check-file/folder-naming-convention` | `check-file` | error | `{"src/components/**/":"KEBAB_CASE","src/lib/**/":"KEBAB_CASE"}` | no | no | oxlint-js-plugin | relocated | No native oxlint implementation; runs through the ESLint-compatible JS plugin API. | 
 | `constructor-super` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `eslint/no-unused-vars` | `eslint` | error | `{"vars":"all","varsIgnorePattern":"^_","args":"all","argsIgnorePattern":"^_"}` | no | no | oxlint-native | relocated | — | 
 | `for-direction` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `getter-return` | `eslint` | error | `{"allowImplicit":false}` | no | no | oxlint-native | relocated | — | 
 | `import-x-js/order` | `import-x-js` | error | `{"groups":["builtin","external","internal","parent","sibling","index"],"newli…` | no | no | oxlint-js-plugin | relocated | No native oxlint implementation; runs through the ESLint-compatible JS plugin API. | 
 | `import-x/no-duplicates` | `import-x` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-async-promise-executor` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-case-declarations` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-class-assign` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-compare-neg-zero` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-cond-assign` | `eslint` | error | `"except-parens"` | no | no | oxlint-native | relocated | — | 
 | `no-const-assign` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-constant-binary-expression` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-constant-condition` | `eslint` | error | `{"checkLoops":"allExceptWhileTrue"}` | no | no | oxlint-native | relocated | — | 
 | `no-control-regex` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-debugger` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-delete-var` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-dupe-args` | `eslint` | error | — | no | no | eslint-workspace | covered | Not implemented by oxlint. Only ever applied to .js/.mjs/.cjs files, since typescript-eslint switches it off for TypeScript. | 
 | `no-dupe-class-members` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-dupe-else-if` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-dupe-keys` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-duplicate-case` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-empty` | `eslint` | error | `{"allowEmptyCatch":false}` | no | no | oxlint-native | relocated | — | 
 | `no-empty-character-class` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-empty-pattern` | `eslint` | error | `{"allowObjectPatternsAsParameters":false}` | no | no | oxlint-native | relocated | — | 
 | `no-empty-static-block` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-ex-assign` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-extra-boolean-cast` | `eslint` | error | `{}` | no | no | oxlint-native | relocated | — | 
 | `no-fallthrough` | `eslint` | error | `{"allowEmptyCase":false,"reportUnusedFallthroughComment":false}` | no | no | oxlint-native | relocated | — | 
 | `no-func-assign` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-global-assign` | `eslint` | error | `{"exceptions":[]}` | no | no | oxlint-native | relocated | — | 
 | `no-import-assign` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-invalid-regexp` | `eslint` | error | `{}` | no | no | oxlint-native | relocated | — | 
 | `no-irregular-whitespace` | `eslint` | error | `{"skipComments":false,"skipJSXText":false,"skipRegExps":false,"skipStrings":t…` | no | no | oxlint-native | relocated | — | 
 | `no-loss-of-precision` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-misleading-character-class` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-new-native-nonconstructor` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-nonoctal-decimal-escape` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-obj-calls` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-octal` | `eslint` | error | — | no | no | eslint-workspace | covered | The one core ESLint rule in this workspace’s set that oxlint does not implement. Established by probing every rule name, not assumed. | 
 | `no-prototype-builtins` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-redeclare` | `eslint` | error | `{"builtinGlobals":true}` | no | no | oxlint-native | relocated | — | 
 | `no-regex-spaces` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-self-assign` | `eslint` | error | `{"props":true}` | no | no | oxlint-native | relocated | — | 
 | `no-setter-return` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-shadow-restricted-names` | `eslint` | error | `{"reportGlobalThis":false}` | no | no | oxlint-native | relocated | — | 
 | `no-sparse-arrays` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-this-before-super` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-undef` | `eslint` | error | `{"typeof":false}` | no | no | oxlint-native | relocated | — | 
 | `no-unreachable` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-unsafe-finally` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-unsafe-negation` | `eslint` | error | `{"enforceForOrderingRelations":false}` | no | no | oxlint-native | relocated | — | 
 | `no-unsafe-optional-chaining` | `eslint` | error | `{"disallowArithmeticOperators":false}` | no | no | oxlint-native | relocated | — | 
 | `no-unused-labels` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-unused-private-class-members` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-useless-backreference` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-useless-catch` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-useless-escape` | `eslint` | error | `{"allowRegexCharacters":[]}` | no | no | oxlint-native | relocated | — | 
 | `no-useless-return` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-var` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `no-with` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `prefer-arrow-functions/prefer-arrow-functions` | `prefer-arrow-functions` | error | `{"allowedNames":[],"allowNamedFunctions":false,"allowObjectProperties":false,…` | no | no | oxlint-js-plugin | relocated | No native oxlint implementation; runs through the ESLint-compatible JS plugin API. | 
 | `prefer-const` | `eslint` | error | `{"destructuring":"any","ignoreReadBeforeAssign":false}` | no | no | oxlint-native | relocated | — | 
 | `prefer-rest-params` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `prefer-spread` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `react/react-compiler` | `react` | error | — | no | no | oxlint-native | relocated | — | 
 | `require-yield` | `eslint` | error | — | no | no | oxlint-native | relocated | — | 
 | `unused-imports-js/no-unused-imports` | `unused-imports-js` | error | — | no | no | oxlint-js-plugin | relocated | No native oxlint implementation; runs through the ESLint-compatible JS plugin API. | 
 | `use-isnan` | `eslint` | error | `{"enforceForIndexOf":false,"enforceForSwitchCase":true}` | no | no | oxlint-native | relocated | — | 
 | `valid-typeof` | `eslint` | error | `{"requireStringLiterals":false}` | no | no | oxlint-native | relocated | — | 
