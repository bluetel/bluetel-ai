import type { WorkflowState, WorkflowType } from '@bluetel-ai/sisyphus-api/client'
import { isWorkflowState, isWorkflowType } from '@bluetel-ai/sisyphus-api/client'
import type { RouterInputs } from '@sisyphus-admin/trpc'

/**
 * What the fleet list is narrowed by, and how that narrowing survives a reload (FR-013).
 *
 * ## The filters are carried in the URL, not in component state alone
 *
 * A filtered list is a thing an operator sends to a colleague — "look at the failed runs on this
 * repository" — and a thing they come back to after following a run into its detail view. Both
 * need the query string to *be* the filter state, so this module is the one translation between
 * the three representations that exist: the URL's search params, the form's draft values, and the
 * procedure's input.
 *
 * Keeping all three conversions in one pure module is what makes them testable. A filter that
 * serialises to a key the parser does not read is a filter that silently resets on reload, and
 * that is a bug no component test would catch.
 *
 * ## Nothing here decides visibility
 *
 * Narrowing only. `workflow.list` composes every one of these inside the FR-190 base selector, so
 * the worst a hostile query string can do is match nothing — it cannot widen the result set beyond
 * what the caller was already permitted to see, and this module must never grow a field that
 * pretends otherwise.
 */

/** The `workflow.list` input, inferred. Never a hand-written mirror of the procedure's shape. */
export type ListWorkflowsInput = RouterInputs['workflow']['list']

/**
 * The filter values a person is editing.
 *
 * Text fields are `''` rather than `undefined` when unset, because they are bound to controls and
 * a control whose value flips between `undefined` and a string is an uncontrolled-input warning
 * waiting to happen. The conversion to "absent" happens once, in {@link toListInput}.
 */
export interface WorkflowFilters {
  /** Ticket reference or result branch — the two identifiers a person remembers a run by. */
  readonly search: string
  readonly states: readonly WorkflowState[]
  readonly type: WorkflowType | undefined
  readonly repositoryUrl: string
  readonly initiatedByUserId: string
  readonly originatingIntegrationId: string
  readonly executionProfileId: string
  readonly workspaceId: string
  readonly setupBundleId: string
}

/** Nothing narrowed: every run the caller may see, newest first. */
export const EMPTY_FILTERS: WorkflowFilters = {
  search: '',
  states: [],
  type: undefined,
  repositoryUrl: '',
  initiatedByUserId: '',
  originatingIntegrationId: '',
  executionProfileId: '',
  workspaceId: '',
  setupBundleId: '',
}

/**
 * The filters that name a row by id, and the query-string key each is carried under.
 *
 * Short keys, because these end up in a URL an operator pastes into a message. The map is the
 * single source for both directions — a key added here is read and written by the same edit, which
 * is what stops a filter serialising under one name and parsing under another.
 */
export const ID_FILTER_KEYS = {
  initiatedByUserId: 'user',
  originatingIntegrationId: 'integration',
  executionProfileId: 'profile',
  workspaceId: 'workspace',
  setupBundleId: 'bundle',
} as const satisfies Partial<Record<keyof WorkflowFilters, string>>

/** The id-bearing filter names, as a list, so callers iterate rather than restate them. */
export const ID_FILTER_NAMES = Object.keys(
  ID_FILTER_KEYS,
) as readonly (keyof typeof ID_FILTER_KEYS)[]

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Which id filters hold something that is not an identifier.
 *
 * The panel refuses to run a query while this is non-empty, and the bar says which field is at
 * fault. The alternative — sending it and letting the server refuse — turns one mistyped character
 * into an error where the list used to be, which reads as "the list is broken" rather than as
 * "that is not an id".
 *
 * @param filters - The draft values.
 * @returns The offending field names, in a stable order.
 */
export const invalidIdFilters = (
  filters: WorkflowFilters,
): readonly (keyof typeof ID_FILTER_KEYS)[] =>
  ID_FILTER_NAMES.filter((name) => {
    const value = filters[name].trim()
    return value !== '' && !UUID_PATTERN.test(value)
  })

/** Read one value out of a search-param record, taking the first when a key repeats. */
const single = (value: string | readonly string[] | undefined): string => {
  if (value === undefined) return ''
  return (typeof value === 'string' ? value : (value[0] ?? '')).trim()
}

