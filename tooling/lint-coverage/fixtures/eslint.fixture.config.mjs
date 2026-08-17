/**
 * A deliberately tiny flat config, used only by `extract.test.ts`.
 *
 * The plugin is defined here rather than imported so the test exercises the extractor and
 * nothing else. Pointing it at a real plugin would make the assertions restate whatever that
 * plugin currently claims about its own rules, and would put typescript-eslint back in the
 * dependency tree that the migration exists to empty.
 *
 * Six enabled rules covering every branch: a core rule, a `.ts`-scoped plugin rule, a rule
 * with options, a rule explicitly turned `off` (which must not be counted), one whose meta
 * says `requiresTypeChecking`, and one whose meta does not.
 */
const probePlugin = {
  meta: { name: 'probe' },
  rules: {
    'needs-types': {
      meta: {
        docs: { description: 'Needs type information', requiresTypeChecking: true },
      },
      create: () => ({}),
    },
    'syntax-only': {
      meta: {
        fixable: 'code',
        schema: [{ type: 'object', properties: { prefer: { type: 'string' } } }],
        docs: { description: 'Syntactic only' },
      },
      create: () => ({}),
    },
    warned: { meta: { docs: {} }, create: () => ({}) },
    disabled: { meta: { docs: {} }, create: () => ({}) },
  },
}

export default [
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    rules: {
      'no-useless-return': 'error',
      'arrow-body-style': ['error', 'as-needed'],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { probe: probePlugin },
    rules: {
      'probe/needs-types': 'error',
      'probe/syntax-only': ['error', { prefer: 'type-imports' }],
      'probe/warned': 'warn',
      'probe/disabled': 'off',
    },
  },
]
