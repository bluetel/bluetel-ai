import { ESLint } from 'eslint'

import {
  isEnabled,
  isFixable,
  optionsOf,
  pluginOf,
  requiresTypeChecking,
  severityOf,
  shortNameOf,
  type RuleEntry,
  type RuleMeta,
  type Severity,
} from './classify'

/** One enabled lint rule, as resolved for at least one representative file. */
export interface ExtractedRule {
  /** Fully-qualified rule id, e.g. `@typescript-eslint/no-floating-promises`. */
  name: string
  /** The plugin that supplies it, or `eslint` for core rules. */
  plugin: string
  severity: Severity
  /** The options the rule was configured with; `[]` when given a bare severity. */
  options: unknown[]
  /** From the rule's own `meta.docs.requiresTypeChecking`. */
  requiresTypeChecking: boolean
  /** From the rule's own `meta.fixable`. */
  fixable: boolean
  /** The representative files this rule turned out to be enabled for. */
  enabledFor: string[]
}

export interface ExtractOptions {
  /** Directory ESLint resolves the config from. Defaults to the current working directory. */
  cwd?: string
  /**
   * Representative files, one per file type the config discriminates on. A rule scoped to
   * `**\/*.{ts,tsx}` will not appear if only a `.mjs` file is probed, which is exactly the
   * kind of silent gap this harness exists to prevent.
   */
  files: string[]
  /** Lint with this config file instead of the one ESLint would look up. */
  overrideConfigFile?: string
}

/**
 * ESLint keys the core rules under `@` in the resolved `plugins` record. Rule ids for those
 * rules carry no prefix, so the plugin derived from the name (`eslint`) has to be mapped
 * back to the key the record actually uses.
 */
const CORE_PLUGIN_KEY = '@'

type PluginRecord = Record<string, { rules?: Record<string, { meta?: RuleMeta }> } | undefined>

const metaFor = (plugins: PluginRecord, ruleName: string): RuleMeta | undefined => {
  const plugin = pluginOf(ruleName)
  const key = plugin === 'eslint' ? CORE_PLUGIN_KEY : plugin
  return plugins[key]?.rules?.[shortNameOf(ruleName)]?.meta
}

/**
 * Enumerate every lint rule the config actually enables, by asking ESLint to resolve the
 * config for each representative file and merging the results.
 *
 * This reads the resolved config rather than the config source. A config assembled from
 * shared presets, `tseslint.config()` calls and `files`-scoped overrides cannot be
 * enumerated by reading it — only by asking ESLint what it decided.
 *
 * Output is sorted by rule name so successive runs diff cleanly.
 */
export const extractRules = async (options: ExtractOptions): Promise<ExtractedRule[]> => {
  const eslint = new ESLint({
    cwd: options.cwd ?? process.cwd(),
    ...(options.overrideConfigFile === undefined
      ? {}
      : { overrideConfigFile: options.overrideConfigFile }),
  })

  const byName = new Map<string, ExtractedRule>()

  for (const file of options.files) {
    const config = (await eslint.calculateConfigForFile(file)) as {
      rules?: Record<string, RuleEntry>
      plugins?: PluginRecord
    }
    const plugins = config.plugins ?? {}

    for (const [name, entry] of Object.entries(config.rules ?? {})) {
      if (!isEnabled(entry)) continue

      const existing = byName.get(name)
      if (existing) {
        existing.enabledFor.push(file)
        continue
      }

      const meta = metaFor(plugins, name)
      byName.set(name, {
        name,
        plugin: pluginOf(name),
        severity: severityOf(entry),
        options: optionsOf(entry),
        requiresTypeChecking: requiresTypeChecking(meta),
        fixable: isFixable(meta),
        enabledFor: [file],
      })
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Counts used by the inventory header and by the SC-005 row-count assertion. */
export interface RuleTotals {
  total: number
  typeAware: number
  syntactic: number
  byPlugin: Record<string, number>
}

export const summarise = (rules: readonly ExtractedRule[]): RuleTotals => {
  const byPlugin: Record<string, number> = {}
  for (const rule of rules) {
    byPlugin[rule.plugin] = (byPlugin[rule.plugin] ?? 0) + 1
  }
  const typeAware = rules.filter((rule) => rule.requiresTypeChecking).length
  return {
    total: rules.length,
    typeAware,
    syntactic: rules.length - typeAware,
    byPlugin,
  }
}
