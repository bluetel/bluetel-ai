import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { DATABASE_URL_VARIABLE } from './cli'
import { runDeployMigrateCliCommand, runDeployMigrateCommand, STAGE_VARIABLE } from './deploy'

describe('runDeployMigrateCliCommand', () => {
  it('names the variable it needs rather than failing later with a confusing error', async () => {
    await expect(runDeployMigrateCliCommand({ env: {} })).rejects.toThrow(
      new RegExp(`${STAGE_VARIABLE} is not set`),
    )
  })

  it('treats a blank variable as unset', async () => {
    await expect(runDeployMigrateCliCommand({ env: { [STAGE_VARIABLE]: '   ' } })).rejects.toThrow(
      /is not set/,
    )
  })
})

describe('runDeployMigrateCommand', () => {
  it(
    'opens the tunnel against apps/sisyphus-admin under the given monorepo root, reads the ' +
      "stage's connection URL, migrates with it, and always tears the tunnel and DNS patch down",
    async () => {
      const closeTunnel = vi.fn()
      const restoreDns = vi.fn()
      const openTunnel = vi.fn().mockResolvedValue({ close: closeTunnel })
      const installDnsFallback = vi.fn().mockReturnValue(restoreDns)
      const readConnectionUrl = vi.fn().mockResolvedValue('postgres://user:pass@host:5432/sisyphus')
      const runMigrate = vi.fn().mockResolvedValue('Applied 1 migration(s): 0000_initial_schema')
      const log = (): undefined => undefined

      const result = await runDeployMigrateCommand({
        stage: 'staging',
        monorepoRoot: '/repo',
        region: 'eu-west-2',
        log,
        openTunnel,
        installDnsFallback,
        readConnectionUrl,
        runMigrate,
      })

      expect(result).toBe('Applied 1 migration(s): 0000_initial_schema')
      expect(openTunnel).toHaveBeenCalledWith({
        stage: 'staging',
        adminAppDir: path.join('/repo', 'apps', 'sisyphus-admin'),
      })
      expect(readConnectionUrl).toHaveBeenCalledWith(
        '/sisyphus/staging/database/connection-url',
        'eu-west-2',
      )
      expect(runMigrate).toHaveBeenCalledWith({
        env: { [DATABASE_URL_VARIABLE]: 'postgres://user:pass@host:5432/sisyphus' },
        log,
      })
      expect(closeTunnel).toHaveBeenCalled()
      expect(restoreDns).toHaveBeenCalled()
    },
  )

  it('still tears the tunnel and DNS patch down when the migration itself fails', async () => {
    const closeTunnel = vi.fn()
    const restoreDns = vi.fn()

    await expect(
      runDeployMigrateCommand({
        stage: 'production',
        monorepoRoot: '/repo',
        log: () => undefined,
        openTunnel: vi.fn().mockResolvedValue({ close: closeTunnel }),
        installDnsFallback: vi.fn().mockReturnValue(restoreDns),
        readConnectionUrl: vi.fn().mockResolvedValue('postgres://user:pass@host:5432/sisyphus'),
        runMigrate: vi.fn().mockRejectedValue(new Error('boom')),
      }),
    ).rejects.toThrow('boom')

    expect(closeTunnel).toHaveBeenCalled()
    expect(restoreDns).toHaveBeenCalled()
  })

  it('still tears the tunnel down when reading the connection URL fails', async () => {
    const closeTunnel = vi.fn()

    await expect(
      runDeployMigrateCommand({
        stage: 'staging',
        monorepoRoot: '/repo',
        log: () => undefined,
        openTunnel: vi.fn().mockResolvedValue({ close: closeTunnel }),
        installDnsFallback: vi.fn().mockReturnValue(vi.fn()),
        readConnectionUrl: vi.fn().mockRejectedValue(new Error('parameter not found')),
        runMigrate: vi.fn(),
      }),
    ).rejects.toThrow('parameter not found')

    expect(closeTunnel).toHaveBeenCalled()
  })
})
