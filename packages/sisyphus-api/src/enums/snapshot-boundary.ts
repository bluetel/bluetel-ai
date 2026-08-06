import { createEnumGuard } from './enum-guard'

/**
 * Why a session snapshot was taken.
 *
 * All four go through the same `suspend()` routine (R3), which is the point of enumerating them:
 * the boundary is recorded so a restore can explain where the run was interrupted, not so four
 * different code paths can exist.
 */
export const SNAPSHOT_BOUNDARIES = ['completion', 'pause', 'interruption', 'stop'] as const

export type SnapshotBoundary = (typeof SNAPSHOT_BOUNDARIES)[number]

export const isSnapshotBoundary = createEnumGuard(SNAPSHOT_BOUNDARIES)
