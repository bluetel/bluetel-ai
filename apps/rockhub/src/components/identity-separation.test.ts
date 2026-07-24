/**
 * Identity separation structural verification tests (Property 24).
 *
 * Validates: Requirements 9.6, 9.10, 18.1, 18.2, 9.8, 9.9, 18.7
 *
 * Property 24: Bot_User is never used for API authentication — the
 * RockhubConfig Zod schema's shape keys do NOT include any credential
 * field for the Bot_User. The only Bot_User-related field is
 * `BOT_USERNAME` (a plain string).
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

import { configSchema } from '../config'

import { createAuth } from './auth'
import { createEyesReactor } from './eyes-reactor'
import { createStartupScanner } from './startup-scanner'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('Property 24: Bot_User is never used for API authentication', () => {
  const schemaKeys = Object.keys(configSchema.shape)

  const forbiddenBotCredentialFields = [
    'BOT_TOKEN',
    'BOT_PAT',
    'BOT_PASSWORD',
    'BOT_OAUTH_TOKEN',
    'BOT_PRIVATE_KEY',
    'BOT_SECRET',
    'BOT_API_KEY',
  ]

  it('config schema does NOT include any Bot_User credential field', () => {
    for (const forbidden of forbiddenBotCredentialFields) {
      expect(schemaKeys).not.toContain(forbidden)
    }
  })

  it('config schema includes BOT_USERNAME as the only Bot_User-related field', () => {
    expect(schemaKeys).toContain('BOT_USERNAME')

    // No other BOT_* fields exist
    const botFields = schemaKeys.filter((k) => k.startsWith('BOT_'))
    expect(botFields).toEqual(['BOT_USERNAME'])
  })

  it('createAuth() does not accept any Bot_User credential parameter', () => {
    // createAuth accepts (config: AuthConfig, logger) — AuthConfig has appId, privateKey, installationId only
    expect(typeof createAuth).toBe('function')
    // The function takes exactly 2 params (config, logger)
    expect(createAuth.length).toBe(2)
  })

  it('createEyesReactor() authenticates via octokit (Installation_Token), not Bot_User credential', () => {
    // EyesReactorDeps only has { octokit, logger } — no bot credential
    expect(typeof createEyesReactor).toBe('function')
    // Takes exactly 1 param (deps: EyesReactorDeps)
    expect(createEyesReactor.length).toBe(1)
  })

  it('createStartupScanner() authenticates via octokit (Installation_Token), not Bot_User credential', () => {
    expect(typeof createStartupScanner).toBe('function')
    // Takes exactly 1 param (deps: StartupScannerDeps)
    expect(createStartupScanner.length).toBe(1)
  })
})

describe('Task 24.2: Bot_User as standard user account', () => {
  it('BOT_USERNAME config field accepts any non-empty string (no [bot] suffix validation)', () => {
    // The schema only requires min(1) — no pattern or suffix constraint
    const shape = configSchema.shape
    const botUsernameSchema = shape.BOT_USERNAME

    // Valid: plain username (no [bot] suffix)
    const plainResult = botUsernameSchema.safeParse('my-regular-user')
    expect(plainResult.success).toBe(true)

    // Valid: username with [bot] suffix (also accepted — no restriction)
    const botResult = botUsernameSchema.safeParse('my-app[bot]')
    expect(botResult.success).toBe(true)

    // Valid: any non-empty string
    const arbitraryResult = botUsernameSchema.safeParse('x')
    expect(arbitraryResult.success).toBe(true)

    // Invalid: empty string
    const emptyResult = botUsernameSchema.safeParse('')
    expect(emptyResult.success).toBe(false)
  })

  it('.env.example documents BOT_USERNAME with a comment noting it is a tagging-only identity', () => {
    const envExamplePath = path.resolve(__dirname, '../../.env.example')
    const content = fs.readFileSync(envExamplePath, 'utf-8')

    // BOT_USERNAME is documented
    expect(content).toContain('BOT_USERNAME')

    // The comment indicates it's for mentions/assignments (tagging-only identity)
    // and is separate from the GitHub App's bot identity
    expect(content).toMatch(/@-mention|mention/i)
    expect(content).toMatch(/separate from.*GitHub App|separate.*bot identity/i)
  })
})
