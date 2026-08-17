import checkFile from 'eslint-plugin-check-file'
import importX from 'eslint-plugin-import-x'
import preferArrowFunctions from 'eslint-plugin-prefer-arrow-functions'
import unusedImports from 'eslint-plugin-unused-imports'

/**
 * ESLint plugins re-exposed as oxlint JS plugins.
 *
 * oxlint's JS plugin API is ESLint-v9-compatible, so a plugin whose rules are plain AST
 * visitors loads unchanged; the only thing missing is the `meta.name` oxlint namespaces
 * diagnostics by. These wrappers supply that and nothing else — deliberately, because any
 * adaptation here would be a place for the two layers' behaviour to diverge silently.
 *
 * Each of these covers a rule oxlint has no native implementation of, confirmed empirically
 * rather than from documentation: oxlint hard-fails config parsing on an unknown rule name,
 * so every one of the workspace's 129 rules was probed by writing a config that enables it
 * and checking whether the config parses. See research.md §8.
 */

/** `import-x/order` — oxlint implements `import-x/no-duplicates` natively, but not ordering. */
export const importXPlugin = {
  meta: { name: 'import-x' },
  rules: importX.rules,
}

/** `check-file/filename-naming-convention` and `check-file/folder-naming-convention`. */
export const checkFilePlugin = {
  meta: { name: 'check-file' },
  rules: checkFile.rules,
}

/** `prefer-arrow-functions/prefer-arrow-functions`. */
export const preferArrowFunctionsPlugin = {
  meta: { name: 'prefer-arrow-functions' },
  rules: preferArrowFunctions.rules,
}

/**
 * `unused-imports/no-unused-imports`.
 *
 * oxlint's native `no-unused-vars` reports an unused import, but does not remove it the way
 * this rule's fixer does, so the rule comes across rather than being folded into the native
 * one. `unused-imports/no-unused-vars` *is* covered natively and stays there.
 */
export const unusedImportsPlugin = {
  meta: { name: 'unused-imports' },
  rules: unusedImports.rules,
}
