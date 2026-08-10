import type { AgentCredentialReference } from '@bluetel-ai/sisyphus-api/contracts'
import type { Workflow } from '@bluetel-ai/sisyphus-api/db'

/**
 * The job envelope — everything the control plane hands an instance, and nothing else (T052,
 * FR-036).
 *
 * Shaped exactly as `contracts/executor-protocol.md` specifies, because the executor's
 * `job-envelope.ts` parses this and it is "the only source of job config" on the instance: no job
 * parameter reaches the executor through its environment, so nothing job-specific is readable from
 * `process.env` there (plan.md, "Configuration").
 *
 * ## What it carries, and what it deliberately does not
 *
 * It carries the run's identity, the machine surface's URL, the **short-lived scoped credential**,
 * a *reference* to the setup bundle (key, digest, version — not the archive), the workspace entries
 * to check out, the job spec, the assembled prompt, and the snapshot to resume from if there is
 * one.
 *
 * It carries **no long-lived secret** (FR-036). Not the agent credential, not the repository-host
 * credential, not a ticket-tracker token, not an AWS key, not the signing secret behind the scoped
 * credential itself. Those are `setup.sh`'s job — the bundle installs them on the instance, which
 * is why FR-043 puts credential installation in the bundle and why `setup.sh` idempotency is a
 * hard requirement rather than a nicety.
 *
 * That distinction is the whole point of the rule. **User data is not a secret channel**: it is
 * readable by every process on the instance through the metadata service for as long as the
 * instance exists, and it survives into any image taken of it. The scoped credential is
 * nevertheless correct to put here, because it is bounded on three axes at once — one workflow,
 * one audience, and a window that is fifteen minutes and revoked outright at teardown. A
 * long-lived secret has none of those bounds, so the same channel that is acceptable for the one
 * is unacceptable for the other.
 *
 * ## The agent credential is named here and fetched elsewhere (003/FR-012, T050)
 *
 * {@link WorkflowJobEnvelope.agentCredential} is the seat the run holds, and it is **identifiers
 * only**: the credential's id and the fence its lease was issued. The agent's own login material
 * is not here and cannot be, because the same paragraph above applies to it with none of the
 * scoped credential's mitigations — an agent credential is long-lived, it is the platform's
 * scarcest resource, and a copy of it in user data would be readable by every process on the box
 * for the instance's whole life and would survive into any image taken of it.
 *
 * The shape is `agentCredentialReference` from `@bluetel-ai/sisyphus-api/contracts` rather than an
 * interface restated here, and that is load-bearing rather than tidy. That schema is `.strict()`,
 * so "the envelope cannot carry material" is a property of a value the tests can execute —
 * `job-envelope.test.ts` parses the envelope's own field with it and watches a `material` key be
 * refused — instead of a promise about what nobody has added yet. `AGENT_CREDENTIAL_MATERIAL_FIELD`
 * names the one field in that contract that ever holds material, so the same test can sweep the
 * serialised envelope for it by name.
 *
 * How the instance gets the material is the other half: it calls `fetchAgentCredential` on the
 * machine surface, authorised by the `scopedCredential` this envelope does carry. That is all the
 * authority the box needs, and it is revocable — which a copy in user data would not be.
 *
 * The field is optional for one reason and it is temporary. Admission reserves a seat before any
 * compute is committed to (FR-016, T046), but until the FR-024 waiting state is wired (T064) a
 * workflow whose execution profile reaches no credential — an ad-hoc run with no profile at all,
 * most often — is still admitted rather than made to wait, and such a run has no seat to name. Once
 * admission refuses to provision without one, an envelope without this field is unreachable.
 *
 * ## Size
 *
 * EC2 caps user data at {@link MAX_USER_DATA_BYTES}, and `prompt.assembled` is the only field
 * without a natural bound. {@link encodeUserData} therefore checks, and a launch that would exceed
 * the cap fails **here**, naming the field and the overage, rather than at `RunInstances` with a
 * message about the request being malformed.
 */

/** The workspace root. Pinned, non-negotiable — see `executor-protocol.md`, R2, FR-051. */
export const WORKSPACE_ROOT = '/workspace'

/** EC2's user-data limit, applied to the raw text before it is base64-encoded for the API. */
export const MAX_USER_DATA_BYTES = 16 * 1024

/** Where the archive is and what it must hash to. Never the archive itself. */
export interface EnvelopeSetupBundle {
  readonly s3Key: string
  readonly contentDigest: string
  readonly version: number
}

