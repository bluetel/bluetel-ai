import { base, withTypeChecking } from '@bluetel-ai/eslint-config-base'
import { globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'

const eslintConfig = [
  ...base,
  ...nextVitals,
  ...withTypeChecking(import.meta.dirname),
  // `.sst/` is the deployment tool's generated type tree. It has to be
  // *compiled* — the ambient `sst.*` / `aws.*` globals the config files use are
  // declared nowhere else — but it is not ours to style. Compiled, loosely
  // type-checked, never linted: all three, or the gate either breaks or
  // silently stops checking (FR-198).
  globalIgnores(['.next/**', '.open-next/**', '.sst/**', 'build/**', 'next-env.d.ts']),
]

export default eslintConfig
