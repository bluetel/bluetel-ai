import { TRPCError } from '@trpc/server'

import type { Artifact } from '../../db'
import { artifacts } from '../../db'
import type { RegisterArtifactInput } from '../../schemas'

import type { MachineContext } from './guard'
import { firstRow, resolveOptionalEntry } from './guard'

/**
 * `machine.registerArtifact` — what the run produced, recorded so it is findable afterwards
 * (FR-014, SC-012).
 *
 * The payload never names a workflow; the row is written against `ctx.workflowId`. The one field
 * that could point outside the credential's run is `entryId`, and it goes through
 * `resolveOptionalEntry`, so an artifact cannot be filed against another workflow's repository —
 * and the attempt is recorded as a security event rather than merely refused (FR-018).
 */

/** The audit path recorded against a cross-workflow artifact registration. */
export const REGISTER_ARTIFACT_PATH = 'machine.registerArtifact'

/**
 * Refusal for an artifact that is neither stored nor linked, or claims to be both.
 *
 * The schema comment on `artifacts` says exactly one of `s3_key` and `external_url` is set — a PR
 * lives elsewhere, a diff lives in S3 — but no constraint expresses it, so it is enforced here.
 * Both set is ambiguous about which one to serve; neither set is a row that records that something
 * was produced without recording where it went, which is worse than no row at all.
 */
export const artifactLocationError = (): TRPCError =>
  new TRPCError({
    code: 'BAD_REQUEST',
    message: 'An artifact must carry exactly one of an object key or an external URL.',
  })

/**
 * Record one artifact against the credential's workflow.
 *
 * `expiresAt` is left null here. Retention is a property of the stored object's lifecycle policy
 * rather than of the reporting call, and an executor guessing at it would put a date in the record
 * that the bucket has not agreed to.
 *
 * @param ctx - The machine resolver context.
 * @param input - The validated `registerArtifact` payload.
 */
export const registerArtifact = async (
  ctx: MachineContext,
  input: RegisterArtifactInput,
): Promise<Artifact> => {
  const hasKey = input.s3Key !== undefined
  const hasUrl = input.externalUrl !== undefined
  if (hasKey === hasUrl) {
    throw artifactLocationError()
  }

  const entryId = await resolveOptionalEntry(ctx, input.entryId, REGISTER_ARTIFACT_PATH)

  const inserted = firstRow(
    await ctx.db
      .insert(artifacts)
      .values({
        workflowId: ctx.workflowId,
        entryId,
        kind: input.kind,
        s3Key: input.s3Key ?? null,
        externalUrl: input.externalUrl ?? null,
        byteSize: input.byteSize ?? null,
      })
      .returning(),
  )

  if (inserted === undefined) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'The artifact could not be recorded.',
    })
  }

  return inserted
}
