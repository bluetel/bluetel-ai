import { createEnumGuard } from './enum-guard'

/**
 * How the run's instance is bought (research.md R7).
 *
 * `spot` is the default: interruptible capacity with a two-minute reclamation notice, which the
 * single `suspend()` routine turns into a snapshot rather than a lost run (R3). `on_demand` is
 * available for work that must not be reclaimed.
 */
export const PURCHASE_MODES = ['spot', 'on_demand'] as const

export type PurchaseMode = (typeof PURCHASE_MODES)[number]

export const isPurchaseMode = createEnumGuard(PURCHASE_MODES)

/** Interruptible capacity is the default (research.md R7). */
export const DEFAULT_PURCHASE_MODE: PurchaseMode = 'spot'
