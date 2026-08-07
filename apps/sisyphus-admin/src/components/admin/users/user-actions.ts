import type { ButtonVariant } from '@sisyphus-admin/components/ui'

/**
 * What an admin may do to a user, and how each of those reads (FR-172).
 *
 * There are exactly four changes — grant the admin role, revoke it, deactivate, reactivate — and
 * which two are offered follows from the row's current state. Deriving that here rather than in
 * the card is what puts it under test: "an inactive user is offered reactivate and never
 * deactivate" is a rule, and a rule that only exists inside JSX is a rule nobody re-checks.
 *
 * **Nothing here decides whether a change is allowed.** The never-zero-admins invariant (FR-173) is
 * re-counted inside the server's transaction, and a panel that greyed out the last admin's
 * "revoke" button would be re-deriving that rule from a list that is already stale — two admins
 * demoting each other would both see an enabled button anyway. The panel offers the action and
 * renders the refusal.
 */

/** The four changes, named as the mutation that performs them would be. */
export type UserActionKind = 'grant-admin' | 'revoke-admin' | 'deactivate' | 'reactivate'

/** One offered change: its label, its weight, and the sentence that heads its confirmation. */
export interface UserAction {
  readonly kind: UserActionKind
  /** Sentence case, Archivo — this is a thing a person is doing. */
  readonly label: string
  readonly variant: ButtonVariant
  /** Present participle for the in-flight readout: `Deactivating 0:04`. */
  readonly verb: string
  /** What the change does, stated before it is confirmed. */
  readonly consequence: string
}

const ACTIONS: Readonly<Record<UserActionKind, UserAction>> = {
  'grant-admin': {
    kind: 'grant-admin',
    label: 'Grant admin',
    variant: 'secondary',
    verb: 'Granting',
    consequence:
      'They will be able to configure the platform — bundles, workspaces, profiles, integrations and access — and will see every workflow without holding a grant.',
  },
  'revoke-admin': {
    kind: 'revoke-admin',
    label: 'Revoke admin',
    variant: 'danger',
    verb: 'Revoking',
    consequence:
      'They keep every workflow they own or initiated, and lose configuration access and the platform-wide view. Refused if they are the last active admin.',
  },
  deactivate: {
    kind: 'deactivate',
    label: 'Deactivate',
    variant: 'danger',
    verb: 'Deactivating',
    consequence:
      'They are refused at their next request rather than at next sign-in. Nothing is deleted: their history stays attributed to them, runs they own keep running, and those still in flight are flagged for a new owner.',
  },
  reactivate: {
    kind: 'reactivate',
    label: 'Reactivate',
    variant: 'secondary',
    verb: 'Reactivating',
    consequence:
      'They regain access at their next request, and the reassignment flag is cleared from runs they still own.',
  },
}

/** Look one up. Total over the four kinds, so there is no fallback to get wrong. */
export const userAction = (kind: UserActionKind): UserAction => ACTIONS[kind]

/**
 * The two changes offered for a row.
 *
 * Always exactly two — one role change and one activation change — because every user is either an
 * admin or not and either active or not. A row that offered one would be hiding a state.
 *
 * @param user - The row's current role and active state.
 */
export const availableUserActions = (user: {
  readonly role: string
  readonly isActive: boolean
}): readonly UserAction[] => [
  user.role === 'admin' ? ACTIONS['revoke-admin'] : ACTIONS['grant-admin'],
  user.isActive ? ACTIONS.deactivate : ACTIONS.reactivate,
]
