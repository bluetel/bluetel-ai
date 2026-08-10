import { z } from 'zod'

import { uuidInput } from '../schemas'

/**
 * The agent-credential machine surface, as the one shape the panel, the control plane and the
 * executor all read (T015, FR-012, FR-014, FR-020, FR-032).
 *
 * This is `contracts/executor-credential.md` → *Machine surface — two calls* made executable. Two
 * procedures carry the whole of this feature's exposure to credential material:
 * `fetchAgentCredential` hands an instance the material of the seat its workflow already holds,
 * and `reportCredentialRotation` writes a refreshed credential back under a fence. Everything else
 * the feature does — selecting, leasing, queueing, releasing, the pool view — moves identifiers
 * and never touches material at all.
 *
 * It lives in `contracts/` rather than in `src/schemas/machine.ts` because three members consume
 * it and none of them is the resolver: `sisyphus-executor` calls both procedures, the control
 * plane puts {@link agentCredentialReference} into the job envelope, and the panel renders the
 * identifiers that come back out. `src/schemas/` is the resolver-and-form barrel; this is the
 * shape the wire has.
 *
 * ## Property one — there is no parameter for naming a seat
 *
 * {@link fetchAgentCredentialInput} is **empty**, and {@link reportCredentialRotationInput} names
 * a fence and a payload and nothing else. Neither carries a credential id, an agent-credential id
 * or a workflow id, because the seat is named by the caller's **live lease** — resolved
 * server-side from `ctx.workflowId`, which comes from the scoped credential the instance was
 * launched with (002, FR-018). A caller cannot ask for somebody else's seat because there is
 * nowhere in the payload to write the request.
 *
 * The design note sketches these as `→ { workflowId }` and `→ { workflowId, fence, material }`.
 * Where implementing a design note forces a decision, the file that compiles is the one that wins
 * — the same rule `./connector` records against `contracts/integration-connector.md` — and this is
 * such a case twice over. `src/schemas/machine.ts` already refuses a `workflowId` on *every*
 * machine input, for FR-018; and here it would additionally be the exact parameter by which one
 * run asks for another's credential, which is the thing this contract exists to make impossible.
 * Nothing is lost: where a workflow genuinely must be named — a retry replaying an old envelope —
 * the resolver compares the claim against the credential rather than trusting it.
 *
 * ## `.strict()`, and why these are the first strict schemas in the package
 *
 * Zod's default is to **strip** unknown keys. An executor that sent
 * `{ credentialId: '<somebody else's>' }` would therefore get a successful parse, a silently
 * emptied payload and a `200`. The absence of the parameter would still hold, but nobody would
 * ever find out that something had tried to use one, and a test asserting "there is no such
 * parameter" would keep passing for a reason that has nothing to do with the guarantee. `.strict()`
 * turns the attempt into a refusal the caller sees and the surface can record.
 *
 * ## Property two — material travels in exactly one direction
 *
 * {@link AGENT_CREDENTIAL_MATERIAL_FIELD} is the only field name in this contract that ever holds
 * credential material, and exactly two shapes have it: {@link fetchAgentCredentialOutput}
 * (machine surface → executor) and {@link reportCredentialRotationInput} (executor → machine
 * surface → secret store). Both are instance-to-surface only.
 *
 * **Nothing that travels toward the panel or into the job envelope has such a field.**
 * {@link agentCredentialReference} is what the envelope carries, and it is identifiers only,
 * because the envelope becomes EC2 user-data — readable from the instance metadata service by
 * anything running on the box, which is the whole of FR-012's reasoning. The panel is served
 * state, holder, hold duration and last-login time; `secret_id` names a secret and is not one.
 *
 * **The rotation report is the one shape that legitimately carries material, and that is safe**
 * because of where it terminates. It goes executor → machine surface → Secrets Manager and stops:
 * there is no read path that carries it back out toward an administrator's browser, so it never
 * becomes a panel response body or a rendered value. It is also registered as a known redaction
 * value in the executor's output pipeline (FR-014, T054), so a rotation cannot reach a log even if
 * something echoes it. A rotation that could not carry material would leave the platform unable to
 * write a refreshed credential at all, which is the failure this feature exists to prevent — so
 * the field is not an exception grudgingly made, it is the mechanism.
 *
 * ## What this contract deliberately does not say
 *
 * It carries **no credential state and no release reason**. That vocabulary — `awaiting_login`,
 * `available`, `held`, `cooling_off`, `unhealthy`, `disabled`, and `terminal | forced |
 * login_replaced` — belongs to the admin surface and the allocation path, and lives in
 * `src/enums/`. Nothing here needs it: an instance that has reached `credential_install` already
 * holds a lease, so the only question left on this surface is fence ordering. Keeping the
 * lifecycle vocabulary out is what stops this contract having to change every time the state
 * machine grows a state.
 */

