import { workspaceChecks } from '@bluetel-ai/eslint-config-internal'

export default [
  // The fixture tree deliberately contains rule violations. Linting it would fail the
  // repo's own gates for exactly the reason the fixtures exist.
  { ignores: ['fixtures/**'] },
  ...workspaceChecks,
]
