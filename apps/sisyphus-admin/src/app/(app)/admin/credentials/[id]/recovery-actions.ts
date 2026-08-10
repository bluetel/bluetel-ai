import type { RouterOutputs } from '@sisyphus-admin/trpc'

/**
 * What an administrator may do to one seat, and what they should do **next** (T121, 003/FR-005,
 * FR-006, FR-010, FR-057, FR-072, SC-012).
 *
 * Pure and separate from the panel that renders it, because the interesting content of US9 is not
 * the four buttons — it is the **order**, and an order is a decision worth testing without a query
 * client.
 *
 * ## The order is the requirement
 *
 * SC-012 asks that a broken credential be returnable to service in under five minutes, and the
 * reason that is not automatic is that the obvious first move does not work on its own. Disabling
 * withholds a seat from *future* selection and deliberately evicts nobody (FR-006), so a broken
 * credential that a long-running workflow is sitting on stays held — and a held seat cannot be
 * re-logged-in, because `startLogin` refuses one: replacing the material of an identity a run is
 * authenticated as would invalidate the copy that run is using, mid-flight, with nothing to tell it
 * why its next call failed.
 *
 * So the recovery is three steps and they only work in this sequence:
 *
 * 1. **Disable** — stop the pool handing the broken seat to anybody else while it is being fixed.
 * 2. **Force-release** — take it back from the run holding it. This ends that run (FR-023 forbids
 *    moving a workflow to another credential, so there is nothing else it could do) and it is the
 *    only step that costs anybody anything, which is why the panel says so before it is pressed.
 * 3. **Log in again** — the identical flow a first login uses (FR-072), which is what puts the seat
 *    back into service.
 *
 * An administrator who has never done this before will otherwise press Disable, find that nothing
 * improved, and go looking for the reason in the wrong place. {@link RecoveryAffordances.nextStep}
 * is that reason, stated before they look.
 *
 * ## Delete is offered and expected to be refused
 *
 * FR-005 refuses deleting a credential any workflow has ever held, and the refusal is the point: it
 * names how many times the seat was leased and offers disabling instead. That refusal lives on the
 * server, where the lease count is, and this module does not attempt to predict it — a panel that
 * hid the button whenever it guessed the answer would be a second implementation of FR-005, and the
 * one that is wrong is the one an administrator sees. So the control is always offered on a live
 * seat, and what comes back is rendered verbatim.
 */

/** One seat as `admin.credentials.get` returns it. Never a hand-written mirror of that shape. */
export type CredentialDetail = RouterOutputs['admin']['credentials']['get']

/** What the panel may offer, and what it should say. */
export interface RecoveryAffordances {
  readonly canDisable: boolean
  readonly canEnable: boolean
  /** Only when a run is actually holding it — there is otherwise nothing to take back. */
  readonly canForceRelease: boolean
  /** The two states a login is the remedy for, and the same pair the router refuses out of. */
  readonly canLogIn: boolean
  /** Always true for a live seat: FR-005's refusal is the server's, and is rendered when it comes. */
  readonly canAttemptDelete: boolean
  /** One sentence naming the next step in the recovery, or `undefined` when the seat is fine. */
  readonly nextStep?: string
}

/**
 * What to do about one seat, in one sentence.
 *
 * Written as an ordered list of conditions rather than a lookup on `state`, because the answer is
 * not a function of the state alone: an `unhealthy` seat that a run is still holding and an
 * `unhealthy` seat that is free need different next moves, and the difference between them is the
 * whole of why force-release exists.
 */
const nextStepFor = (credential: CredentialDetail): string | undefined => {
  if (credential.archivedAt !== null) {
    return 'This seat has been deleted. It is kept so the runs that used it can still say what identity they worked as, and it cannot be brought back into service.'
  }

  if (credential.state === 'unhealthy' && credential.enabled) {
    return 'This seat is broken. Disable it first, so the pool stops offering it while you work on it.'
  }

  if (credential.state === 'unhealthy') {
    return 'Disabled and broken. Log in again to put it back into service — it is the same login a new seat goes through, not a repair mode.'
  }

  if (credential.state === 'held' && !credential.enabled) {
    return 'Disabled, and a run is still holding it — disabling withholds a seat from future selection and interrupts nothing. Force-release it to take it back, which ends that run, and then log in again.'
  }

  if (credential.state === 'held') {
    return 'A run is holding this seat. Disable it before forcing it free, or the pool may hand it to another run in between.'
  }

  if (credential.state === 'awaiting_login') {
    return 'No login has ever been completed for this seat, so there is nothing for a run to fetch. Log in to put it into service.'
  }

  if (credential.state === 'cooling_off') {
    return 'A provider limit is in force. This clears by itself and needs nobody: the seat returns to the pool when the limit lifts, and no run has been failed for it.'
  }

  if (!credential.enabled) {
    return 'Disabled. It works — it is simply being withheld from selection. Enable it to return it to the pool.'
  }

  if (!credential.credentialGroupEnabled) {
    return `This seat is fine, but its group ${credential.credentialGroupName} is disabled, which withholds every seat in it. Nothing about this credential will change that.`
  }

  return undefined
}

/**
 * Which recovery controls this seat admits.
 *
 * @param credential - The seat, as the router answered.
 */
export const recoveryAffordancesFor = (credential: CredentialDetail): RecoveryAffordances => {
  const live = credential.archivedAt === null

  return {
    canDisable: live && credential.enabled,
    canEnable: live && !credential.enabled,
    // A seat is held by exactly one run or by nobody; `held` is how the row says which.
    canForceRelease: live && credential.state === 'held',
    // The same two states `LOGIN_ENTRY_STATES` admits, so the panel never offers what the server
    // will decline — and never withholds re-login, which is FR-072's whole point.
    canLogIn: live && (credential.state === 'awaiting_login' || credential.state === 'unhealthy'),
    canAttemptDelete: live,
    ...(nextStepFor(credential) === undefined ? {} : { nextStep: nextStepFor(credential) }),
  }
}

/**
 * What the administrator is told before they force a seat free.
 *
 * Stated as a constant so it is asserted rather than reviewed. Force-release is the one control on
 * this screen that ends somebody else's run, and the confirmation has to say **that** rather than
 * "are you sure": the cost is not to the seat, it is to a workflow that is currently working, and
 * an administrator recovering a credential at speed will not otherwise think about it.
 */
export const FORCE_RELEASE_WARNING =
  'Forcing this seat free ends the run currently holding it. A workflow is never moved to a different agent credential, so there is nothing for that run to continue on — it is failed, naming this credential, and its owner can relaunch it once the seat is back in service.'
