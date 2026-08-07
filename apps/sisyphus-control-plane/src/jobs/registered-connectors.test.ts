import { readdirSync, readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

import { connectorFor } from './connector-registry'
import {
  createRegisteredConnectorRegistry,
  jiraConnectorFactory,
  REGISTERED_CONNECTOR_TYPES,
  widenConnectorConfig,
} from './registered-connectors'

/**
 * The composition root, and the boundary it is allowed to be the only one to cross.
 *
 * Nothing here makes a request. The factory is exercised for the composition it performs — a client
 * built around one board's credential, a connector built around that client — and the connector's
 * methods are never called, so no `fetch` is reached even by accident.
 */

const factoryInput = {
  type: 'jira' as const,
  config: { baseUrl: 'https://acme.atlassian.net', projectPrefix: 'ACME', label: 'sisyphus' },
  credential: 'someone@acme.test:token',
  baseUrl: 'https://acme.atlassian.net',
}

describe('createRegisteredConnectorRegistry', () => {
  it('registers the one type this deployment ships', () => {
    expect(createRegisteredConnectorRegistry().types()).toStrictEqual(REGISTERED_CONNECTOR_TYPES)
  })

  it('builds a connector for the row being ticked, without reaching the board', () => {
    const connector = connectorFor(createRegisteredConnectorRegistry(), factoryInput)

    expect(connector.type).toBe('jira')
  })

  it('builds a fresh connector per call, so one board’s credential cannot serve another', () => {
    const registry = createRegisteredConnectorRegistry()

    expect(connectorFor(registry, factoryInput)).not.toBe(connectorFor(registry, factoryInput))
  })

  it('keeps the credential off the config it hands the connector (FR-072, FR-098)', () => {
    expect(JSON.stringify(factoryInput.config)).not.toContain('token')
    expect(JSON.stringify(jiraConnectorFactory(factoryInput))).not.toContain('token')
  })
})

describe('widenConnectorConfig', () => {
  it('passes the untyped config straight through, for the connector to parse', async () => {
    const seen: unknown[] = []
    const widened = widenConnectorConfig({
      type: 'jira',
      validate: (config: { label: string }) => {
        seen.push(config)
        return Promise.resolve({ ok: true, checks: [] })
      },
      discover: () => Promise.resolve([]),
      resolveProfile: () => ({ matched: false, reason: 'no_mapping_matched' }),
      assemblePromptParts: () => ({
        title: '',
        url: '',
        body: null,
        comments: [],
        truncatedComments: 0,
      }),
      writeBack: () =>
        Promise.resolve({ key: 'k', disposition: 'performed' as const, reference: 'r' }),
    })

    await widened.validate({ label: 'anything' })

    expect(seen).toStrictEqual([{ label: 'anything' }])
  })

  it('surfaces a configuration the connector refuses as a rejection, not a silent tick', async () => {
    const widened = widenConnectorConfig({
      type: 'jira',
      validate: () => Promise.resolve({ ok: true, checks: [] }),
      discover: () => Promise.reject(new Error('the configuration could not be parsed')),
      resolveProfile: () => ({ matched: false, reason: 'no_mapping_matched' }),
      assemblePromptParts: () => ({
        title: '',
        url: '',
        body: null,
        comments: [],
        truncatedComments: 0,
      }),
      writeBack: () =>
        Promise.resolve({ key: 'k', disposition: 'performed' as const, reference: 'r' }),
    })

    await expect(widened.discover({}, {})).rejects.toThrow('could not be parsed')
  })
})

/**
 * The other half of FR-192, from this side.
 *
 * `connector-registry.test.ts` asserts that the modules making up the tick name no board. This
 * asserts the complement: that the file which *does* is exactly one, so "adding a type is a package
 * and a registry entry" stays a fact about the source rather than an intention.
 */
describe('exactly one control-plane module names a board (FR-192)', () => {
  const directory = new URL('.', import.meta.url)

  const namesAnIntegrationPackage = (file: string): boolean =>
    /from '@bluetel-ai\/sisyphus-integration-/.test(readFileSync(new URL(file, directory), 'utf8'))

  it('and it is this one', () => {
    const offenders = readdirSync(directory)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .filter(namesAnIntegrationPackage)

    expect(offenders).toStrictEqual(['registered-connectors.ts'])
  })

  it('reaches the package through its barrel, never a module inside it', () => {
    const source = readFileSync(new URL('registered-connectors.ts', directory), 'utf8')

    expect(source).toContain("from '@bluetel-ai/sisyphus-integration-jira'")
    expect(source).not.toMatch(/from '@bluetel-ai\/sisyphus-integration-jira\//)
  })

  it('does not reach a board when the registry is merely built', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    connectorFor(createRegisteredConnectorRegistry(), factoryInput)

    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
