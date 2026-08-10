import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import * as schemas from './index'

const SCHEMA_DIRECTORY = path.join(import.meta.dirname)

describe('the schemas barrel', () => {
  it('re-exports every domain, so consumers never reach into a module underneath it', () => {
    for (const name of [
      // workflow
      'startWorkflowInput',
      'listWorkflowsInput',
      'correctWorkflowInput',
      // notification
      'setNotificationPreferenceInput',
      // machine
      'heartbeatInput',
      'reportTerminalInput',
      // configuration
      'registerBundleInput',
      'createWorkspaceInput',
      'createProfileInput',
      'createIntegrationInput',
      'grantProfileAccessInput',
      'createCredentialGroupInput',
      'attachCredentialGroupInput',
      // common
      'uuidInput',
      'moneyAmount',
    ]) {
      expect(schemas).toHaveProperty(name)
    }
  })

  it('is safe in a browser bundle — nothing here reaches the server or the driver', async () => {
    // The FR-005 boundary is an exports-map fact, but only as long as this directory stays free of
    // server imports: `./client` re-exports this barrel wholesale, so one `../db` import here
    // would put Drizzle and `postgres` into a panel client component.
    const files = [
      'index.ts',
      'common.ts',
      'workflow.ts',
      'notification.ts',
      'machine.ts',
      'bundle.ts',
      'workspace.ts',
      'profile.ts',
      'integration.ts',
      'access.ts',
    ]

    for (const file of files) {
      const source = await readFile(path.join(SCHEMA_DIRECTORY, file), 'utf8')
      const imports = [...source.matchAll(/^import .*? from '(?<specifier>[^']+)'/gmu)].map(
        (match) => match.groups?.specifier ?? '',
      )

      expect(imports.filter((specifier) => specifier.includes('/db'))).toStrictEqual([])
      expect(imports.filter((specifier) => specifier.includes('/server'))).toStrictEqual([])
      expect(imports.filter((specifier) => specifier.includes('drizzle'))).toStrictEqual([])
      expect(imports.filter((specifier) => specifier.includes('postgres'))).toStrictEqual([])
    }
  })

  it('uses local imports with no file extension', async () => {
    const source = await readFile(path.join(SCHEMA_DIRECTORY, 'index.ts'), 'utf8')

    expect(source).not.toContain(".js'")
  })
})
