import { describe, expect, it } from 'vitest'

import * as barrel from './index'

/* cspell:ignore AKIA AKIAFIXTUREONLY redactor Wtle */

/**
 * The redaction barrel's surface, as a contract (T198, FR-019, FR-163).
 *
 * Two apps now import this package and neither may reach a module underneath it. The assertions
 * below are equalities rather than `toContain`, so widening the surface is a deliberate edit to
 * this file rather than something that happens as a side effect of adding an export.
 *
 * The second group is the one that earns its place. The control plane's composition root wires
 * `createRedactor()` with **no known values** — it is redacting a customer's ticket, not a run's
 * output, and it has no bundle of installed credentials to hand it. That configuration is therefore
 * the one FR-163 actually runs in, and what it must still remove is asserted here rather than left
 * to the pattern module's own suite, which tests the patterns and not the composition.
 */
describe('the redaction barrel', () => {
  it('exposes exactly the runtime values the standard is composed from', () => {
    // Types erase, so this is the whole runtime surface.
    expect(Object.keys(barrel).sort()).toStrictEqual([
      'MIN_SECRET_LENGTH',
      'PRIVATE_KEY_PLACEHOLDER',
      'SECRET_PATTERNS',
      'buildSecretIndex',
      'createKeyBlockFilter',
      'createRedactor',
      'createStreamingRedactor',
      'redactPatterns',
      'secretEncodings',
      'stripPrivateKeyBlocks',
    ])
  })

  it('exports no way to read a known value back out', () => {
    // A redactor holds every credential a run knows. A helper that listed or rendered them would be
    // a printable copy of all of them, one import away from whatever writes the log.
    for (const forbidden of ['readSecret', 'listSecrets', 'secretValues', 'describeSecrets']) {
      expect(Object.keys(barrel)).not.toContain(forbidden)
    }
  })

  describe('a redactor built with no known values, which is how the control plane wires it', () => {
    // Fabricated throughout: a fixture is never a place for a real token.
    const redactor = barrel.createRedactor()

    it('suppresses a private-key block a reporter pasted into a ticket', () => {
      const output = redactor.redact(
        [
          'The reporter pasted a key into the ticket:',
          '-----BEGIN RSA PRIVATE KEY-----',
          'ZmFrZWtleW1hdGVyaWFsdGhhdGlzbm90YWtleWF0YWxs',
          '-----END RSA PRIVATE KEY-----',
          'please rotate it.',
        ].join('\n'),
      )

      expect(output).not.toContain('BEGIN RSA PRIVATE KEY')
      expect(output).not.toContain('ZmFrZWtleW1hdGVyaWFs')
      expect(output).toContain('please rotate it.')
    })

    it('removes an access-key id, a bearer header and an assigned token', () => {
      const output = redactor.redact(
        [
          'Deploy fails with AKIAFIXTUREONLY00000 in the logs.',
          'curl -H "Authorization: Bearer fixture0token0value0not0real" https://example.invalid/api',
          'The customer left api_token=fixture0token0value0not0real in the description.',
        ].join('\n'),
      )

      expect(output).not.toContain('AKIAFIXTUREONLY00000')
      expect(output).not.toContain('fixture0token0value0not0real')

      // The surrounding text survives, so an over-eager redactor fails this too: a prompt with the
      // task redacted out of it is no more usable than one that was never assembled.
      expect(output).toContain('Deploy fails with')
      expect(output).toContain('https://example.invalid/api')
      expect(output).toContain('in the description.')
    })
  })
})
