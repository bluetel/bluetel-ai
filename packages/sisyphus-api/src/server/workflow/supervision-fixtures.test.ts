import { describe, expect, it } from 'vitest'

import { createGate, readTestDatabaseUrl, sleep } from './supervision-fixtures'

/**
 * The fixture module's own behaviour, with no database involved.
 *
 * The gate is the whole choreography of the racing tests — a transaction is held open until it is
 * released, and a gate that resolved early would turn a proof about locking into a proof about
 * timing. It is small enough to be obviously right and load-bearing enough to be worth asserting.
 */

describe('createGate', () => {
  it('does not resolve until it is opened', async () => {
    const gate = createGate()
    let opened = false
    const watcher = gate.opened.then(() => {
      opened = true
    })

    await sleep(10)
    expect(opened).toBe(false)

    gate.open()
    await watcher
    expect(opened).toBe(true)
  })

  it('is safe to open twice', async () => {
    const gate = createGate()
    gate.open()
    gate.open()

    await expect(gate.opened).resolves.toBeUndefined()
  })
})

describe('readTestDatabaseUrl, re-exported so a suite needs one import', () => {
  it('treats a blank value as absent, so a misconfigured CI skips rather than fails on connect', () => {
    expect(readTestDatabaseUrl({ SISYPHUS_TEST_DATABASE_URL: '   ' })).toBeUndefined()
    expect(readTestDatabaseUrl({})).toBeUndefined()
    expect(readTestDatabaseUrl({ SISYPHUS_TEST_DATABASE_URL: 'postgres://x/y' })).toBe(
      'postgres://x/y',
    )
  })
})
