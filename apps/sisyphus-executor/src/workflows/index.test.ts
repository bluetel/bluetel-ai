import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import * as workflows from './index'

/**
 * The barrel — and the two properties it is holding in place.
 */

const here = dirname(fileURLToPath(import.meta.url))

const productionModules = (): readonly string[] =>
  readdirSync(here).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'index.ts',
  )

describe('the workflows barrel', () => {
  it('exports both workflow types', () => {
    expect(typeof workflows.runAutonomousWorkflow).toBe('function')
    expect(typeof workflows.runReviewWorkflow).toBe('function')
  })

  it('exports one route to a ticket transition, and it requires a directive', () => {
    expect(typeof workflows.transitionTicket).toBe('function')
    expect(typeof workflows.requireDirective).toBe('function')
  })

  it('states the iteration bound without being the thing that enforces it', () => {
    expect(workflows.MAX_ITERATIONS).toBe(3)
    expect(workflows.nextOrdinal([])).toBe(1)
  })

  it('has every module colocated with a test', () => {
    const missing = productionModules().filter(
      (name) => !readdirSync(here).includes(name.replace(/\.ts$/u, '.test.ts')),
    )

    expect(missing).toEqual([])
  })

  it('reaches the API contract as types only, if at all (FR-005)', () => {
    const valueImports = productionModules()
      .map((name) => ({ name, text: readFileSync(join(here, name), 'utf8') }))
      .filter(({ text }) => /import\s+(?!type)[^'"]*from\s+'@bluetel-ai\/sisyphus-api/u.test(text))
      .map(({ name }) => name)

    expect(valueImports).toEqual([])
  })

  it('never names the server or database subpaths', () => {
    const offenders = productionModules().filter((name) => {
      const text = readFileSync(join(here, name), 'utf8')

      return (
        text.includes('@bluetel-ai/sisyphus-api/server') ||
        text.includes('@bluetel-ai/sisyphus-api/db')
      )
    })

    expect(offenders).toEqual([])
  })
})
