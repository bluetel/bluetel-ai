import { TRPCError } from '@trpc/server'
import { and, eq, isNull } from 'drizzle-orm'

import type {
  FetchAgentCredentialOutput,
  ReportCredentialRotationInput,
  ReportCredentialRotationOutput,
} from '../../contracts'
import { fetchAgentCredentialInput, reportCredentialRotationInput } from '../../contracts'
import { agentCredentials, credentialLeases, workflows } from '../../db'
import { machineProcedure } from '../procedures'

import type { AgentCredentialMaterialStore } from './credential-material'
import { agentCredentialMaterialStore } from './credential-material'
import type { MachineContext } from './guard'
import { firstRow } from './guard'

/**
 * **The machine surface's two credential calls** — the only place in the platform where agent
 * credential material is handed out or taken in (FR-012, FR-014, FR-020, FR-030, FR-032).
 *
 * `contracts/agent-credential.ts` fixes the shapes; this is what stands behind them. Everything
 * else this feature does — selecting, leasing, queueing, releasing, the pool view — moves
 * identifiers and never touches material at all, which is why these two resolvers are the whole of
 * SC-014's exposure and are kept in one small module that can be read in full.
 *
 * ## Neither procedure has a parameter for naming a seat, and that is the security property
 *
 * `fetchAgentCredentialInput` is empty and `reportCredentialRotationInput` carries a fence and a
 * payload. The seat is resolved **server-side from `ctx.workflowId`**, which `machineProcedure` put
 * there from the scoped credential the request arrived with (002, FR-018). So a caller cannot ask
 * for somebody else's credential, because there is nowhere in the payload to write the request —
 * and both schemas are `.strict()`, so an attempt to invent one is a refusal the caller sees rather
 * than a key zod silently strips.
 *
 * That is why neither resolver calls `assertMachineWorkflowMatches`, and its absence here is not an
 * omission. That helper exists for the payload fields that *can* reach outside a run — the
 * `entryId` on `registerArtifact`, the `sessionId` on `registerSnapshot`, the credential row behind
 * `renewCredential`. Nothing on this surface has one. There is no claim to compare, so there is
 * nothing to refuse and nothing to record; the guarantee is structural rather than checked.
 *
 * ## The two procedures resolve the seat differently, and the difference is FR-032
 *
 * This is the one thing in this module that is easy to get wrong, and getting it wrong strands a
 * credential.
 *
 * **`fetchAgentCredential` resolves through the live lease.** It is called from bootstrap phase
 * `credential_install`, by an instance that is about to start work, and "the seat this run holds
 * *now*" is exactly the right question — a run whose lease has been force-released must not be
 * handed material to carry on with. Finding no live lease is a control-plane bug rather than a
 * normal path (FR-016 reserves the seat at admission, before any compute exists), so it is an
 * error.
 *
 * **`reportCredentialRotation` resolves through `workflows.agent_credential_id`.** FR-032 requires
 * that a rotation arriving *after* its workflow has terminated is still stored when its fence is
 * current — and by then the lease is gone, because FR-019 releases it at exactly that moment. A
 * rotation path that resolved through the live lease would therefore reject the one case the
 * requirement is about, and the symptom would be a seat whose stored material the provider has
 * already invalidated, discovered by the *next* run to be given it. `workflows.agent_credential_id`
 * is the durable record of which identity a run used (FR-059) and is never cleared, so it answers
 * "which seat is this rotation about" for a live run and a finished one alike.
 *
 * The consequence, stated so it is not later "tidied up": **nothing in the rotation path reads
 * `credential_leases` or `workflows.state`.** Post-terminal acceptance is satisfied by omission
 * rather than by a special case, which is the same construction — and the same reasoning —
 * `apps/sisyphus-control-plane/src/credentials/lease/fence.ts` records for the fence comparison
 * itself. A special case could be dropped by someone who did not know why it was there; there is
 * nothing here to drop.
 *
 * ## Rejections are answered, never thrown
 *
 * A rejected rotation means the caller has already lost its claim, or has nothing new to say.
 * Raising either as a transport error would turn it into a retry storm from an instance whose every
 * attempt is going to be refused for the same reason (FR-020, and the contract's own note).
 *
 * A **store failure is the opposite case and does throw.** "Secrets Manager was unreachable" is not
 * one of the two rejections — those both mean the write was refused on its merits — and answering
 * one for it would drop a rotation while telling the instance it was expected. An error is what the
 * executor's FR-047 backoff retries.
 */

