import { base as internalBase, withTypeChecking } from '@chalkboard/eslint-config-internal'

import { enforceSafeEnv } from './rules/enforce-safe-env.mjs'

const chalkboardPlugin = {
  rules: {
    'enforce-safe-env': enforceSafeEnv,
  },
}

export const base = [
  ...internalBase,
  {
    plugins: { '@chalkboard': chalkboardPlugin },
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@chalkboard/enforce-safe-env': 'error',
    },
  },
]

export { withTypeChecking }
