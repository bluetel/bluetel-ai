import {
  base as internalBase,
  workspaceChecks,
  withTypeChecking,
} from '@bluetel-ai/eslint-config-internal'

import { enforceSafeEnv } from './rules/enforce-safe-env.mjs'

const bluetelAiPlugin = {
  rules: {
    'enforce-safe-env': enforceSafeEnv,
  },
}

export const base = [
  ...internalBase,
  {
    plugins: { '@bluetel-ai': bluetelAiPlugin },
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@bluetel-ai/enforce-safe-env': 'error',
    },
  },
]

export { workspaceChecks, withTypeChecking }
