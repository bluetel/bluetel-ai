/* cspell:words netrc */
import { buildSecretIndex } from '@bluetel-ai/sisyphus-redaction'
import { describe, expect, it } from 'vitest'

import {
  bundleCredentialSecrets,
  bundleCredentialValues,
  bundleSecretName,
  MAX_BUNDLE_VALUES_PER_FILE,
} from './bundle-secrets'

/**
 * T239. Two things are under test and they pull in opposite directions:
 *
 * - **every shape a bundle plausibly writes its credentials in yields the credential**, because a
 *   value this module misses is a value the log is protected from by pattern matching alone; and
 * - **the tokens those formats are built from are not registered**, because a registry holding
 *   `github.com` or `password` removes them from every line of the run's own output.
 *
 * The value below is synthetic and belongs to nothing. It is deliberately free of any format
 * `secret-patterns.ts` recognises — no `ghp_`, no `sk-`, no JWT — so that a test which passes is
 * evidence about *this* mechanism rather than about the pattern stage standing in for it.
 */
const PLANTED = 'Zq7-K2mv9RtL4xPw8Nc3'

describe('bundleSecretName', () => {
  it('names the file the value came from, in a form the placeholder keeps', () => {
    expect(bundleSecretName('forge-token')).toBe('bundle.forge-token')
    expect(bundleSecretName('acme/registry/npmrc')).toBe('bundle.acme.registry.npmrc')
  })

  it('folds anything the placeholder would otherwise refuse', () => {
    // `secret-values.ts` degrades a non-conforming name to the neutral `credential` label, which
    // loses the one piece of information the placeholder carries.
    expect(bundleSecretName('forge (copy)/token')).toBe('bundle.forge.copy.token')
    expect(bundleSecretName('///')).toBe('bundle')
  })
})

describe('bundleCredentialValues', () => {
  it('reads a file whose whole content is the token', () => {
    expect(bundleCredentialValues(`${PLANTED}\n`)).toStrictEqual([PLANTED])
  })

  it('reads the right-hand side of an assignment', () => {
    expect(bundleCredentialValues(`export FORGE_TOKEN=${PLANTED}\n`)).toContain(PLANTED)
    expect(bundleCredentialValues(`forge_token: "${PLANTED}"\n`)).toContain(PLANTED)
  })

  it('reads past a scheme the value is introduced by', () => {
    expect(bundleCredentialValues(`Authorization: Bearer ${PLANTED}\n`)).toContain(PLANTED)
  })

  it('reads a .netrc, where the credential follows its field name', () => {
    expect(
      bundleCredentialValues(`machine github.com login sisyphus password ${PLANTED}\n`),
    ).toContain(PLANTED)
  })

  it('reads a JSON value, unescaped, and never a JSON key', () => {
    const values = bundleCredentialValues(
      `{ "access_token": "${PLANTED}", "host": "github.com" }\n`,
    )

    expect(values).toContain(PLANTED)
    expect(values).not.toContain('access_token')
  })

  it('unescapes a JSON value, so what is registered is what exists', () => {
    // `secret-encodings.ts` derives the escaped form back from the value; registering the escaped
    // text instead would know the form in the file and not the form the credential is used in.
    expect(bundleCredentialValues('{ "token": "Zq7\\/K2mv9RtL4xPw8Nc3" }')).toStrictEqual([
      'Zq7/K2mv9RtL4xPw8Nc3',
    ])
  })

  it('reads the password out of a rewritten remote', () => {
    expect(bundleCredentialValues(`https://sisyphus:${PLANTED}@github.com\n`)).toContain(PLANTED)
  })

  it('reads a percent-encoded userinfo password in both the forms it can appear in', () => {
    const values = bundleCredentialValues('https://sisyphus:Zq7%2FK2mv9RtL4xPw@github.com\n')

    expect(values).toContain('Zq7/K2mv9RtL4xPw')
    expect(values).toContain('Zq7%2FK2mv9RtL4xPw')
  })

  it('registers none of the structure the formats are built from', () => {
    const values = bundleCredentialValues(
      [
        '# the bundle wrote this',
        '[credential "https://github.com"]',
        '\thelper = store',
        '\tusername = sisyphus',
        'machine github.com login sisyphus',
        'url=https://github.com/acme/app.git',
        'helper_path=/usr/local/bin/forge-helper',
        '--------------------',
      ].join('\n'),
    )

    expect(values).toStrictEqual([])
  })

  it('is bounded, because every value is expanded into every encoding it can take', () => {
    const many = Array.from(
      { length: MAX_BUNDLE_VALUES_PER_FILE * 2 },
      (_unused, index) => `token=Zq7-K2mv9RtL4xPw${String(index).padStart(4, '0')}`,
    ).join('\n')

    expect(bundleCredentialValues(many)).toHaveLength(MAX_BUNDLE_VALUES_PER_FILE)
  })

  it('finds nothing in a file that holds nothing', () => {
    expect(bundleCredentialValues('')).toStrictEqual([])
    expect(bundleCredentialValues('\n\n# only a comment\n')).toStrictEqual([])
  })
})

describe('bundleCredentialSecrets', () => {
  it('names every value after the file it was installed in', () => {
    expect(
      bundleCredentialSecrets({ relativePath: 'forge-token', text: `${PLANTED}\n` }),
    ).toStrictEqual([{ name: 'bundle.forge-token', value: PLANTED }])
  })

  /**
   * The seam that matters: what this module produces has to be removed by the index the run
   * actually uses, in the encodings a credential reaches a log in. Asserted here rather than left
   * to the two suites either side of it.
   */
  it('produces values the run’s own index removes, in encodings other than the verbatim one', () => {
    const index = buildSecretIndex(
      bundleCredentialSecrets({ relativePath: 'forge-token', text: `${PLANTED}\n` }),
    )

    expect(index.redact(`cloning with ${PLANTED} failed`)).toBe(
      'cloning with [redacted:bundle.forge-token] failed',
    )
    expect(index.redact(JSON.stringify({ header: `Bearer ${PLANTED}` }))).not.toContain(PLANTED)
    expect(index.redact(encodeURIComponent(PLANTED))).toBe('[redacted:bundle.forge-token]')
  })
})
