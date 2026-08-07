import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { createFakeConnector, fakeConnectorFactory } from './connector-fake'
import {
  connectorFor,
  createConnectorRegistry,
  unregisteredConnectorMessage,
} from './connector-registry'

describe('createConnectorRegistry (FR-192)', () => {
  const connector = createFakeConnector()

  it('answers with the factory a deployment registered', () => {
    const registry = createConnectorRegistry({ jira: fakeConnectorFactory(connector) })

    expect(registry.factoryFor('jira')).toBeDefined()
    expect(registry.types()).toEqual(['jira'])
  })

  it('answers undefined for a type this deployment registered nothing for', () => {
    expect(createConnectorRegistry().factoryFor('jira')).toBeUndefined()
  })

  it('reports an empty registry rather than pretending to have one connector', () => {
    expect(createConnectorRegistry().types()).toEqual([])
  })

  it('copies the entries, so a later mutation cannot change what the platform ticks', () => {
    const entries: Record<string, ReturnType<typeof fakeConnectorFactory>> = {}
    const registry = createConnectorRegistry(entries)

    entries.jira = fakeConnectorFactory(connector)

    expect(registry.factoryFor('jira')).toBeUndefined()
  })
})

describe('connectorFor', () => {
  const connector = createFakeConnector()
  const input = {
    type: 'jira' as const,
    config: {},
    credential: 'fixture',
    baseUrl: 'https://x.invalid',
  }

  it('builds the connector for the row being ticked', () => {
    const registry = createConnectorRegistry({ jira: fakeConnectorFactory(connector) })

    expect(connectorFor(registry, input)).toBe(connector)
  })

  it('hands the factory the credential separately from the config (FR-072, FR-098)', () => {
    let seen: { config: unknown; credential: string } | undefined
    const registry = createConnectorRegistry({
      jira: (factoryInput) => {
        seen = { config: factoryInput.config, credential: factoryInput.credential }
        return connector
      },
    })

    connectorFor(registry, { ...input, config: { projectPrefix: 'FIX' } })

    expect(seen?.config).toEqual({ projectPrefix: 'FIX' })
    expect(JSON.stringify(seen?.config)).not.toContain('fixture')
    expect(seen?.credential).toBe('fixture')
  })

  it('throws rather than ticking nothing when a type is unregistered (FR-105)', () => {
    expect(() => connectorFor(createConnectorRegistry(), input)).toThrow(
      unregisteredConnectorMessage('jira'),
    )
  })
})

/**
 * FR-192, as a test rather than as a comment.
 *
 * "Adding a second integration type MUST require no change to `sisyphus-api`, the control plane or
 * the panel beyond registering the new package." A control-plane module that imported an
 * integration package by name would be a change every new type had to make, so the rule is checked
 * where it can actually be broken: in the source.
 */
describe('the control plane never names a board (FR-192)', () => {
  const modules = [
    'assemble-prompt.ts',
    'connector-registry.ts',
    'integration-health.ts',
    'integration-store.ts',
    'integration-tick.ts',
    'prompt-redact.ts',
    'sync-schedules.ts',
  ]

  it.each(modules)('%s does not import an integration package', (module) => {
    const source = readFileSync(new URL(`./${module}`, import.meta.url), 'utf8')

    expect(source).not.toMatch(/from '@bluetel-ai\/sisyphus-integration-/)
  })

  it.each(modules)('%s does not mention Jira outside prose', (module) => {
    const source = readFileSync(new URL(`./${module}`, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')

    expect(source.toLowerCase()).not.toContain('jira')
  })
})
