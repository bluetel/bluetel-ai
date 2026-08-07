import { createEnumGuard } from './enum-guard'
import { TERMINAL_OUTCOMES } from './terminal-outcome'

/**
 * Every state a workflow row may hold.
 *
 * The first five are lifecycle states; the remainder are the FR-064 outcome names, which double as
 * states so that `workflows.state` and `workflows.terminal_outcome` never disagree about where a
 * run ended up. `parked_resumable` appears in both sets deliberately — it is a recorded outcome
 * that is nevertheless re-enterable into `provisioning` (FR-151).
 */
export const WORKFLOW_STATES = [
  'queued',
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
 */
export const ACTIVE_WORKFLOW_STATES = ['queued', 'provisioning', 'running', 'paused'] as const

export type ActiveWorkflowState = (typeof ACTIVE_WORKFLOW_STATES)[number]
