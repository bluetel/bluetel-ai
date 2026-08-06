/**
 * Local cap enforcement (T061).
 *
 * Consumers import from here and never from the module behind it.
 */

export { capAdvisoryNotices, createCapEnforcer, evaluateCaps, formatSpend } from './enforce'
export type {
  CapBreach,
  CapConsumptionReport,
  CapContinueDecision,
  CapDecision,
  CapEnforcer,
  CapEvaluation,
  CapKind,
  CapLimits,
  CapStopDecision,
} from './enforce'