/**
 * The credential a workflow is entitled to, as resolved from the database rather than the payload.
 * Internal: nothing outside this module gets to construct one, because constructing one is the act
 * of deciding whose seat a call is about.
 */
interface ResolvedSeat {
  readonly credentialId: string
  /** The credential's fence **now**, not the value the lease was issued. */
  readonly fence: number
  readonly secretId: string | null
}

/** The columns both resolvers need, in one place so the two cannot drift. */
const seatColumns = {
  credentialId: agentCredentials.id,
  fence: agentCredentials.fence,
  secretId: agentCredentials.secretId,
} as const

/**
 * The caller's workflow holds no live lease.
 *
 * `PRECONDITION_FAILED` rather than `NOT_FOUND`: the workflow exists and the request was properly
 * authorised, so nothing is missing — the platform is in a state this call cannot be served from.
 * FR-016 makes this unreachable on the happy path, which is why the message says so; an executor
 * that meets it should report the bootstrap phase as failed rather than retry into it.
 */
export const noLiveLeaseError = (): TRPCError =>
  new TRPCError({
    code: 'PRECONDITION_FAILED',
    message:
      'This workflow holds no live agent credential lease, so there is no credential to install. A lease is reserved at admission, before any compute is provisioned.',
  })

/** The rotation names a run that was never granted a seat, so there is nothing to rotate into. */
export const noCredentialForWorkflowError = (): TRPCError =>
  new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: 'This workflow has never been granted an agent credential, so nothing can be rotated.',
  })

/**
 * The credential exists but records no secret.
 *
 * Distinct from "no lease", because it is a different fault with a different owner: the seat was
 * granted, but its material was never adopted (FR-008). Creating a secret here to recover would
 * file material under an identifier nothing references and report success for it — the same refusal
 * the control plane's `persistRotation` makes, for the same reason.
 */
export const noSecretForCredentialError = (credentialId: string): TRPCError =>
  new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: `Agent credential ${credentialId} has no adopted secret, so its material cannot be read or written.`,
  })

/** A store that could not be reached. Thrown, so the executor's backoff retries it (FR-047). */
const materialStoreError = (action: 'read' | 'written', cause: unknown): TRPCError =>
  new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    // The identifier is named and the material never is: an error message is one log line away
    // from being a log line, and SC-014 admits no exceptions.
    message: `The agent credential material could not be ${action}.`,
    cause,
  })

/**
 * The seat the caller's **live lease** names.
 *
 * The join is the guarantee: the lease is selected by `ctx.workflowId` with `released_at is null`,
 * and `credential_leases_workflow_live_key` makes at most one such row exist. There is no input to
 * this query that a caller supplied.
 */
const liveLeasedSeat = async (ctx: MachineContext): Promise<ResolvedSeat | undefined> =>
  firstRow(
    await ctx.db
      .select(seatColumns)
      .from(credentialLeases)
      .innerJoin(agentCredentials, eq(agentCredentials.id, credentialLeases.agentCredentialId))
      .where(
        and(eq(credentialLeases.workflowId, ctx.workflowId), isNull(credentialLeases.releasedAt)),
      )
      .limit(1),
  )