/**
 * The one field name in this contract that ever holds credential material.
 *
 * Exported so the FR-014/SC-014 leak audit can look for it **by name** across the envelope,
 * snapshots, log segments and panel responses, rather than by eye. A shape that gains this field
 * has gained an obligation; a shape asserted not to have it has a machine-checkable promise.
 */
export const AGENT_CREDENTIAL_MATERIAL_FIELD = 'material'

/**
 * The material itself, as the agent wrote it.
 *
 * `z.string().min(1)` and deliberately **not** `nonEmptyText`, which is `.trim().min(1)`. Trimming
 * rewrites the value, and this value is the exact bytes read off the agent's credential file — a
 * trailing newline is part of what the agent will read back, and a schema that quietly removed it
 * would install material that differs from what was captured. The reason `nonEmptyText` trims is
 * to reject `'   '` in a form field; nothing about that reasoning applies to a secret.
 *
 * A minimum of one character rather than none, because an empty rotation is not a rotation: it is
 * a watcher that fired on a truncated write, and accepting it would overwrite a working credential
 * with nothing.
 */
const agentCredentialMaterial = z.string().min(1)

/**
 * The fencing token (FR-020, research R9).
 *
 * Monotonically increasing, held **on the credential rather than on the lease**, incremented on
 * every lease acquisition. It lives on the credential because it has to outlive the lease that
 * raised it — that is precisely what makes a superseded holder's write rejectable *after* its
 * lease row is gone, which is the force-release and reconciliation case the token exists for. A
 * partitioned instance is not dead and will happily keep writing; the fence makes those writes
 * rejectable without anyone having to decide whether it is still alive.
 *
 * The column is `bigint not null default 0` (data-model.md → `agent_credentials`). On the wire it
 * is a non-negative safe integer rather than a JavaScript `bigint`, for two reasons:
 *
 * 1. **The package already maps its `bigint` columns this way.** `db/schema/columns.ts` defines
 *    `bigIntColumn` as `bigint(name, { mode: 'number' })`, and `appendLogSegmentInput.sequence` —
 *    the same column type, on a counter that advances far faster than this one — is carried as
 *    `z.number().int().nonnegative()`. A second convention for the same column type is how the
 *    two end up disagreeing at a boundary.
 * 2. **{@link agentCredentialReference} is JSON-serialised into EC2 user-data**, and
 *    `JSON.stringify` throws on a `bigint`. A wire type that cannot survive the transport its own
 *    consumer uses is not a contract.
 *
 * The headroom is not in question. R9 notes the fence rarely advances at all — a lease is released
 * only at terminal state or by force-release, never on pause, park or environment loss — so the
 * distance to 2^53 acquisitions is not a bound anybody reaches.
 *
 * Zero is valid: it is the value a credential has before it has ever been leased, and rejecting it
 * would make the first acquisition's own fence unrepresentable.
 */
export const agentCredentialFence = z.number().int().nonnegative()

/**
 * How a credential is named everywhere it is **not** being handed over: the job envelope, and any
 * panel or control-plane shape that has to point at a seat (FR-012).
 *
 * Identifiers only, and `.strict()`, so the assertion that the envelope cannot carry material is a
 * property of this schema rather than a habit of whoever last edited `job-envelope.ts`. The
 * envelope already carries `scopedCredential`, which is the instance's authority to call the
 * machine surface; that is what authorises the fetch, and it is all the authority the box needs.
 * Putting material here instead would put it in user-data, which is readable from the instance
 * metadata service by anything on the machine.
 *
 * `leaseFence` rather than `fence`, matching the envelope's own naming: the value is the one *this
 * lease* was issued, and the credential's current fence may already be higher.
 */
export const agentCredentialReference = z
  .object({
    credentialId: uuidInput,
    leaseFence: agentCredentialFence,
  })
  .strict()

/**
 * What `fetchAgentCredential` takes: **nothing**.
 *
 * This is the whole of property one. The credential is the one the calling workflow's live lease
 * names, resolved from the scoped credential the request arrived with, and there is no field here
 * for a caller to name any other. An empty schema is exported rather than omitted precisely
 * because the emptiness is the guarantee — a procedure with no declared input is a procedure whose
 * input nobody is watching, and the next person to add "just an id for logging" would meet no
 * resistance at all.
 *
 * Failing when the workflow holds no live lease is a control-plane bug rather than a normal path:
 * FR-016 reserves the seat at admission, before any compute is provisioned, so by the time an
 * instance exists to make this call the claim has already been made.
 */
