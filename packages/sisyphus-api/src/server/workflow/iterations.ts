import { asc, eq, inArray } from 'drizzle-orm'

import type { Iteration, ReviewFinding } from '../../db'
import { iterations, reviewFindings } from '../../db'
import type { ScopedReadOptions } from '../scope'
import { requireWorkflowInScope } from '../scope'

/**
 * One pass of the autonomous develop→review loop, with the findings that pass raised (FR-061).
 *
 * The machine surface has its own `iterationHistory`, and this is deliberately not it. That one is
 * reached with a scoped credential and answers about the run the credential names; this one is
 * reached by a person and has to answer `NOT_FOUND` for a run outside their scope — the same
 * `NOT_FOUND` a nonexistent id gets (FR-190). Sharing a resolver between the two would mean one
 * function serving two different definitions of "may see this", which is how an enumeration oracle
 * gets built by accident.
 */
export interface IterationPass {
  readonly iteration: Iteration
  readonly findings: readonly ReviewFinding[]
}

/**
 * Every pass of a run, oldest first, each with its findings.
 *
 * The findings are fetched in one `inArray` rather than a query per pass: a run is bounded to three
 * iterations by a check constraint, so the loop would be short, but a read whose query count varies
 * with its result count is the shape that stops being fine later.
 */
export const readIterations = async (
  options: ScopedReadOptions & { readonly workflowId: string },
): Promise<readonly IterationPass[]> => {
  const workflow = await requireWorkflowInScope(options)

  const passes = await options.db
    .select()
    .from(iterations)
    .where(eq(iterations.workflowId, workflow.id))
    .orderBy(asc(iterations.ordinal))

  if (passes.length === 0) {
    return []
  }

  const findings = await options.db
    .select()
    .from(reviewFindings)
    .where(
      inArray(
        reviewFindings.iterationId,
        passes.map((pass) => pass.id),
      ),
    )

  return passes.map((iteration) => ({
    iteration,
    findings: findings.filter((finding) => finding.iterationId === iteration.id),
  }))
}
