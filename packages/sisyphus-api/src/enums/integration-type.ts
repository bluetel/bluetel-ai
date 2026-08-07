import { createEnumGuard } from './enum-guard'

/**
 * The connector types the platform knows how to talk to.
 *
 * One package per type (`packages/sisyphus-integration-jira`), so adding a type is a new workspace
 * member satisfying the connector contract plus a value here — not a branch inside a shared
 * connector. Jira is the only type in scope for this feature.
 */
export const INTEGRATION_TYPES = ['jira'] as const

export type IntegrationType = (typeof INTEGRATION_TYPES)[number]

export const isIntegrationType = createEnumGuard(INTEGRATION_TYPES)
