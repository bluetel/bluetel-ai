/* cspell:words issuekey issuetype */
import type { ResolvedJiraConfig } from './config'

/**
 * Building the discovery query (T110, FR-101).
 *
 * ## Why the escaping is not optional
 *
 * Every value in the query comes from a text field an admin typed into the panel — the project
 * key, the label, the extra filters. A label of `x" OR project = "OTHER` concatenated straight
 * into a query does not fail; it *succeeds*, against a project the integration was never scoped
 * to, and every ticket it returns becomes a candidate the control plane will happily start a paid
 * run for. That is the failure this module exists to prevent, and it is asserted directly in the
 * tests rather than left implied by the escaping.
 *
 * ## Why the ordering clause is part of the query rather than a nicety
 *
 * Discovery pages by offset. An unordered result set has no stable offset, so page two of an
 * unordered query can repeat rows from page one and skip others entirely — silently losing a
 * ticket that matched (FR-108). `ORDER BY` is what makes `startAt` mean anything.
 */

/** Field names Jira accepts unquoted. Anything else — a custom field with spaces — gets quoted. */
const BARE_FIELD = /^[A-Za-z][A-Za-z0-9_]*$/
const CUSTOM_FIELD = /^cf\[\d+\]$/

/** Oldest first, and tie-broken, so paging by offset is stable across pages. */
export const DISCOVERY_ORDER = 'ORDER BY created ASC, issuekey ASC'

/**
 * Escape a value for use inside a double-quoted JQL string.
 *
 * @param value - Whatever the admin typed.
 * @returns The body of the quoted string, with quotes and escapes neutralised.
 */
export const escapeJqlValue = (value: string): string =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')

/** A value, quoted and escaped. */
export const jqlString = (value: string): string => `"${escapeJqlValue(value)}"`

/**
 * A field name, quoted only where it has to be.
 *
 * @param name - The field an extra filter names.
 */
export const jqlField = (name: string): string =>
  BARE_FIELD.test(name) || CUSTOM_FIELD.test(name) ? name : jqlString(name)

/** `field = "x"` for one value, `field IN ("x","y")` for several. */
export const jqlClause = (name: string, value: string | readonly string[]): string => {
  const field = jqlField(name)

  if (typeof value === 'string') {
    return `${field} = ${jqlString(value)}`
  }

  if (value.length === 1) {
    return `${field} = ${jqlString(value[0])}`
  }

  return `${field} IN (${value.map(jqlString).join(', ')})`
}

/**
 * The query one tick runs.
 *
 * Scoped by project and by the label that marks a ticket for autonomous delivery, plus whatever
 * else the integration was configured with. The clauses are emitted in a fixed order — project,
 * label, then extra filters by field name — so the same configuration produces the same string
 * every time, which is what lets a test hold it exactly and makes a diff of it meaningful.
 *
 * @param config - The resolved board configuration.
 * @returns A complete JQL query, ordered for stable offset paging.
 */
export const buildDiscoveryJql = (config: ResolvedJiraConfig): string => {
  const clauses = [
    jqlClause('project', config.projectPrefix),
    jqlClause('labels', config.label),
    ...Object.entries(config.extraFilters ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => jqlClause(name, value)),
  ]

  return `${clauses.join(' AND ')} ${DISCOVERY_ORDER}`
}
