import { describe, expect, it } from 'vitest'

import * as barrel from './index'

/**
 * The output barrel's surface, as a contract (003/T128, Constitution Principle II).
 *
 * Every other directory this feature touched already had one of these; this one did not, and it is
 * the barrel where its absence mattered most. Two of the things exported here — the agent
 * credential's known-secret shape and the secret registry — exist because 003/FR-014 routes the
 * agent's own login through the *existing* redaction pipeline as a known value. What a barrel
 * exports decides whether that stays true: a consumer that could reach `secret-values.ts`'s
 * internals, or assemble a redactor without a registry behind it, would be a consumer that could
 * write a log segment the pipeline never saw.
 *
 * The assertions are equalities rather than `toContain`, so widening this surface is a deliberate
 * edit to this file rather than something that happens as a side effect of adding an export.
 */
describe('the output barrel', () => {
  it('exports the agent credential as a known value, and no way to read one back', () => {
    // 003/FR-014's mechanism. `agentCredentialSecret` wraps material in the shape the redactor
    // takes; there is deliberately nothing here that returns material, lists registered secrets, or
    // renders a registry's contents — a debugging helper of that kind would be a printable copy of
    // every secret on the instance, one import from the log writer.
    expect(typeof barrel.agentCredentialSecret).toBe('function')
    expect(barrel.AGENT_CREDENTIAL_SECRET_NAME).toBe('agent-credential')

    for (const forbidden of [
      'readSecret',
      'listSecrets',
      'secretValues',
      'describeSecrets',
      'dumpSecretRegistry',
    ]) {
      expect(Object.keys(barrel)).not.toContain(forbidden)
    }
  })

  it('exports the registry as a constructor and never as state', () => {
    // A module-level registry would be shared by every writer in the process and would outlive the
    // run that registered into it. `createSecretRegistry` is a factory for the same reason every
    // other seam in this codebase is one.
    expect(typeof barrel.createSecretRegistry).toBe('function')
    expect(Object.keys(barrel)).not.toContain('secretRegistry')
  })

  it('exposes exactly the runtime values the pipeline is composed from', () => {
    // Types erase, so this is the whole runtime surface.
    expect(Object.keys(barrel).sort()).toStrictEqual([
      'AGENT_CREDENTIAL_SECRET_NAME',
      'DEFAULT_RETAINED_ROWS',
      'EMPTY_SANITISED_TEXT',
      'MIN_SECRET_LENGTH',
      'PRIVATE_KEY_PLACEHOLDER',
      'SECRET_PATTERNS',
      'agentCredentialSecret',
      'buildSecretIndex',
      // The values a client's setup bundle installed, which the run registers at phase 5 (T239).
      'bundleCredentialSecrets',
      'createControlStripper',
      'createKeyBlockFilter',
      'createRedactor',
      'createSanitiser',
      'createScreenBuffer',
      'createSecretRegistry',
      'createSegmentWriter',
      'createStreamingRedactor',
      'createTokenBucket',
      'isSpinnerOnlyLine',
      'redactPatterns',
      'sanitise',
      'sanitisedByteLength',
      'scanControlTokens',
      'secretEncodings',
      'stripControlSequences',
      'stripLeadingSpinnerGlyph',
      'stripPrivateKeyBlocks',
    ])
  })
})
