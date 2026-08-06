/**
 * The needs-attention screen (T088, FR-134, FR-135, FR-176, FR-190).
 *
 * Nothing here is a primitive, and nothing here is a second fleet list: the runs waiting on the
 * signed-in user are `workflow.list` narrowed to what they own, rendered through the same
 * `WorkflowList` and the same row shaping the fleet view uses. What lives here is the two questions
 * the screen asks and the one act it offers — reassigning a run whose owner was deactivated.
 *
 * Consumers import this barrel, never a module inside it.
 */

export {
  awaitingReassignmentInput,
  NEEDS_ATTENTION_PAGE_SIZE,
  NEEDS_ATTENTION_STATE,
  NON_TERMINAL_STATES,
  reassignmentCandidates,
  stoppedForMeInput,
  strandedOwners,
} from './needs-attention-input'
export type { AdministeredUser, ListWorkflowsInput, StrandedOwner } from './needs-attention-input'

export { NeedsAttentionPanel } from './needs-attention-panel'

export { describeReassignment, describeReassignmentError } from './reassignment-outcome'
export type { ReassignmentNotice, ReassignmentResult } from './reassignment-outcome'

export { ReassignmentRow } from './reassignment-row'
export { StrandedOwnerCard } from './stranded-owner-card'
