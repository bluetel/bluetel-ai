// enforce-safe-env.mjs
export const enforceSafeEnv = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow importing createEnv from @t3-oss/env-core. Use createSafeEnv from @bluetel-ai/env-validation-errors instead.',
    },
    hasSuggestions: true,
    messages: {
      noDirectCreateEnv:
        'Do not import createEnv directly from @t3-oss/env-core. Use createSafeEnv from @bluetel-ai/env-validation-errors instead.',
      replaceWithSafeEnv: 'Replace with createSafeEnv from @bluetel-ai/env-validation-errors.',
    },
    schema: [],
  },
  create: (context) => ({
    ImportDeclaration: (node) => {
      // 1. Check if source is @t3-oss/env-core
      if (node.source.value !== '@t3-oss/env-core') return
      // 2. Skip full type-only imports
      if (node.importKind === 'type') return
      // 3. Iterate specifiers
      for (const specifier of node.specifiers) {
        if (specifier.type !== 'ImportSpecifier') continue
        if (specifier.importKind === 'type') continue
        if (specifier.imported.name === 'createEnv') {
          context.report({
            node: specifier,
            messageId: 'noDirectCreateEnv',
            suggest: [
              {
                messageId: 'replaceWithSafeEnv',
                fix: (fixer) => [
                  fixer.replaceText(specifier.imported, 'createSafeEnv'),
                  fixer.replaceTextRange(
                    [node.source.range[0] + 1, node.source.range[1] - 1],
                    '@bluetel-ai/env-validation-errors',
                  ),
                ],
              },
            ],
          })
        }
      }
    },
  }),
}
