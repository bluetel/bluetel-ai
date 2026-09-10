import { workspaceChecks } from '@bluetel-ai/eslint-config-internal'

export default [
  // catalog/ and assets/ are payload, not this repo's source: skills.sh copies them verbatim
  // into target repos, which may not be Node projects at all. Each script carries its own
  // eslint-disable/biome/prettier header for the toolchains those repos run, so linting them
  // here reports those headers as unused directives while enforcing rules the copies cannot
  // honour anyway. Same trees oxlint skips via `ignorePatterns` in .oxlintrc.json and qlty via
  // `exclude_patterns`. Ignored here rather than in the shared config because flat-config
  // ignore globs resolve relative to the config's own directory, which is this one.
  { ignores: ['catalog/**', 'assets/**'] },
  ...workspaceChecks,
]
