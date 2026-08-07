import type { WorkflowDetailResult } from '../workflow-detail-readouts'

import type { ChainMember } from './chain-model'

/**
 * One `workflow.byId` result as a chain member (T102).
 *
 * A projection and nothing else: the chain view needs eleven fields of a row that carries forty,
 * and narrowing here rather than passing the whole detail through is what keeps `ChainMember`
 * structural — the same shape `workflow.chain` returns, so swapping the loader is an assignment
 * rather than a rewrite of the panel.
 */
export const toChainMember = (detail: WorkflowDetailResult): ChainMember => ({
  workflowId: detail.workflow.id,
  predecessorWorkflowId: detail.workflow.predecessorWorkflowId,
  state: detail.workflow.state,
  terminalOutcome: detail.workflow.terminalOutcome,
  model: detail.workflow.model,
  turnCap: detail.workflow.turnCap,
  spendCap: detail.workflow.spendCap,
  turnsUsed: detail.workflow.turnsUsed,
  spendUsed: detail.workflow.spendUsed,
  createdAt: detail.workflow.createdAt,
  updatedAt: detail.workflow.updatedAt,
})
