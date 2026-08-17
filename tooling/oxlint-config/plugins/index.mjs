import { enforceSafeEnv } from './enforce-safe-env.mjs'

export {
  checkFilePlugin,
  importXPlugin,
  preferArrowFunctionsPlugin,
  unusedImportsPlugin,
} from './eslint-compat.mjs'

/**
 * The workspace's own rule, as an oxlint JS plugin.
 *
 * It is 48 lines of plain AST visitor with a `suggest` fix; every API it touches is on
 * oxlint's supported list, so it ports unchanged rather than being reimplemented. The
 * namespace is `bluetel-ai` (not `@bluetel-ai`) because oxlint derives the diagnostic prefix
 * from `meta.name` and does not accept a leading `@`.
 */
export const bluetelAiPlugin = {
  meta: { name: 'bluetel-ai' },
  rules: { 'enforce-safe-env': enforceSafeEnv },
}

export { enforceSafeEnv }
