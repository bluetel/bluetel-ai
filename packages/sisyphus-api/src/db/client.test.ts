import { afterEach, describe, expect, it } from 'vitest'

import { createDatabaseClient, getDatabaseClient, resetDatabaseClient } from './client'

/**
 * These tests never open a socket. `postgres` resolves and connects lazily, so a client can be
 * built, inspected and closed against an address nothing is listening on — which is exactly the
 * property that lets the panel import the schema at build time.
 */
const CONNECTION_STRING = 'postgres://sisyphus:sisyphus@127.0.0.1:1/sisyphus_unit_test'

const created: { close: () => Promise<void> }[] = []

const build = (overrides: Partial<Parameters<typeof createDatabaseClient>[0]> = {}) => {
  const client = createDatabaseClient({ connectionString: CONNECTION_STRING, ...overrides })
  created.push(client)
  return client
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((client) => client.close()))
  await resetDatabaseClient()
})

describe('createDatabaseClient', () => {
  it('returns a Drizzle handle, the raw driver and a close function', () => {
    const client = build()
    expect(typeof client.db.select).toBe('function')
    expect(typeof client.sql).toBe('function')
    expect(typeof client.close).toBe('function')
  })

  it('does not connect at construction time', () => {
    const client = build()
    expect(client.sql.options.host).toStrictEqual(['127.0.0.1'])
  })

  it('exposes the full schema on the handle, so relational queries resolve', () => {
    const client = build()
    expect(Object.keys(client.db._.fullSchema)).toContain('workflows')
    expect(Object.keys(client.db._.fullSchema)).toContain('computeLeases')
  })

  it('rejects a blank connection string at startup rather than at first query', () => {
    expect(() => createDatabaseClient({ connectionString: '   ' })).toThrow(
      /needs a connection string/,
    )
  })

  it('disables prepared statements by default, because a transaction-mode pooler loses them', () => {
    expect(build().sql.options.prepare).toBe(false)
    expect(build({ prepare: true }).sql.options.prepare).toBe(true)
  })

  it('applies the pool defaults', () => {
    const { options } = build().sql
    expect(options.max).toBe(10)
    expect(options.idle_timeout).toBe(30)
    expect(options.connect_timeout).toBe(10)
    expect(options.max_lifetime).toBe(1800)
  })

  it('lets every pool setting be overridden', () => {
    const { options } = build({
      maxConnections: 3,
      idleTimeoutSeconds: 1,
      connectTimeoutSeconds: 2,
      maxLifetimeSeconds: 4,
    }).sql
    expect(options.max).toBe(3)
    expect(options.idle_timeout).toBe(1)
    expect(options.connect_timeout).toBe(2)
    expect(options.max_lifetime).toBe(4)
  })

  it('gives each call its own pool', () => {
    expect(build().sql).not.toBe(build().sql)
  })

  it('closes more than once without error, so a double shutdown is safe', async () => {
    const client = createDatabaseClient({ connectionString: CONNECTION_STRING })
    await client.close()
    await expect(client.close()).resolves.toBeUndefined()
  })
})

describe('getDatabaseClient', () => {
  it('reuses one pool on a warm container instead of exhausting the database', () => {
    const first = getDatabaseClient({ connectionString: CONNECTION_STRING })
    const second = getDatabaseClient({ connectionString: CONNECTION_STRING })
    expect(second).toBe(first)
  })

  it('builds a fresh client after a reset', async () => {
    const first = getDatabaseClient({ connectionString: CONNECTION_STRING })
    await resetDatabaseClient()
    expect(getDatabaseClient({ connectionString: CONNECTION_STRING })).not.toBe(first)
  })

  it('tolerates a reset when nothing was ever created', async () => {
    await expect(resetDatabaseClient()).resolves.toBeUndefined()
  })
})
