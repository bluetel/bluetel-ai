import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import * as enums from './index'

const directory = dirname(fileURLToPath(import.meta.url))

const files = readdirSync(directory).filter((name) => name.endsWith('.ts'))
const testFiles = files.filter((name) => name.endsWith('.test.ts'))
const moduleFiles = files.filter((name) => !name.endsWith('.test.ts') && name !== 'index.ts')
const barrelSource = readFileSync(join(directory, 'index.ts'), 'utf8')

const VOCABULARIES = [
  'ACTIVE_WORKFLOW_STATES',
  'ARTIFACT_KINDS',
  'BOOTSTRAP_PHASES',
  'BOOTSTRAP_PHASE_OUTCOMES',
  'CLAUDE_MODELS',
  'CORRECTION_DELIVERY_OUTCOMES',
  'CREDENTIAL_RELEASE_REASONS',
  'CREDENTIAL_STATES',
  'ENTRY_RESULTS',
  'EXTERNAL_ACTION_KINDS',
  'EXTERNAL_ACTION_RESULTS',
  'INTEGRATION_TYPES',
  'NOTIFICATION_EVENTS',
  'PURCHASE_MODES',
  'REPORTABLE_CORRECTION_DELIVERY_OUTCOMES',
  'REPORTABLE_SUPERVISION_DELIVERY_OUTCOMES',
  'REVIEW_FINDING_SEVERITIES',
  'REVIEW_VERDICTS',
  'SKILL_NAMES',
  'SNAPSHOT_BOUNDARIES',
  'SUPERVISION_DELIVERY_OUTCOMES',
  'TERMINAL_OUTCOMES',
  'TERMINAL_WORKFLOW_STATES',
  'USER_ROLES',
  'VALIDATION_BOOTSTRAP_PHASES',
  'VALIDATION_OUTCOMES',
  'WORKFLOW_STATES',
  'WORKFLOW_TYPES',
] as const

const GUARDS = [
  'isArtifactKind',
  'isBootstrapPhase',
  'isBootstrapPhaseOutcome',
  'isClaudeModel',
  'isCorrectionDeliveryOutcome',
  'isCredentialReleaseReason',
  'isCredentialState',
  'isEntryResult',
  'isExternalActionKind',
  'isExternalActionResult',
  'isIntegrationType',
  'isNotificationEvent',
  'isPurchaseMode',
  'isReviewFindingSeverity',
  'isReviewVerdict',
  'isSkillName',
  'isSnapshotBoundary',
  'isSupervisionDeliveryOutcome',
  'isTerminalOutcome',
  'isUserRole',
  'isValidationBootstrapPhase',
  'isValidationOutcome',
  'isWorkflowState',
  'isWorkflowType',
] as const

/** Every module specifier a file imports from, including bare `import '…'` side-effect forms. */
const importSpecifiers = (source: string): readonly string[] =>
  [...source.matchAll(/(?:^|\n)\s*import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g)].map(
    (match) => match[1],
  )

/** Local to this directory, and not climbing out of it. */
const isInternal = (specifier: string): boolean =>
  specifier.startsWith('./') && !specifier.includes('..')

describe('enums barrel', () => {
  it('re-exports every vocabulary tuple, so consumers never reach into a module file', () => {
    for (const name of VOCABULARIES) {
      expect(Object.keys(enums)).toContain(name)
    }
  })

  it('re-exports a guard alongside every vocabulary', () => {
    for (const name of GUARDS) {
      expect(Object.keys(enums)).toContain(name)
    }
  })

  it('exposes only tuples of non-empty, trimmed, lowercase values', () => {
    for (const name of VOCABULARIES) {
      const tuple: readonly string[] = enums[name]
      expect(tuple.length).toBeGreaterThan(0)
      for (const value of tuple) {
        expect(value).toBe(value.toLowerCase())
        expect(value.trim()).toBe(value)
        expect(value).not.toBe('')
      }
    }
  })

  it('leaves no module file out of the barrel', () => {
    for (const file of moduleFiles) {
      expect(barrelSource).toContain(`'./${file.replace(/\.ts$/, '')}'`)
    }
  })
})

/**
 * The rule this directory exists to hold.
 *
 * `src/enums/` is reachable from the panel through `@bluetel-ai/sisyphus-api/client`, so a single
 * `import { pgEnum } from 'drizzle-orm/pg-core'` in any module here would pull Drizzle — and, one
 * hop further, the `postgres` driver — into a browser bundle. The generation therefore runs one
 * way: these tuples are the source, and `src/db/schema/enums.ts` builds its `pgEnum`s **from**
 * them.
 *
 * This is deliberately not a test that the values match. A values test passes just as happily when
 * `src/enums/` imports the database, which is the failure it would need to catch. What is asserted
 * instead is structural: **no module in this directory imports anything outside it.** That is
 * stricter than banning `drizzle-orm` by name, and it also catches `../db`, `postgres`, `zod` and
 * whatever else someone reaches for later.
 */
describe('browser safety', () => {
  it('finds the modules it is meant to be checking', () => {
    // Without this the whole suite would pass vacuously on an empty directory listing.
    expect(moduleFiles.length).toBeGreaterThan(10)
    expect(moduleFiles).toContain('workflow-state.ts')
  })

  it('imports nothing from outside this directory — no drizzle-orm, no driver, no ../db', () => {
    for (const file of [...moduleFiles, 'index.ts']) {
      for (const specifier of importSpecifiers(readFileSync(join(directory, file), 'utf8'))) {
        expect(
          isInternal(specifier),
          `${file} imports '${specifier}'; src/enums must stay dependency-free so the panel can bundle it`,
        ).toBe(true)
      }
    }
  })

  it('lets the colocated tests reach vitest and this file’s own directory reader, only', () => {
    const permitted = new Set(['vitest', 'node:fs', 'node:path', 'node:url'])
    for (const file of testFiles) {
      for (const specifier of importSpecifiers(readFileSync(join(directory, file), 'utf8'))) {
        expect(
          isInternal(specifier) || permitted.has(specifier),
          `${file} imports '${specifier}'; a test that reaches outside src/enums proves nothing here`,
        ).toBe(true)
      }
    }
  })

  it('would reject a database import, which is the only reason the check above is worth having', () => {
    const offending = importSpecifiers(
      ["import { pgEnum } from 'drizzle-orm/pg-core'", "import { userRoleEnum } from '../db'"].join(
        '\n',
      ),
    )

    expect(offending).toStrictEqual(['drizzle-orm/pg-core', '../db'])
    expect(offending.some(isInternal)).toBe(false)
  })
})
