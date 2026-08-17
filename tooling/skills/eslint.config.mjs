import { base, withTypeChecking } from '@bluetel-ai/eslint-config-internal'

export default [
  // `catalog/` and `assets/` are payload trees: skills.sh copies them verbatim into
  // target repos, which own the result. They are deliberately dependency-free,
  // standalone scripts (sh and plain .mjs with no build step), so this repo's
  // type-aware TS rules do not apply to them — they are not part of its source.
  { ignores: ['catalog/**', 'assets/**'] },
  ...base,
  ...withTypeChecking(import.meta.dirname),
]
