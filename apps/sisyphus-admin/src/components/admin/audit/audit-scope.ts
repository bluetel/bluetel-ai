/**
 * What the configuration audit view is narrowed to, and how that survives a reload (FR-177, FR-183).
 *
 * ## One narrowing, carried in the URL
 *
 * The audit view answers "what was changed, by whom, and when". Its one narrowing is the **subject**
 * — the user a change was made *about* — because that is the question an audit is actually asked:
 * not "show me every role change ever", but "what happened to this account". The query string is
 * that state, so an audit trail is a thing an admin can send to a colleague and come back to.
 *
 * ## The subject is validated before it is sent
 *
 * A subject that is not an identifier blocks the read and marks the field. Sending it instead
 * replaces the history with a validation error, which reads as "the audit is broken" rather than as
 * "that is not an id" — the same rule `components/workflows/workflow-filters.ts` follows for the
 * fleet list's id filters.
 *
 * The pattern is restated here because that module keeps its own copy unexported. Hoisting one
 * shared identifier guard into `components/admin` would be the better shape and is a small edit to
 * a file this change does not own.
 */

/** The query-string key the subject travels under. */
export const SUBJECT_PARAM = 'subject'

/** A UUID, in any of the versions this platform issues. */
const IDENTIFIER_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * What the view is narrowed to.
 *
 * `subjectUserId` is `''` rather than `undefined` when unset, because it is bound to a text control
 * and a control whose value flips between `undefined` and a string is an uncontrolled-input warning
 * waiting to happen. The conversion to "absent" happens once, at the query.
 */
export interface AuditScope {
  readonly subjectUserId: string
}

/** Nothing narrowed: every recorded change, newest first. */
export const EMPTY_AUDIT_SCOPE: AuditScope = { subjectUserId: '' }

/** Whether a value is an identifier this view is willing to send. */
export const isIdentifier = (value: string): boolean => IDENTIFIER_PATTERN.test(value.trim())

/** Whether the subject field holds something that is not an identifier. */
export const hasInvalidSubject = (scope: AuditScope): boolean =>
  scope.subjectUserId.trim() !== '' && !isIdentifier(scope.subjectUserId)

/** Whether a subject has been chosen at all. */
export const hasSubject = (scope: AuditScope): boolean => isIdentifier(scope.subjectUserId)

/** Read one value out of a search-param record, taking the first when a key repeats. */
const single = (value: string | readonly string[] | undefined): string => {
  if (value === undefined) return ''
  return (typeof value === 'string' ? value : (value[0] ?? '')).trim()
}

/**
 * Read the scope back out of a URL.
 *
 * A subject that is not an identifier is **dropped rather than passed through**: the query string is
 * caller-supplied text, and forwarding it would turn the audit into a validation error instead of a
 * history.
 *
 * @param params - The page's `searchParams`, as Next.js hands them over.
 */
export const parseAuditScope = (
  params: Readonly<Record<string, string | readonly string[] | undefined>>,
): AuditScope => {
  const subject = single(params[SUBJECT_PARAM])
  return { subjectUserId: isIdentifier(subject) ? subject : '' }
}

/**
 * Write the scope into a URL.
 *
 * An unset subject contributes **no key**, so a cleared filter leaves no trace in the address bar.
 *
 * @param scope - The applied narrowing.
 * @returns The query string without its leading `?`, empty when nothing is narrowed.
 */
export const toAuditSearchParams = (scope: AuditScope): string => {
  const params = new URLSearchParams()
  if (hasSubject(scope)) params.set(SUBJECT_PARAM, scope.subjectUserId.trim())
  return params.toString()
}

/**
 * Turn the scope into the `admin.users.roleChanges` input.
 *
 * The key is omitted entirely when no subject is chosen, rather than sent as `undefined`, so the
 * whole-platform read and the narrowed one are two shapes rather than one shape with a hole in it.
 */
export const toRoleChangesInput = (
  scope: AuditScope,
  limit: number,
): { readonly limit: number; readonly subjectUserId?: string } =>
  hasSubject(scope) ? { limit, subjectUserId: scope.subjectUserId.trim() } : { limit }
