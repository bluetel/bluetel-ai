/**
 * The job envelope, as the instance receives it (T173, FR-036, FR-147, contracts/executor-protocol.md).
 *
 * This is the reading end of `apps/sisyphus-control-plane/src/jobs/job-envelope.ts`. The control
 * plane writes it into instance user-data; this module turns those bytes back into the one value
 * every job parameter on this instance comes from. Nothing job-specific is read from `process.env`
 * — see the note at the top of `env-schemas.ts` for why that boundary is load-bearing rather than
 * tidy.
 *
 * ## Why the shape is restated here rather than imported
 *
 * The producer's types live in the control-plane app, and the executor cannot import them: they
 * are typed against `@bluetel-ai/sisyphus-api/db`, and a value edge to that package would put
 * Drizzle and the `postgres` driver one hop from a process that runs a customer's `setup.sh`
 * (FR-005, FR-006). What *is* shared is the vocabulary — {@link CLAUDE_MODELS},
 * {@link WORKFLOW_TYPES} and the pinned root — imported from `@bluetel-ai/sisyphus-api/client`,
 * which carries enums and no resolver. So the two ends cannot drift on a model name or a workflow
 * type, which are the fields a mismatch would be silent about.
 *
 * ## Parsing is validation, and it happens once
 *
 * A malformed envelope is not something to discover three phases in. `parseJobEnvelope` rejects
 * with every problem named — the same discipline `env.ts` applies to the instance environment, and
 * for the same reason: on a machine whose only channel for reporting a failure is the machine
 * surface, an early named failure is the difference between a diagnosable error and a run that
 * stalls until the reconciler reaps it.
 *
 * The credential is the one field deliberately *not* logged, echoed or included in any error
 * message this module produces. It is short-lived and workflow-scoped (FR-037), but user data is
 * readable by every process on the instance for as long as the instance exists, so there is no
 * reason to widen its blast radius by putting it somewhere a sanitiser has to catch it later.
 */

import { CLAUDE_MODELS, WORKFLOW_TYPES } from '@bluetel-ai/sisyphus-api/client'
import { z } from 'zod'

/** The workspace root. Pinned, non-negotiable — see `executor-protocol.md`, R2, FR-051. */
export const WORKSPACE_ROOT = '/workspace'

const nonEmpty = z.string().min(1)

/** Where the archive is and what it must hash to. Never the archive itself. */
export const envelopeSetupBundleSchema = z.object({
  s3Key: nonEmpty,
  contentDigest: nonEmpty,
  version: z.number().int().nonnegative(),
})

export const envelopeWorkspaceEntrySchema = z.object({
  entryId: z.string().uuid(),
  repositoryUrl: nonEmpty,
  baseBranch: nonEmpty,
  subdirectory: nonEmpty,
  isPrimary: z.boolean(),
})

/**
 * Exactly one primary entry, checked here rather than downstream.
 *
 * `src/skills` resolves every skill from the primary entry and nowhere else (FR-110), so a
 * workspace with none has no skills at all and a workspace with two has an ambiguous set. Neither
 * can be run, and both are cheaper to find out about before an instance has downloaded a bundle.
 */
export const envelopeWorkspaceSchema = z
  .object({
    root: z.literal(WORKSPACE_ROOT),
    entries: z.array(envelopeWorkspaceEntrySchema).min(1),
  })
  .refine((workspace) => workspace.entries.filter((entry) => entry.isPrimary).length === 1, {
    message:
      'the workspace must name exactly one primary entry, which is where skills are read from (FR-110)',
    path: ['entries'],
  })

/**
 * The write-once job spec (FR-149).
 *
 * `turnCap` and `spendCap` are nullable rather than optional because the control plane sends
 * `null` for a run that set none, and "the field is absent" and "the run declared no cap" are the
 * same fact arriving two ways. Normalising here means nothing downstream has to handle both.
 */
export const envelopeJobSchema = z.object({
  model: z.enum(CLAUDE_MODELS),
  turnCap: z.number().int().positive().nullable(),
  spendCap: z
    .string()
    .regex(/^\d+(\.\d{1,4})?$/u, 'Expected a decimal amount.')
    .nullable(),
  workflowType: z.enum(WORKFLOW_TYPES),
})

/** The prompt as sent (FR-162). The parts are carried where they are known, for attribution. */
export const envelopePromptSchema = z.object({
  preamble: z.string().optional(),
  intro: z.string().optional(),
  ticket: z.string().optional(),
  assembled: nonEmpty,
})