/** One repository to check out, resolved from the workspace version the run was launched against. */
export interface EnvelopeWorkspaceEntry {
  /** The `workflow_entries` row, so per-entry reports address something that already exists. */
  readonly entryId: string
  readonly repositoryUrl: string
  readonly baseBranch: string
  readonly subdirectory: string
  readonly isPrimary: boolean
}

export interface EnvelopeWorkspace {
  readonly root: typeof WORKSPACE_ROOT
  readonly entries: readonly EnvelopeWorkspaceEntry[]
}

/** The write-once job spec (FR-149). Caps are null where the run set none. */
export interface EnvelopeJob {
  readonly model: Workflow['model']
  readonly turnCap: number | null
  readonly spendCap: string | null
  readonly workflowType: Workflow['type']
}

/** The prompt as sent (FR-162). The parts are carried where they are known, for attribution. */
export interface EnvelopePrompt {
  readonly preamble?: string
  readonly intro?: string
  readonly ticket?: string
  readonly assembled: string
}

/** Where a resumed run picks up (FR-050, FR-151). */
export interface EnvelopeResumeFromSnapshot {
  readonly s3Key: string
  /** The **predecessor's** session id, embedded in the snapshotted conversation state. */
  readonly sessionId: string
}

/** The envelope for a real run. */
export interface WorkflowJobEnvelope {
  readonly workflowId: string
  readonly sessionId: string
  readonly machineSurfaceUrl: string
  readonly scopedCredential: string
  /**
   * Which agent credential this run holds, and under which fence (FR-012, FR-020).
   *
   * Identifiers only — see the module note. `leaseFence` rather than `fence` because the value is
   * the one *this lease* was issued and the credential's current fence may already be higher; an
   * instance whose two disagree has lost its claim, which is exactly what the executor needs to be
   * able to notice.
   *
   * Absent only for a run admitted before the FR-024 waiting state existed to catch it (T064).
   */
  readonly agentCredential?: AgentCredentialReference
  readonly setupBundle: EnvelopeSetupBundle
  readonly workspace: EnvelopeWorkspace
  readonly job: EnvelopeJob
  readonly prompt: EnvelopePrompt
  readonly resumeFromSnapshot?: EnvelopeResumeFromSnapshot
  readonly mode: 'workflow'
}

/**
 * The envelope for a bundle validation run (FR-147).
 *
 * Only the three fields the contract names, plus the mode. There is no `workflowId`, because there
 * is no workflow — that absence is the requirement, not an omission: it is what keeps
 * `workflows.owner_user_id`, `assembled_prompt` and `workspace_version_id` non-null for real runs
 * instead of being loosened to accommodate a run with no ticket, no workspace and no prompt.
 *
 * The run identifies itself by its credential's subject, `validation:<runId>`, which is also the
 * value in its instance tag. Adding an id field here would be a second place for the same fact to
 * be recorded and a second place for it to be wrong.
 */
export interface ValidationJobEnvelope {
  readonly machineSurfaceUrl: string
  readonly scopedCredential: string
  readonly setupBundle: EnvelopeSetupBundle
  readonly mode: 'validation'
}

export type JobEnvelope = ValidationJobEnvelope | WorkflowJobEnvelope

/**
 * Serialise an envelope for `LaunchComputeRequest.userData`.
 *
 * Base64 encoding is the adapter's job, not this one's — `createEc2ComputeProvisioner` does it, so
 * the size check here is against the bytes the limit is actually expressed in.
 *
 * @param envelope - The assembled envelope.
 * @param describedAs - What to name in an over-size error, e.g. `workflow <id>`.
 * @throws If the envelope exceeds {@link MAX_USER_DATA_BYTES}.
 */
export const encodeUserData = (envelope: JobEnvelope, describedAs: string): string => {
  const text = JSON.stringify(envelope)
  const byteLength = Buffer.byteLength(text, 'utf8')

  if (byteLength > MAX_USER_DATA_BYTES) {
    throw new Error(
      `The job envelope for ${describedAs} is ${String(byteLength)} bytes, over the ${String(MAX_USER_DATA_BYTES)}-byte user-data limit. The assembled prompt is the only unbounded field in it, so that is almost certainly what to shorten. Failing here rather than at RunInstances means the message names the cause instead of describing a malformed request.`,
    )
  }

  return text
}
