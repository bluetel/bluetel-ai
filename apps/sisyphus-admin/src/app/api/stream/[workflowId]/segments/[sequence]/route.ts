import { logSegments } from '@bluetel-ai/sisyphus-api/db'
import type { ScopeIdentity } from '@bluetel-ai/sisyphus-api/server'
import { createScopeResolver, findWorkflowInScope } from '@bluetel-ai/sisyphus-api/server'
import { env } from '@sisyphus-admin/env'
import { getAuthDatabase } from '@sisyphus-admin/lib/auth'
import { createBundleObjectStore } from '@sisyphus-admin/lib/bundles'
import { resolveSisyphusSession } from '@sisyphus-admin/server'
import { and, eq } from 'drizzle-orm'

import { readSegmentText, segmentTextResponse } from '../../../segment-text'
import type { StreamWorkflow } from '../../../stream-access'
import { decideLogStreamAccess, refusalResponse } from '../../../stream-access'

/**
 * One segment's stored output, as text (FR-046).
 *
 * The SSE stream carries `(workflowId, sequence, s3Key, byteSize)` — the *record* of a segment,
 * which is what `log_segments` holds. The bytes are in the logs bucket, so the viewer resolves
 * each reconciled segment through this route.
 *
 * ## Scoped by exactly the same decision as the stream
 *
 * `decideLogStreamAccess` and `refusalResponse` are imported rather than re-derived, so an
 * out-of-scope caller gets the identical `404 Workflow not found.` here as on the stream itself.
 * A per-segment read that checked less than the stream would be the enumeration oracle the stream
 * was careful not to be — and it is the more tempting mistake, because a segment key looks like it
 * carries its own authorisation.
 *
 * The row is then read with **both** `workflow_id` and `sequence` in the predicate, so a key
 * belonging to another run cannot be reached by guessing a sequence.
 *
 * ## Module scope
 *
 * The pool, the bucket name and the S3 client are all reached inside the handler; `next build`
 * imports this module.
 */
export const dynamic = 'force-dynamic'

const parseSequence = (value: string): number | undefined => {
  if (!/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

export const GET = async (
  _request: Request,
  context: {
    readonly params: Promise<{ readonly workflowId: string; readonly sequence: string }>
  },
): Promise<Response> => {
  const { workflowId, sequence } = await context.params
  const db = getAuthDatabase()
  const session = await resolveSisyphusSession()

  const access = await decideLogStreamAccess({
    session,
    workflowId,
    findWorkflowInScope: async (
      identity: ScopeIdentity,
      id: string,
    ): Promise<StreamWorkflow | undefined> => {
      const workflow = await findWorkflowInScope({
        db,
        scope: await createScopeResolver({ db, identity }).resolve(),
        workflowId: id,
      })
      return workflow === undefined ? undefined : { id: workflow.id, state: workflow.state }
    },
  })

  if (access.outcome !== 'granted') {
    return refusalResponse(access)
  }

  const parsed = parseSequence(sequence)
  if (parsed === undefined) {
    return segmentTextResponse({ outcome: 'not-found' })
  }

  const rows = await db
    .select({ s3Key: logSegments.s3Key, byteSize: logSegments.byteSize })
    .from(logSegments)
    .where(and(eq(logSegments.workflowId, access.workflow.id), eq(logSegments.sequence, parsed)))
    .limit(1)

  if (rows.length === 0) {
    // A sequence with no row. Answered as absence, exactly like a segment whose object has aged
    // out — a caller must not be able to tell "never recorded" from "no longer stored" by status.
    return segmentTextResponse({ outcome: 'not-found' })
  }

  // `noUncheckedIndexedAccess` is off in this workspace, so the guard above is what makes this
  // safe rather than the type.
  const row = rows[0]

  return segmentTextResponse(
    await readSegmentText({
      store: createBundleObjectStore(env.AWS_REGION),
      bucket: env.SISYPHUS_LOGS_BUCKET,
      key: row.s3Key,
      byteSize: row.byteSize,
    }),
  )
}
