import { describe, expect, it } from 'vitest'

import { redactPatterns } from './secret-patterns'

/*
 * Every fixture below is synthetic and says so in its own body. They are built
 * to match the *shape* a pattern looks for, which is the only way to test a
 * shape matcher, while being unmistakably not a credential: each one spells
 * out that it is an example and none has ever been issued by anything.
 */

/* cspell:ignore AKIAEXAMPLENOTREAL EXAMPLENOTAREALTOKENVALUE EXAMPLENOTAREALKEYVALUE */
/* cspell:ignore EXAMPLENOTAREALKEY xoxb JEXAMPLE JNOTAREAL SIGNATURENOTREAL */
/* cspell:ignore EXAMPLENOTAREALTOKEN EXAMPLENOTAREALSECRETVALUE EXAMPLENOTAREALVALUE */
/* cspell:ignore EXAMPLENOTAREALPASSWORD */

describe('redactPatterns', () => {
  it('redacts a cloud access key id', () => {
    expect(redactPatterns('key AKIAEXAMPLENOTREAL01 seen')).toBe(
      'key [redacted:aws-access-key-id] seen',
    )
  })

  it('redacts a repository host token', () => {
    expect(redactPatterns('ghp_EXAMPLENOTAREALTOKENVALUE00 used')).toBe(
      '[redacted:repository-host-token] used',
    )
  })

  it('redacts a fine-grained repository host token', () => {
    expect(redactPatterns('github_pat_EXAMPLENOTAREALTOKENVALUE00')).toBe(
      '[redacted:repository-host-token]',
    )
  })

  it('redacts a prefixed api key', () => {
    expect(redactPatterns('sk-ant-EXAMPLENOTAREALKEYVALUE00')).toBe('[redacted:api-key]')
  })

  it('redacts a payment provider key', () => {
    expect(redactPatterns('sk_live_EXAMPLENOTAREALKEY00')).toBe('[redacted:payment-provider-key]')
  })

  it('redacts a cloud api key', () => {
    expect(redactPatterns('AIzaEXAMPLE_NOT_A_REAL_KEY_000000000000')).toBe(
      '[redacted:cloud-api-key]',
    )
  })

  it('redacts a chat platform token', () => {
    expect(redactPatterns('xoxb-EXAMPLE-NOT-A-REAL-TOKEN')).toBe('[redacted:chat-platform-token]')
  })

  it('redacts a json web token', () => {
    expect(redactPatterns('eyJEXAMPLE00.eyJNOTAREAL00.SIGNATURENOTREAL')).toBe(
      '[redacted:json-web-token]',
    )
  })

  it('keeps the header name and drops the bearer value', () => {
    expect(redactPatterns('Authorization: Bearer EXAMPLE-NOT-A-REAL-TOKEN')).toBe(
      'Authorization: Bearer [redacted:authorization-header]',
    )
  })

  it('redacts a bare bearer token', () => {
    expect(redactPatterns('sent Bearer EXAMPLENOTAREALTOKEN00 upstream')).toBe(
      'sent Bearer [redacted:bearer-token] upstream',
    )
  })

  it('redacts credentials embedded in a clone url and keeps the host', () => {
    expect(
      redactPatterns('git clone https://ci-bot:EXAMPLE-NOT-REAL@git.example.test/org/repo.git'),
    ).toBe('git clone https://ci-bot:[redacted:url-credentials]@git.example.test/org/repo.git')
  })

  it('keeps the variable name and drops an assigned secret', () => {
    expect(redactPatterns('AWS_SECRET_ACCESS_KEY=EXAMPLENOTAREALSECRETVALUE')).toBe(
      'AWS_SECRET_ACCESS_KEY=[redacted:assigned-secret]',
    )
  })

  it('handles a quoted assignment in a config dump', () => {
    expect(redactPatterns('  "apiKey": "EXAMPLENOTAREALVALUE",')).toBe(
      '  "apiKey": "[redacted:assigned-secret]",',
    )
  })

  it('handles a yaml-style assignment', () => {
    expect(redactPatterns('password: EXAMPLENOTAREALPASSWORD')).toBe(
      'password: [redacted:assigned-secret]',
    )
  })

  it('leaves ordinary output alone', () => {
    const line = 'Resolving deltas: 100% (300/300), done.'

    expect(redactPatterns(line)).toBe(line)
  })

  it('leaves a non-secret assignment alone', () => {
    const line = 'NODE_ENV=production'

    expect(redactPatterns(line)).toBe(line)
  })

  it('never encodes the length of what it removed', () => {
    const shortAssignment = redactPatterns('TOKEN=aaaaaa')
    const longAssignment = redactPatterns(`TOKEN=${'a'.repeat(400)}`)

    expect(shortAssignment).toBe(longAssignment)
  })

  it('redacts every occurrence on a line', () => {
    const redacted = redactPatterns('first AKIAEXAMPLENOTREAL01 second AKIAEXAMPLENOTREAL02')

    expect(redacted).toBe('first [redacted:aws-access-key-id] second [redacted:aws-access-key-id]')
  })
})