/** Where a resumed run picks up (FR-050, FR-151). */
export const envelopeResumeFromSnapshotSchema = z.object({
  s3Key: nonEmpty,
  /** The **predecessor's** session id, embedded in the snapshotted conversation state. */
  sessionId: z.string().uuid(),
})

export const workflowJobEnvelopeSchema = z.object({
  mode: z.literal('workflow'),
  workflowId: z.string().uuid(),
  sessionId: z.string().uuid(),
  machineSurfaceUrl: z.string().url(),
  scopedCredential: nonEmpty,
  setupBundle: envelopeSetupBundleSchema,
  workspace: envelopeWorkspaceSchema,
  job: envelopeJobSchema,
  prompt: envelopePromptSchema,
  resumeFromSnapshot: envelopeResumeFromSnapshotSchema.optional(),
})

/**
 * A bundle validation run (FR-147).
 *
 * Three fields and a mode. There is no `workflowId`, because there is no workflow — the run
 * identifies itself by its credential's subject. Adding an id here would be a second place for the
 * same fact to be recorded and a second place for it to be wrong.
 */
export const validationJobEnvelopeSchema = z.object({
  mode: z.literal('validation'),
  machineSurfaceUrl: z.string().url(),
  scopedCredential: nonEmpty,
  setupBundle: envelopeSetupBundleSchema,
})

export const jobEnvelopeSchema = z.discriminatedUnion('mode', [
  workflowJobEnvelopeSchema,
  validationJobEnvelopeSchema,
])

export type EnvelopeSetupBundle = z.infer<typeof envelopeSetupBundleSchema>
export type EnvelopeWorkspaceEntry = z.infer<typeof envelopeWorkspaceEntrySchema>
export type EnvelopeWorkspace = z.infer<typeof envelopeWorkspaceSchema>
export type EnvelopeJob = z.infer<typeof envelopeJobSchema>
export type EnvelopePrompt = z.infer<typeof envelopePromptSchema>
export type EnvelopeResumeFromSnapshot = z.infer<typeof envelopeResumeFromSnapshotSchema>
export type WorkflowJobEnvelope = z.infer<typeof workflowJobEnvelopeSchema>
export type ValidationJobEnvelope = z.infer<typeof validationJobEnvelopeSchema>
export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>

/**
 * An envelope this instance cannot act on.
 *
 * Carries the problems and **not** the input. An envelope quoted back in an error message is a
 * scoped credential written to whatever reads that message, which on this instance is the machine
 * surface and the run log.
 */
export class JobEnvelopeError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[], options: { readonly cause?: unknown } = {}) {
    super(
      `the job envelope this instance was launched with cannot be used: ${problems.join('; ')}. ` +
        'No bundle was downloaded and no agent was started.',
      options,
    )
    this.name = 'JobEnvelopeError'
    this.problems = problems
  }
}

const describeIssue = (issue: z.ZodIssue): string =>
  issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`

/**
 * Parse the user-data text into an envelope.
 *
 * @param text - The raw envelope, exactly as `encodeUserData` produced it.
 * @returns The validated envelope, discriminated on `mode`.
 * @throws {JobEnvelopeError} Naming every problem, and quoting none of the input.
 */
export const parseJobEnvelope = (text: string): JobEnvelope => {
  let document: unknown

  try {
    document = JSON.parse(text)
  } catch (cause) {
    throw new JobEnvelopeError(['it is not valid JSON'], { cause })
  }

  const parsed = jobEnvelopeSchema.safeParse(document)

  if (!parsed.success) {
    throw new JobEnvelopeError(parsed.error.issues.map(describeIssue))
  }

  return parsed.data
}

/**
 * The entry the skills are read from (FR-110).
 *
 * A function rather than a field on the parsed value because the schema has already established
 * that exactly one exists; this is how the rest of the executor gets at it without re-checking.
 */
export const primaryEntry = (envelope: WorkflowJobEnvelope): EnvelopeWorkspaceEntry => {
  const primary = envelope.workspace.entries.find((entry) => entry.isPrimary)

  if (primary === undefined) {
    throw new JobEnvelopeError(['the workspace names no primary entry'])
  }

  return primary
}

/** The caps as the enforcer takes them, with `null` normalised to "no cap". */
export const capLimitsFrom = (
  job: EnvelopeJob,
): { readonly turnCap?: number; readonly spendCapUsd?: number } => ({
  ...(job.turnCap === null ? {} : { turnCap: job.turnCap }),
  ...(job.spendCap === null ? {} : { spendCapUsd: Number(job.spendCap) }),
})
