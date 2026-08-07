import { describe, expect, it } from 'vitest'

import * as barrel from './index'

/**
 * The barrel is the directory's public surface, so what it does — and does not — export is a
 * contract in its own right (FR-004).
 */
describe('the admin barrel', () => {
  it('mounts every sub-router root.ts reaches through it', () => {
    expect(Object.keys(barrel.adminRouter._def.record).sort()).toStrictEqual([
      // FR-178's trail has been written since the first bundle was registered; `audit` is the
      // mount that finally lets it be read. See `./audit.ts`.
      'audit',
      'bundles',
      'grants',
      'integrations',
      'profiles',
      'users',
      'workspaces',
    ])
  })

  it('mounts integrations as the refusing default, not as a stub that reports success', async () => {
    // `integrationsRouter` is built over `createRefusingConnectorRegistry`, so a deployment that
    // has supplied no connector cannot have `validate` answer as though it reached a board.
    const registry = barrel.createRefusingConnectorRegistry()

    await expect(
      registry.connectorFor({
        type: 'jira',
        config: {},
        credentialSecretArn: 'arn:aws:secretsmanager:eu-west-2:000000000000:secret:fixture',
        baseUrl: 'https://boards.invalid',
      }),
    ).resolves.toBeUndefined()
    expect(barrel.CONNECTOR_NOT_CONFIGURED_REASON).toContain('connector')
  })

  it('exports the sub-routers individually, so a caller can reach one without assembling all', () => {
    for (const name of [
      'usersRouter',
      'adminGrantsRouter',
      'bundlesRouter',
      'workspacesRouter',
      'profilesRouter',
      'integrationsRouter',
      'auditRouter',
    ] as const) {
      expect(typeof barrel[name]).toBe('object')
    }
  })

  it('exports the audit read beside the writer it reads back (FR-178)', () => {
    // `recordConfigurationChange` was exported here long before anything could read what it wrote.
    expect(typeof barrel.recordConfigurationChange).toBe('function')
    expect(typeof barrel.listConfigurationAudit).toBe('function')
    expect(typeof barrel.listConfigurationAuditInput.parse).toBe('function')
  })

  it('exports the integration seam the composition root supplies', () => {
    expect(typeof barrel.createIntegrationsRouter).toBe('function')
    expect(typeof barrel.createRefusingPromptLayering).toBe('function')
  })

  it('exports the channel the control plane listens on for a manual tick (FR-035)', () => {
    expect(barrel.MANUAL_TICK_CHANNEL).toBe('sisyphus_integration_tick')
  })

  it('does not export the live-database test support', () => {
    expect(Object.keys(barrel)).not.toContain('readTestDatabaseUrl')
  })
})
