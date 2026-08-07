import { createEnumGuard } from './enum-guard'

/**
 * What kind of run this is.
 *
 * - `delegated` — a human handed the agent a task and supervises it. PRs are draft and no ticket
 *   transition is attempted unless explicitly requested (FR-060).
 * - `autonomous` — the agent iterates against its own review until it passes or the caps stop it.
 *   Cannot be created without both a turn cap and a spend cap (FR-055).
 * - `review` — a review-only pass over existing work.
 */
export const WORKFLOW_TYPES = ['delegated', 'autonomous', 'review'] as const

export type WorkflowType = (typeof WORKFLOW_TYPES)[number]

export const isWorkflowType = createEnumGuard(WORKFLOW_TYPES)
