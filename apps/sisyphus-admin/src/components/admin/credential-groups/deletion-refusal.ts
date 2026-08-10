import { describeTrpcError, readTrpcErrorCode } from '@sisyphus-admin/components/admin'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'

/**
 * Rendering FR-066's deletion refusal, **without collapsing its two conditions into one** (T026).
 *
 * ## The refusal names which condition applies, and the panel keeps that
 *
 * `credentialGroupNotDeletableError` refuses with one line per condition that actually holds:
 *
 * ```
 * The credential group Payments cannot be deleted:
 * - it holds 4 agent credentials; move them to another group or archive them first
 * - it is attached to the execution profiles Payments — delegated; detach it there first
 * Disable it instead to withhold every member from future selection without interrupting any run
 * currently holding one.
 * ```
 *
 * The two conditions are stated separately by the router because **they are fixed in different
 * places**: an attachment is undone on the named profile's own screen, whereas a member credential
 * must be moved into another group or archived first — and a run may be holding it at this moment.
 * A panel that rendered "this group is in use" would send an administrator looking through profiles
 * for an attachment that does not exist when what they actually have is a credential still filed
 * under the group. That is the trial-and-error the router went out of its way to prevent, put back
 * in the browser.
 *
 * So each condition becomes its own `field-error`: a machine code naming the condition and a next
 * action saying where to go, with the router's own sentence — which carries the counts and the
 * profile names — kept verbatim beside it as the fact.
 *
 * ## Why disabling is a control and not only a sentence
 *
 * FR-066's shape is "not deletable, **disableable instead**". The alternative is the requirement,
 * not a consolation, so {@link DISABLE_ALTERNATIVE} is the sentence every refusal carries and the
 * card that renders it puts the Disable control directly under it. A refusal that named no way
 * forward would leave the administrator with a group they can neither remove nor withdraw.
 *
 * ## Why the condition is read from the sentence
 *
 * A thrown `TRPCError` reaches the browser as a code and a message; the router's structured
 * `CredentialGroupReferences` is not on the wire for a *refused* delete. Matching on the phrasing
 * is therefore the only classification available, and it is a **narrowing**: an unmatched line
 * still gets a code, an action and its own text, so a condition the router grows tomorrow degrades
 * to a generic entry rather than disappearing.
 */

/** The opening line, which names the group rather than a condition. */
const PREAMBLE_HEAD = 'The credential group '
const PREAMBLE_TAIL = 'cannot be deleted:'

/**
 * Which of FR-066's two conditions a line is about.
 *
 * Closed, and deliberately the same vocabulary the *counts* on a group card use — see
 * `deletionBlockersFromCounts` in `./group-listing` — so the condition an administrator reads
 * before pressing Delete and the one they read after a refusal are named identically. Two
 * vocabularies for one rule would make the second reading look like a new problem.
 */
export const DELETION_CONDITIONS = [
  'credential_member',
  'profile_attachment',
  'unclassified',
] as const

export type DeletionCondition = (typeof DELETION_CONDITIONS)[number]

/** `E_CREDENTIAL_GROUP_PROFILE_ATTACHMENT` — searchable, stable, and quotable in a ticket. */
export const deletionConditionCode = (condition: DeletionCondition): string =>
  `E_CREDENTIAL_GROUP_${condition.toUpperCase()}`

/**
 * What to do about each condition. Never a restatement of what blocked the delete.
 *
 * Both name **where** the fix happens, because that is the entire reason the two are reported
 * separately: one is a job on the credentials screen, the other a job on each profile's own screen.
 */
export const DELETION_ACTIONS: Readonly<Record<DeletionCondition, string>> = {
  credential_member:
    'Move every credential in this group to another group, or archive it, on the credentials screen — then delete the group. Disabling the group instead withholds all of them without moving any.',
  profile_attachment:
    'Detach the group on the credential groups screen of each execution profile the line names, then delete it. Disabling the group instead leaves the attachments in place and withholds the credentials.',
  unclassified:
    'Clear what the line names, then delete again — or disable the group, which is what FR-066 offers in place of deleting one that is in use.',
}

