import tseslint from 'typescript-eslint'

/**
 * A deliberately tiny flat config, used only by `extract.test.ts`.
 *
 * Six enabled rules chosen to exercise every branch of the extractor: a core rule, a
 * `.ts`-scoped plugin rule, a rule with options, a rule that is explicitly turned `off`
 * (and must therefore not be counted), a known type-aware rule
 * (`@typescript-eslint/no-floating-promises`) and a known syntactic one
 * (`@typescript-eslint/consistent-type-imports`).
 *
 * It is a fixture, not a config anything is linted with. Asserting against the real
 * workspace config here would make the test restate whatever the config happens to say.
 */
export default tseslint.config(
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    rules: {
      'no-useless-return': 'error',
      'arrow-body-style': ['error', 'as-needed'],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
)
