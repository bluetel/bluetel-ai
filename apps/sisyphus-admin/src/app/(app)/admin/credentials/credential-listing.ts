import { formatTimestamp, NEVER } from '@sisyphus-admin/components/admin'
import type { RouterOutputs } from '@sisyphus-admin/trpc'

/**
 * Turning one listed credential into what the row renders (T034, FR-009).
 *
 * Pure, and separate from the row that renders it, so the two decisions worth getting wrong are
 * testable without a query client:
 *
 * 1. **What the seat is waiting for.** `state` alone does not answer it — a seat can be
 *    `available`, enabled, and still unusable because the group it sits in was withdrawn — so the
 *    server's `selectable` verdict and the reason it disagrees with the state are worked out here,
 *    once, rather than in a chain of ternaries inside JSX.
 * 2. **What is shown when a login failed.** FR-009 requires the reason to be visible against the
 *    credential. It is rendered verbatim: the server writes a provider's own words there — or the
 *    platform's, about why a login environment could not be started or was reaped — and
 *    paraphrasing them in the panel would put the panel between an administrator and the only
 *    evidence they have.
 */

/** One seat as `admin.credentials.list` returns it. Never a hand-written mirror of that shape. */
export type CredentialListItem = RouterOutputs['admin']['credentials']['list']['items'][number]

/** One seat, shaped for the row. */
export interface CredentialReadout {
  readonly id: string
  readonly name: string
  readonly credentialGroupName: string
  readonly state: string
  readonly enabled: boolean
  readonly archived: boolean
  /** Whether a run could be given this seat right now — the server's verdict, never re-derived. */
  readonly selectable: boolean
  /** Why it is not selectable, in a sentence, or `undefined` when it is. */
  readonly withheldBecause?: string
  /** The Secrets Manager name, or `undefined` when no login has been recorded. Never material. */
  readonly secretId?: string
  readonly lastLogin: string
  readonly lastUsed: string
  readonly lastFailureReason?: string
}

/**
 * Why this seat is not a candidate, in the administrator's terms.
 *
 * The order is the order a fix would be attempted in, not the order the predicate evaluates in: an
 * archived seat cannot be brought back at all, a withdrawn pool is one switch, a disabled seat is
 * another, and a seat that never completed a login needs the whole registration finishing. Naming
 * only the first applicable condition is deliberate — an administrator given four reasons at once
 * has to work out which one to act on, and the first is always the one that must be dealt with
 * before any of the others matters.
 */
const withheldBecause = (credential: CredentialListItem): string | undefined => {
  if (credential.selectable) {
    return undefined
  }

  if (credential.archivedAt !== null) {
    return 'deleted — kept so the runs that used it can still say what identity they worked as'
  }

  if (!credential.credentialGroupEnabled) {
    return `its group ${credential.credentialGroupName} is disabled, which withholds every seat in it`
  }

  if (!credential.enabled) {
    return 'disabled — withheld from future selection, without interrupting any run holding it'
  }

  if (credential.secretId === null) {
    return 'no login has been completed for it, so there is nothing for a run to fetch'
  }

  if (credential.state === 'held') {
    return 'a run is holding it'
  }

  return `it is ${credential.state}`
}

/** Shape a listed credential for the row. */
export const toCredentialReadout = (credential: CredentialListItem): CredentialReadout => ({
  id: credential.id,
  name: credential.name,
  credentialGroupName: credential.credentialGroupName,
  state: credential.state,
  enabled: credential.enabled,
  archived: credential.archivedAt !== null,
  selectable: credential.selectable,
  ...(withheldBecause(credential) === undefined
    ? {}
    : { withheldBecause: withheldBecause(credential) }),
  ...(credential.secretId === null ? {} : { secretId: credential.secretId }),
  lastLogin: credential.lastLoginAt === null ? NEVER : formatTimestamp(credential.lastLoginAt),
  lastUsed: credential.lastUsedAt === null ? NEVER : formatTimestamp(credential.lastUsedAt),
  ...(credential.lastFailureReason === null
    ? {}
    : { lastFailureReason: credential.lastFailureReason }),
})