export const fetchAgentCredentialInput = z.object({}).strict()

/**
 * What `fetchAgentCredential` answers with (`contracts/executor-credential.md`).
 *
 * One of the two material-bearing shapes in this contract, and it travels machine surface →
 * executor only. The two identifiers ride with it so the instance can present them back on a
 * rotation without having to re-derive either: `fence` is what
 * {@link reportCredentialRotationInput} must carry, and `credentialId` is what the executor logs
 * and reports phases against.
 *
 * `fence` is the credential's value at the moment of the fetch, which for a healthy holder equals
 * the `leaseFence` it was launched with. They can differ — a force-release between admission and
 * boot advances the credential's fence — and that difference is the signal that this instance has
 * already lost its claim.
 */
export const fetchAgentCredentialOutput = z
  .object({
    credentialId: uuidInput,
    fence: agentCredentialFence,
    material: agentCredentialMaterial,
  })
  .strict()

/**
 * Why a rotation was not written. A closed vocabulary, because the two mean opposite things about
 * the caller and collapsing them would destroy the only signal each one carries.
 *
 * - `stale_fence` — the presented fence is **below** the credential's current value (FR-020). The
 *   caller's claim has been superseded, by a force-release or by reconciliation, and something
 *   else has held the seat since. The newer material survives untouched.
 * - `not_newer` — the fence is current but the write carries nothing new. A healthy holder whose
 *   file watcher fired on a touch that changed no bytes.
 *
 * A `stale_fence` holder should stop; a `not_newer` holder should carry on. An implementation that
 * reported both as a bare `false` would leave the executor unable to tell "you have lost the seat"
 * from "nothing to do", which is the one distinction this answer exists to make.
 */
export const credentialRotationRejection = z.enum(['stale_fence', 'not_newer'])

/**
 * What `reportCredentialRotation` takes.
 *
 * The second material-bearing shape, and the one that makes the whole feature work: it goes
 * executor → machine surface → Secrets Manager, and it is why a rotated credential survives the
 * instance that rotated it.
 *
 * No workflow id and no credential id, for the same reason {@link fetchAgentCredentialInput} has
 * none — the seat is the one this caller's live lease names. `fence` is not an exception to that:
 * it is not a *selector*, it is the claim being presented for checking. A caller cannot reach
 * another credential by raising it, because the fence is compared against the credential the lease
 * already resolved to; a wrong value is a rejection, never a redirection.
 */
export const reportCredentialRotationInput = z
  .object({
    fence: agentCredentialFence,
    material: agentCredentialMaterial,
  })
  .strict()

/**
 * What `reportCredentialRotation` answers with.
 *
 * A **discriminated union** rather than the design note's `{ accepted: boolean, reason?: ... }`,
 * so the two invalid shapes are unrepresentable rather than merely unwritten: a rejection cannot
 * be reported without saying which one it is, and an acceptance cannot carry a reason. `optional`
 * would have allowed `{ accepted: false }`, and a bare `false` is exactly the answer that makes a
 * stale-fence rejection indistinguishable from a no-op — the distinction
 * {@link credentialRotationRejection} exists to preserve. `./connector`'s `MappingResolution` is
 * shaped the same way for the same reason.
 *
 * **Answered, not thrown.** A rejected write means the caller has already lost its claim and
 * should be winding down; raising it as a transport error would turn that into a retry storm from
 * an instance whose every attempt is going to be refused for the same reason. FR-020 calls this
 * silent-but-recorded: silent to the caller's control flow, recorded on the surface.
 *
 * **Acceptance does not depend on the run still being alive.** A rotation arriving after its
 * workflow has terminated is accepted whenever its fence is current (FR-032) — the credential's
 * future usability depends on the material, not on the run's state, and a rotation landing moments
 * after a workflow ends is still the newest material in existence. Nothing in this shape refers to
 * run state, which is what keeps that true by construction.
 */
export const reportCredentialRotationOutput = z.discriminatedUnion('accepted', [
  z.object({ accepted: z.literal(true) }).strict(),
  z.object({ accepted: z.literal(false), reason: credentialRotationRejection }).strict(),
])

export type AgentCredentialFence = z.infer<typeof agentCredentialFence>
export type AgentCredentialReference = z.infer<typeof agentCredentialReference>
export type FetchAgentCredentialInput = z.infer<typeof fetchAgentCredentialInput>
export type FetchAgentCredentialOutput = z.infer<typeof fetchAgentCredentialOutput>
export type CredentialRotationRejection = z.infer<typeof credentialRotationRejection>
export type ReportCredentialRotationInput = z.infer<typeof reportCredentialRotationInput>
export type ReportCredentialRotationOutput = z.infer<typeof reportCredentialRotationOutput>
