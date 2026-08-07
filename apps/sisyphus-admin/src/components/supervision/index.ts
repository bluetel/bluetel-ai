/**
 * Supervising a run in flight (Phase 7, US2).
 *
 * The controls mount into `components/workflows/supervision-slot.tsx`, which has been holding the
 * space and stating its own absence since T076. Nothing here is a primitive — the panel has one
 * primitive set, in `src/components/ui`, and everything below composes it.
 *
 * The rule this directory exists to hold is in `./supervision-status.ts`: **"paused" is what the
 * executor confirmed, never what somebody requested.**
 *
 * Consumers import this barrel, never a module inside it.
 */

export { CorrectionList } from './correction-list'
export type { CorrectionReadout } from './correction-list'

export { SupervisionControls } from './controls'
export type { SupervisionPendingAction } from './controls'

export {
  acceptsCorrections,
  availableSupervisionActions,
  isAwaitingExecutor,
  isConfirmedPause,
  supervisionAction,
  supervisionReadout,
  supervisionStatus,
} from './supervision-status'
export type {
  PendingSupervisionCommand,
  SupervisionAction,
  SupervisionCommandName,
  SupervisionReadout,
  SupervisionStatus,
} from './supervision-status'
