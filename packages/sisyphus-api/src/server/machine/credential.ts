import { TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'

import { scopedCredentials } from '../../db'
import { assertMachineWorkflowMatches } from '../procedures'

import { SCOPED_CREDENTIAL_WINDOW_MS } from './credential-claims'
import type { MachineContext } from './guard'
import { firstRow, isTerminalState, loadMachineWorkflow } from './guard'

/**
 * `machine.renewCredential` — keeping a long run alive without ever issuing a long-lived
 * credential (FR-037).
 *
 * ## Why this extends a row rather than handing back a new secret
 *
 * The credential is **database-backed**: `scoped_credentials` carries the `jti`, the expiry, the
 * renewal count and the revocation timestamp, and the verifier the host application injects
 * (`resolveMachineCredential`) is what consults it. So the row *is* the authority on whether a
 * credential is still good, and extending the row is what extends validity. Nothing new has to
 * cross the wire, which is the point: a renewal that minted and returned fresh secret material
 * would put a credential in a response body, in a retry buffer, and — on the FR-047 backoff path —
 * in an executor's memory for as long as the surface stayed unreachable.
 *
 * Minting remains the control plane's job (FR-037). This procedure cannot create a credential,
 * cannot widen one's scope, and cannot revive a revoked one; the only thing it can move is the
 * expiry of the row the caller is already authenticated against.
 *
 * ## Why the window is short and stays short
 *
 * Each renewal buys {@link CREDENTIAL_RENEWAL_WINDOW_MS} from *now*, never a multiple of it, so a
 * credential's remaining life is bounded by the interval regardless of how many times it has been
 * renewed. `renewal_count` is incremented so an instance renewing implausibly often is visible in
 * the record rather than merely long-lived.
 */

/**
 * How long one renewal is good for. Short by requirement, not by preference (FR-037).
 *
 * An alias of the window the mint opens rather than a second literal. The two were once separate
 * constants in separate packages, kept equal by an assertion; they are now the same value, so the
 * window a mint opens and the window a renewal reopens cannot come apart at all.
 */
export const CREDENTIAL_RENEWAL_WINDOW_MS = SCOPED_CREDENTIAL_WINDOW_MS

/** The audit path recorded against a cross-workflow renewal. */
export const RENEW_CREDENTIAL_PATH = 'machine.renewCredential'

/** What `renewCredential` answers with. Serialisable and stable — it is the executor's contract. */
export interface RenewedCredential {
  readonly credentialId: string
  /** Unchanged. Present so the executor can confirm it renewed the credential it is holding. */
  readonly jti: string
  readonly expiresAt: Date
  readonly renewalCount: number
}

/** A revoked credential is finished; renewing one would undo the revocation. */
export const credentialRevokedError = (): TRPCError =>
  new TRPCError({ code: 'UNAUTHORIZED', message: 'This credential has been revoked.' })

/** A run that has reached its outcome has nothing left to report. */
export const terminalRenewalError = (): TRPCError =>
  new TRPCError({
    code: 'CONFLICT',
    message: 'This workflow has finished and its credential will not be renewed.',
  })

/**
 * Extend the caller's own credential.
 *
 * @param ctx - The machine resolver context.
 * @param now - Injectable clock, so the expiry arithmetic is testable without waiting.
 */
export const renewCredential = async (
  ctx: MachineContext,
  now: Date = new Date(),
): Promise<RenewedCredential> => {
  const stored = firstRow(
    await ctx.db
      .select()
      .from(scopedCredentials)
      .where(eq(scopedCredentials.id, ctx.credential.credentialId))
      .limit(1),
  )

  if (stored === undefined) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'This credential is not recognised.' })
  }

  // The credential row names a workflow of its own. It should always be the one the middleware
  // put on the context, and if it ever is not, the request is a cross-workflow write by
  // definition — so it is refused and recorded like any other (FR-018).
  await assertMachineWorkflowMatches(ctx, stored.workflowId, RENEW_CREDENTIAL_PATH)

  if (stored.revokedAt !== null) {
    throw credentialRevokedError()
  }

  const workflow = await loadMachineWorkflow(ctx)
  if (isTerminalState(workflow.state)) {
    throw terminalRenewalError()
  }

  const expiresAt = new Date(now.getTime() + CREDENTIAL_RENEWAL_WINDOW_MS)

  const renewed = firstRow(
    await ctx.db
      .update(scopedCredentials)
      .set({ expiresAt, renewalCount: stored.renewalCount + 1 })
      .where(eq(scopedCredentials.id, stored.id))
      .returning(),
  )

  if (renewed === undefined) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'The credential could not be renewed.',
    })
  }

  return {
    credentialId: renewed.id,
    jti: renewed.jti,
    expiresAt: renewed.expiresAt,
    renewalCount: renewed.renewalCount,
  }
}
