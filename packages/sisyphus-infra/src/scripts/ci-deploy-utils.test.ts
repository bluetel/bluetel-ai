import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { applyEnvContent, fetchGitHubOidcToken, formatEnvFile } from './ci-deploy-utils'

describe('formatEnvFile', () => {
  it('names the source in a header so the copy is not edited', () => {
    expect(formatEnvFile('/sisyphus/staging/admin/env', 'A=1')).toBe(
      '# Generated from the parameter store entry "/sisyphus/staging/admin/env". Do not edit; do not commit.\nA=1\n',
    )
  })

  it('ends with exactly one newline whatever the parameter ended with', () => {
    const withoutNewline = formatEnvFile('/p', 'A=1')
    const withNewlines = formatEnvFile('/p', 'A=1\n\n\n')

    expect(withoutNewline).toBe(withNewlines)
    expect(withNewlines.endsWith('A=1\n')).toBe(true)
  })
})

describe('applyEnvContent', () => {
  const clear = (): void => {
    delete process.env.SISYPHUS_TEST_APPLY_A
    delete process.env.SISYPHUS_TEST_APPLY_B
  }

  beforeEach(clear)
  afterEach(clear)

  it('sets values that are not already present', () => {
    applyEnvContent('SISYPHUS_TEST_APPLY_A=one\nSISYPHUS_TEST_APPLY_B=two')

    expect(process.env.SISYPHUS_TEST_APPLY_A).toBe('one')
    expect(process.env.SISYPHUS_TEST_APPLY_B).toBe('two')
  })

  /**
   * A workflow's `AWS_REGION` or an operator's `AWS_PROFILE` is set before the
   * config loads the parameter. If the parameter won, the override would be
   * accepted on the command line and silently discarded.
   */
  it('leaves an existing value in place', () => {
    process.env.SISYPHUS_TEST_APPLY_A = 'from the shell'

    applyEnvContent('SISYPHUS_TEST_APPLY_A=from the parameter')

    expect(process.env.SISYPHUS_TEST_APPLY_A).toBe('from the shell')
  })

  it('ignores comments and malformed lines', () => {
    applyEnvContent('# SISYPHUS_TEST_APPLY_A=commented\nSISYPHUS_TEST_APPLY_B')

    expect(process.env.SISYPHUS_TEST_APPLY_A).toBeUndefined()
    expect(process.env.SISYPHUS_TEST_APPLY_B).toBeUndefined()
  })
})

describe('fetchGitHubOidcToken', () => {
  const originalToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  const originalUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL

  beforeEach(() => {
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL
  })

  afterEach(() => {
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = originalToken
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = originalUrl
  })

  /**
   * The runner exposes neither variable unless the job asks for the permission,
   * so this is the failure a first deploy actually hits. It must name the fix.
   */
  it('refuses without reaching the network, naming the missing permission', async () => {
    await expect(fetchGitHubOidcToken()).rejects.toThrow('id-token: write')
  })
})
