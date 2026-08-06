/**
 * The successor-chain view (T102, FR-150, FR-152, FR-190).
 *
 * Consumers import this barrel, never a module inside it.
 */

export {
  ABSENT,
  chainNeighbours,
  chainStateReadout,
  orderChain,
  summariseChain,
  toChainReadouts,
} from './chain-model'
export type { ChainMember, ChainMemberReadouts, ChainNeighbours, ChainTotals } from './chain-model'

export { toChainMember } from './chain-source'

export { MAX_CHAIN_WALK, walkPredecessors } from './chain-walk'
export type { ChainCompleteness, ChainLoader, ChainMemberReader, LoadedChain } from './chain-walk'

export { WorkflowChainPanel } from './workflow-chain-panel'
export { WorkflowChainView } from './workflow-chain-view'