/**
 * The alternative FR-066 requires to be offered, in the panel's own words.
 *
 * Kept as a constant rather than lifted from the message so the card can render it beside a Disable
 * button even when it is showing the counts ahead of an attempt, where there is no message to lift
 * it from.
 */
export const DISABLE_ALTERNATIVE =
  'Disable it instead: every credential in the group is withheld from future selection, and no run currently holding one is interrupted.'

/** One condition, as the card renders it. */
export interface DeletionConditionNotice {
  readonly condition: DeletionCondition
  /** The router's own sentence, verbatim — it carries the counts and the profile names. */
  readonly detail: string
  /** A code and a next action. What to do about it, and where. */
  readonly error: FieldErrorContent
}

/** Which condition one line is about, read from the phrasing the router uses. */
export const classifyDeletionCondition = (line: string): DeletionCondition => {
  if (line.includes('it holds')) return 'credential_member'
  if (line.includes('attached to the execution')) return 'profile_attachment'
  return 'unclassified'
}

/**
 * Split a refusal into one notice per condition that actually applies (FR-066).
 *
 * Only the list lines are read. The preamble names the group, and the closing sentence is the
 * disable alternative — neither is a condition, and rendering either as one would report a problem
 * that is not there.
 *
 * @param message - The router's multi-line refusal, exactly as it arrived.
 * @returns One notice per condition, in the order the router reported them. Empty when the message
 *   carries no list, which is the caller's signal to fall back to the ordinary refusal.
 */
export const readDeletionConditions = (message: string): readonly DeletionConditionNotice[] =>
  message
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('-'))
    .map((line) => line.replace(/^-\s*/, '').trim())
    .filter((detail) => detail !== '')
    .map((detail) => {
      const condition = classifyDeletionCondition(detail)
      return {
        condition,
        detail,
        error: { code: deletionConditionCode(condition), action: DELETION_ACTIONS[condition] },
      }
    })

/** Read the message off whatever the mutation hook handed back. */
const readMessage = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) return undefined
  const { message } = error as { message?: unknown }
  return typeof message === 'string' ? message : undefined
}

/** What the card shows after a refused delete: the conditions where there are any, one refusal otherwise. */
export interface DeletionRefusal {
  /** One entry per condition FR-066 refused on. Empty for a refusal that named none. */
  readonly conditions: readonly DeletionConditionNotice[]
  /** The whole-request refusal, always present, so a dead end cannot exist. */
  readonly error: FieldErrorContent
}

/**
 * Describe a refused delete.
 *
 * FR-066's refusal is a `CONFLICT` carrying the list. Anything else — a group somebody else
 * archived first, a lost session — goes through the shared mapping, because those are not FR-066
 * conditions and presenting them as such would put an administrator to work moving credentials that
 * are fine.
 */
export const describeDeletionRefusal = (error: unknown): DeletionRefusal => {
  const code = readTrpcErrorCode(error)
  const message = readMessage(error)
  const isFr066 =
    code === 'CONFLICT' &&
    message?.startsWith(PREAMBLE_HEAD) === true &&
    message.includes(PREAMBLE_TAIL)

  // `isFr066` narrows `message` to a string, which is why nothing here re-checks it.
  const conditions = isFr066 ? readDeletionConditions(message) : []

  return {
    conditions,
    error:
      conditions.length === 0
        ? describeTrpcError(error, {
            CONFLICT: {
              code: 'E_CREDENTIAL_GROUP_DELETE_REFUSED',
              action: `Nothing changed. Read the refusal and clear what it names. ${DISABLE_ALTERNATIVE}`,
            },
            NOT_FOUND: {
              code: 'E_CREDENTIAL_GROUP_NOT_FOUND',
              action:
                'Reload the list — the credential group you were changing is no longer there.',
            },
          })
        : {
            code: 'E_CREDENTIAL_GROUP_DELETE_REFUSED',
            action: `Nothing changed. ${String(conditions.length)} ${conditions.length === 1 ? 'condition applies' : 'conditions apply'}, listed below and each fixed in a different place. ${DISABLE_ALTERNATIVE}`,
          },
  }
}
