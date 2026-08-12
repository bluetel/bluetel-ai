import type { RuleOwner, RuleStatus } from './classify'
import { summarise, type ExtractedRule } from './extract'

/** The per-rule assignment the migration is accountable for (FR-006 / SC-005). */
export interface RuleAssignment {
  owner: RuleOwner
  status: RuleStatus
  notes?: string
}

/** Looks up the assignment for a rule. Anything unknown must come back `unassigned`. */
export type AssignmentResolver = (rule: ExtractedRule) => RuleAssignment

const escapePipes = (value: string): string => value.replaceAll('|', '\\|')

const renderOptions = (options: readonly unknown[]): string => {
  if (options.length === 0) return '—'
  const json = JSON.stringify(options.length === 1 ? options[0] : options)
  const collapsed = json.length > 80 ? `${json.slice(0, 77)}…` : json
  return `\`${escapePipes(collapsed)}\``
}

const yesNo = (value: boolean): string => (value ? 'yes' : 'no')

/**
 * Render the rule inventory as Markdown.
 *
 * One row per enabled rule, every row carrying an explicit owner and status. A rule with
 * no assignment renders as `unassigned`, which is what makes an incomplete migration
 * visible instead of merely absent — a missing row and a covered row would otherwise look
 * identical.
 */
export interface InventoryMeta {
  /** The command that regenerates this file. */
  generatedBy: string
  /**
   * A count to check against a figure recorded elsewhere, so the inventory contradicts a
   * stale claim rather than quietly disagreeing with it.
   */
  expectation?: { label: string; count: number; expected: number; source: string }
}

export const renderInventory = (
  rules: readonly ExtractedRule[],
  resolve: AssignmentResolver,
  meta: InventoryMeta,
): string => {
  const totals = summarise(rules)
  const assignments = rules.map((rule) => ({ rule, assignment: resolve(rule) }))
  const unassigned = assignments.filter(({ assignment }) => assignment.owner === 'unassigned')
  const dropped = assignments.filter(({ assignment }) => assignment.status === 'dropped')

  const pluginRows = Object.entries(totals.byPlugin)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([plugin, count]) => `| \`${plugin}\` | ${String(count)} |`)

  const ruleRows = assignments.map(({ rule, assignment }) =>
    [
      '',
      `\`${rule.name}\``,
      `\`${rule.plugin}\``,
      rule.severity,
      renderOptions(rule.options),
      yesNo(rule.requiresTypeChecking),
      yesNo(rule.fixable),
      assignment.owner,
      assignment.status,
      assignment.notes === undefined ? '—' : escapePipes(assignment.notes),
      '',
    ].join(' | '),
  )

  return [
    '# Rule Inventory',
    '',
    '<!-- GENERATED FILE — do not edit by hand.',
    `     Regenerate with: ${meta.generatedBy} -->`,
    '',
    'Every lint rule this workspace enforces, with the layer accountable for it after the',
    'migration. This is the FR-006 / SC-005 artifact: a rule that is not on this list is not',
    'enforced, and a rule whose owner is `unassigned` is an unfinished migration, not a',
    'detail.',
    '',
    '## Totals',
    '',
    '| Measure | Count |',
    '| --- | ---: |',
    `| Enabled rules | **${String(totals.total)}** |`,
    `| Type-aware (\`meta.docs.requiresTypeChecking\`) | ${String(totals.typeAware)} |`,
    `| Syntactic | ${String(totals.syntactic)} |`,
    `| Unassigned | ${unassigned.length === 0 ? '0' : `**${String(unassigned.length)}**`} |`,
    `| Dropped | ${dropped.length === 0 ? '0' : `**${String(dropped.length)}**`} |`,
    '',
    ...(meta.expectation === undefined
      ? []
      : [
          meta.expectation.count === meta.expectation.expected
            ? `${meta.expectation.label}: **${String(meta.expectation.count)}**, matching ${meta.expectation.source}.`
            : `⚠️ ${meta.expectation.label} is ${String(meta.expectation.count)}, not the ${String(meta.expectation.expected)} recorded in ${meta.expectation.source}. Reconcile before relying on this file.`,
          '',
        ]),
    '## By plugin',
    '',
    '| Plugin | Rules |',
    '| --- | ---: |',
    ...pluginRows,
    '',
    '## Rules',
    '',
    '| Rule | Plugin | Severity | Options | Type-aware | Fixable | Owner | Status | Notes |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...ruleRows,
    '',
  ].join('\n')
}