/**
 * The seat the caller's workflow **was granted**, live lease or not.
 *
 * Reads `workflows.agent_credential_id`, which is written at acquisition and never changed
 * (FR-023, FR-059). The inner join is what makes a run that has never been granted one produce no
 * row rather than a row full of nulls. See the module note for why the rotation path must not use
 * {@link liveLeasedSeat} instead — it is the whole of FR-032.
 */
const grantedSeat = async (ctx: MachineContext): Promise<ResolvedSeat | undefined> =>
  firstRow(
    await ctx.db
      .select(seatColumns)
      .from(workflows)
      .innerJoin(agentCredentials, eq(agentCredentials.id, workflows.agentCredentialId))
      .where(eq(workflows.id, ctx.workflowId))
      .limit(1),
  )

/**
 * Hand the calling instance the material of the seat its workflow holds (FR-012).
 *
 * The credential's own `state` is deliberately not consulted. A seat disabled or marked unhealthy
 * while a run holds it is withheld from *future* selection and does not evict the live holder
 * (FR-006), so refusing the fetch would break a run that is legitimately mid-flight over a decision
 * about what to hand out next.
 *
 * The `fence` returned is the **credential's current value**, not the `leaseFence` the envelope
 * carried. For a healthy holder they are equal; where they are not, the difference is the signal
 * that this instance has already lost its claim, and it is the credential's value that the instance
 * must present on a rotation for the write to be judged against anything meaningful.
 *
 * @param ctx - The machine resolver context. `ctx.workflowId` is the only thing that decides which
 *   credential this answers with.
 * @param materials - The secret store. Defaults to whatever the deployment wired, or to a store
 *   that refuses; passed explicitly by the contract test, which has no deployment.
 * @throws {TRPCError} `PRECONDITION_FAILED` when the workflow holds no live lease or the credential
 *   has no adopted secret; `INTERNAL_SERVER_ERROR` when the store could not be read.
 */
export const fetchAgentCredential = async (
  ctx: MachineContext,
  materials: AgentCredentialMaterialStore = agentCredentialMaterialStore(
    ctx.dependencies.agentCredentialMaterial,
  ),
): Promise<FetchAgentCredentialOutput> => {
  const seat = await liveLeasedSeat(ctx)

  if (seat === undefined) {
    throw noLiveLeaseError()
  }
  if (seat.secretId === null) {
    throw noSecretForCredentialError(seat.credentialId)
  }

  let material: string
  try {
    material = await materials.read(seat.secretId)
  } catch (cause) {
    throw materialStoreError('read', cause)
  }

  return { credentialId: seat.credentialId, fence: seat.fence, material }
}

/**
 * Whether the store already holds exactly this material.
 *
 * This is the whole of the `not_newer` decision, and it is a comparison of **material**, which is
 * why it lives here and not in the control plane's fence module: that module's job is the fence,
 * and it never sees what is stored. A watcher firing on a touch that changed no bytes is an
 * ordinary event on a healthy holder, and answering it with a write would put a redundant version
 * in the store on every such touch.
 *
 * A read that fails is answered `false` — "not proven identical" — so the write goes ahead. The
 * asymmetry is deliberate and is the safe direction: a redundant secret version costs a version,
 * whereas a rotation dropped because the platform could not read the *old* value strands the seat.
 * Nothing is swallowed by this, either, because a store that cannot be read is a store whose write
 * is about to throw.
 *
 * Compared with `===` rather than a constant-time comparison: both operands are the platform's own
 * copies of the same secret, the caller already holds one of them, and there is no oracle here for
 * an attacker to time — the answer is returned to the instance that supplied the value.
 */
const storedMaterialMatches = async (
  materials: AgentCredentialMaterialStore,
  secretId: string,
  material: string,
): Promise<boolean> => {
  try {
    return (await materials.read(secretId)) === material
  } catch {
    return false
  }
}

