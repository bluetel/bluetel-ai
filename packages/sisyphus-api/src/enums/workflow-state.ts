import { createEnumGuard } from './enum-guard'
import { TERMINAL_OUTCOMES } from './terminal-outcome'

/**
 * Every state a workflow row may hold.
 *
 * The first six are lifecycle states; the remainder are the FR-064 outcome names, which double as
 * states so that `workflows.state` and `workflows.terminal_outcome` never disagree about where a
 * run ended up. `parked_resumable` appears in both sets deliberately — it is a recorded outcome
 * that is nevertheless re-enterable into `provisioning` (FR-151).
 *
 * `awaiting_credential` sits between `queued` and `provisioning` because that is where admission
 * puts it: a run that finds no agent credential free enters it **instead of** `provisioning`, and
 * so holds no instance while it waits (003/FR-024, FR-025). It is deliberately not an overload of
 * `queued`, which already means "admitted, waiting on the concurrency ceiling" — 003/FR-029 has to
 * report which of the two scarcities is biting, and every existing query filtering on `queued`
 * would have silently changed meaning (003 research R10).
 */
export const WORKFLOW_STATES = [
  'queued',
  'awaiting_credential',
  'provisioning',
  'running',
  'paused',
  'parked_resumable',
  'succeeded',
  'failed',
  'capped',
  'cancelled',
  'needs_attention',
] as const

export type WorkflowState = (typeof WORKFLOW_STATES)[number]

export const isWorkflowState = createEnumGuard(WORKFLOW_STATES)

/**
 * The states from which no further work happens without a human. Every member of
 * {@link TERMINAL_OUTCOMES} is also a state, which is what this list asserts.
 */
export const TERMINAL_WORKFLOW_STATES = TERMINAL_OUTCOMES

/**
 * States in which the workflow may still be holding compute. A lease outliving one of these is
 * what the FR-039 reconciliation sweep releases.
 *
 * `awaiting_credential` is a member even though such a run holds no compute at all, and that is the
 * load-bearing half of adding it (003 research R10). The same sweep resolves agent-credential
 * leases whose workflow is no longer live (003/FR-022); a waiting run absent from this list would
 * be read as finished, and the reservation it is waiting on — or has just been granted — would be
 * swept away underneath it. Membership here is what keeps the sweep treating it as alive.
 */
export const ACTIVE_WORKFLOW_STATES = [
  'queued',
  'awaiting_credential',
  'provisioning',
  'running',
  'paused',
] as const

export type ActiveWorkflowState = (typeof ACTIVE_WORKFLOW_STATES)[number]
