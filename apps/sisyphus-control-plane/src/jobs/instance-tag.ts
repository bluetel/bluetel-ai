import { VALIDATION_SUBJECT_PREFIX } from '../credentials'

/**
 * What the `sisyphus:workflow-id` tag says, and how the reconciler reads it back.
 *
 * Every instance the platform launches carries that tag, and `ComputeProvisioner.
 * listWorkflowInstances` filters on its presence — that is the whole mechanism behind FR-039's
 * sweep. But two different kinds of run launch instances: a workflow, and a **bundle validation
 * run** (FR-147), which has no workflow row at all.
 *
 * If both wrote a bare uuid, the reconciler could not tell them apart. It would look a validation
 * run's id up in `workflows`, find nothing, and correctly conclude — by its own rules — that the
 * instance is a leak. It would then terminate a perfectly healthy validation mid-`setup.sh`. A
 * reconciler that kills healthy runs is worse than one that leaks, so the tag is made
 * self-describing instead: a validation instance is tagged `validation:<runId>`, and
 * {@link parseInstanceTag} returns which kind it is looking at rather than guessing.
 *
 * The prefix is shared with the credential subject space on purpose. A validation run is
 * `validation:<id>` in its tag and in its token's `sub`, so the two cannot drift into disagreeing
 * about what a run is called.
 */

/** A workflow instance, tagged with the workflow's own id. */
export interface WorkflowInstanceTag {
  readonly kind: 'workflow'
  readonly id: string
}

/** A bundle validation instance (FR-147). No workflow row exists for it. */
export interface ValidationInstanceTag {
  readonly kind: 'validation'
  readonly id: string
}

/**
 * An instance carrying the tag with a value in neither space — or with no value at all. Terminated
 * by the sweep, because an instance the platform cannot attribute is an instance nobody is paying
 * attention to.
 */
export interface UnattributedInstanceTag {
  readonly kind: 'unattributed'
  readonly id: undefined
}

export type InstanceTag = UnattributedInstanceTag | ValidationInstanceTag | WorkflowInstanceTag

/** The tag value for a workflow's instance. */
export const workflowInstanceTag = (workflowId: string): string => workflowId

/** The tag value for a bundle validation run's instance. */
export const validationInstanceTag = (validationRunId: string): string =>
  `${VALIDATION_SUBJECT_PREFIX}${validationRunId}`

/**
 * Read a tag value back.
 *
 * @param value - The tag as EC2 reported it, which may be absent.
 */
export const parseInstanceTag = (value: string | undefined): InstanceTag => {
  if (value === undefined || value === '') {
    return { kind: 'unattributed', id: undefined }
  }

  if (value.startsWith(VALIDATION_SUBJECT_PREFIX)) {
    const id = value.slice(VALIDATION_SUBJECT_PREFIX.length)
    return id === '' ? { kind: 'unattributed', id: undefined } : { kind: 'validation', id }
  }

  return { kind: 'workflow', id: value }
}