/**
 * Write a rotated credential back, under the fence the caller was issued (FR-020, FR-030, FR-032).
 *
 * The fence rule is "nothing **below** the credential's current value", not "exactly equal". A
 * fence above the current one is unreachable — only acquisition raises the token, and it raises the
 * credential's copy first — but accepting it is still right: such a writer is not the superseded
 * holder this guards against, and refusing it would turn an impossible state into a lost rotation.
 * That is the same rule, deliberately worded the same way, as `isFenceCurrent` in the control
 * plane's `credentials/lease/fence.ts`; it is restated rather than imported because this package
 * must not depend on an application, and the two are tied together by
 * `contracts/agent-credential.ts` owning the rejection vocabulary both of them answer in.
 *
 * The refusal is decided **before the store is touched**, for the reason that module gives: a write
 * to Secrets Manager versions the value, so a refusal that wrote first would leave superseded
 * material recoverable as the newest version.
 *
 * @param ctx - The machine resolver context. `ctx.workflowId` decides which seat this is about.
 * @param input - The validated `reportCredentialRotation` payload: a fence and material, and
 *   nothing that could name another run's credential.
 * @param materials - The secret store, as on {@link fetchAgentCredential}.
 * @returns `{ accepted: true }`, or a rejection saying which of the two it is.
 * @throws {TRPCError} `PRECONDITION_FAILED` when the run was never granted a seat or the credential
 *   has no adopted secret; `INTERNAL_SERVER_ERROR` when the write did not land.
 */
export const reportCredentialRotation = async (
  ctx: MachineContext,
  input: ReportCredentialRotationInput,
  materials: AgentCredentialMaterialStore = agentCredentialMaterialStore(
    ctx.dependencies.agentCredentialMaterial,
  ),
): Promise<ReportCredentialRotationOutput> => {
  const seat = await grantedSeat(ctx)

  if (seat === undefined) {
    throw noCredentialForWorkflowError()
  }

  if (input.fence < seat.fence) {
    // The caller's claim has been superseded and the newer material survives untouched. Answered,
    // not thrown: this holder should wind down, and an error would have it retry instead.
    return { accepted: false, reason: 'stale_fence' }
  }

  if (seat.secretId === null) {
    throw noSecretForCredentialError(seat.credentialId)
  }

  if (await storedMaterialMatches(materials, seat.secretId, input.material)) {
    return { accepted: false, reason: 'not_newer' }
  }

  try {
    await materials.write(seat.secretId, input.material)
  } catch (cause) {
    throw materialStoreError('written', cause)
  }

  return { accepted: true }
}

/**
 * `machine.fetchAgentCredential` — mounted by `./router.ts` behind `machineProcedure`.
 *
 * A mutation rather than a query, like everything else on this surface: a query is a cacheable GET,
 * and a response body carrying credential material is the last thing that should be reachable that
 * way. `router.test.ts` asserts the property for the whole router.
 *
 * The empty input schema is declared rather than omitted. A procedure with no `.input()` accepts
 * anything and validates nothing, so the emptiness that makes property one true would stop being
 * enforced at exactly the moment somebody sent a payload.
 */
export const fetchAgentCredentialProcedure = machineProcedure
  .input(fetchAgentCredentialInput)
  .mutation(
    async ({ ctx }): Promise<FetchAgentCredentialOutput> =>
      fetchAgentCredential({
        db: ctx.db,
        workflowId: ctx.workflowId,
        credential: ctx.credential,
        dependencies: ctx.dependencies,
      }),
  )

/** `machine.reportCredentialRotation` — the write half, mounted the same way. */
export const reportCredentialRotationProcedure = machineProcedure
  .input(reportCredentialRotationInput)
  .mutation(
    async ({ ctx, input }): Promise<ReportCredentialRotationOutput> =>
      reportCredentialRotation(
        {
          db: ctx.db,
          workflowId: ctx.workflowId,
          credential: ctx.credential,
          dependencies: ctx.dependencies,
        },
        input,
      ),
  )
