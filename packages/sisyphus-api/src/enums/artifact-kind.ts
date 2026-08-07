import { createEnumGuard } from './enum-guard'

/**
 * What a run produced that outlives it.
 *
 * `pull_request` and `diff` are both code, and they are separate because one lives outside the
 * platform behind a URL and the other is an object the platform stores and expires (FR-071).
 */
export const ARTIFACT_KINDS = ['pull_request', 'diff', 'report', 'attachment'] as const

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

export const isArtifactKind = createEnumGuard(ARTIFACT_KINDS)