/** Read every value for a key, so `?state=running&state=paused` is two states and not one. */
const many = (value: string | readonly string[] | undefined): readonly string[] => {
  if (value === undefined) return []
  return typeof value === 'string' ? [value] : value
}

/**
 * Read filters back out of a URL.
 *
 * Unknown states and types are **dropped rather than passed through**. The query string is
 * caller-supplied text — a hand-edited URL, a stale link from before a state was renamed — and
 * forwarding `state=deleted` would turn the list into a validation error instead of a list.
 *
 * @param params - The page's `searchParams`, as Next.js hands them over.
 */
export const parseWorkflowFilters = (
  params: Readonly<Record<string, string | readonly string[] | undefined>>,
): WorkflowFilters => {
  const type = single(params.type)

  return {
    search: single(params.q),
    states: many(params.state).filter((value): value is WorkflowState => isWorkflowState(value)),
    type: isWorkflowType(type) ? type : undefined,
    repositoryUrl: single(params.repo),
    initiatedByUserId: single(params.user),
    originatingIntegrationId: single(params.integration),
    executionProfileId: single(params.profile),
    workspaceId: single(params.workspace),
    setupBundleId: single(params.bundle),
  }
}

/**
 * Write filters into a URL.
 *
 * An unset filter contributes **no key**, so a cleared filter leaves no trace in the address bar:
 * `?state=` and "no state filter" would otherwise be different-looking URLs for the same list.
 *
 * @param filters - The applied values.
 * @returns The query string without its leading `?`, empty when nothing is narrowed.
 */
export const toSearchParams = (filters: WorkflowFilters): string => {
  const params = new URLSearchParams()

  if (filters.search.trim() !== '') params.set('q', filters.search.trim())
  for (const state of filters.states) params.append('state', state)
  if (filters.type !== undefined) params.set('type', filters.type)
  if (filters.repositoryUrl.trim() !== '') params.set('repo', filters.repositoryUrl.trim())
  for (const name of ID_FILTER_NAMES) {
    const value = filters[name].trim()
    if (value !== '') params.set(ID_FILTER_KEYS[name], value)
  }

  return params.toString()
}

/** How many rows one page holds. Bounded by `pageLimit` on the schema; this is well inside it. */
export const WORKFLOW_PAGE_SIZE = 25

/**
 * Turn filters into the procedure's input.
 *
 * `cursor` is deliberately absent. Paging is `useInfiniteQuery`'s job and the cursor it supplies is
 * the id of the last row the caller was shown — a keyset predicate, never an offset. Building the
 * cursor into the filters would make a filter change and a page turn the same kind of event, and
 * the list would page from a row belonging to the previous filter set.
 *
 * An empty `states` omits the key entirely: the schema requires at least one member when present,
 * so sending `[]` is a validation error rather than "any state".
 *
 * @param filters - The applied values.
 * @param limit - Page size; defaults to {@link WORKFLOW_PAGE_SIZE}.
 */
export const toListInput = (
  filters: WorkflowFilters,
  limit: number = WORKFLOW_PAGE_SIZE,
): ListWorkflowsInput => ({
  limit,
  ...(filters.search.trim() === '' ? {} : { search: filters.search.trim() }),
  ...(filters.states.length === 0 ? {} : { state: [...filters.states] }),
  ...(filters.type === undefined ? {} : { type: filters.type }),
  ...(filters.repositoryUrl.trim() === '' ? {} : { repositoryUrl: filters.repositoryUrl.trim() }),
  ...(filters.initiatedByUserId.trim() === ''
    ? {}
    : { initiatedByUserId: filters.initiatedByUserId.trim() }),
  ...(filters.originatingIntegrationId.trim() === ''
    ? {}
    : { originatingIntegrationId: filters.originatingIntegrationId.trim() }),
  ...(filters.executionProfileId.trim() === ''
    ? {}
    : { executionProfileId: filters.executionProfileId.trim() }),
  ...(filters.workspaceId.trim() === '' ? {} : { workspaceId: filters.workspaceId.trim() }),
  ...(filters.setupBundleId.trim() === '' ? {} : { setupBundleId: filters.setupBundleId.trim() }),
})

/** Whether anything is narrowed at all, so the bar can offer to clear only when there is something to clear. */
export const hasActiveFilters = (filters: WorkflowFilters): boolean =>
  toSearchParams(filters) !== ''
