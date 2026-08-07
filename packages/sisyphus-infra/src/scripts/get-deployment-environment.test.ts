import { describe, expect, it } from 'vitest'

import { DEPLOYABLE_KEYS, getEnvParameterName, parseEnvContent } from './get-deployment-environment'

describe('getEnvParameterName', () => {
  it('builds the path from the plain stage', () => {
    expect(getEnvParameterName('admin', 'production')).toBe('/sisyphus/production/admin/env')
  })

  /**
   * The bootstrap runs on `<stage>-bootstrap` and the application deploy on the
   * plain stage. Both must land on one entry, or the bootstrap populates
   * configuration the deploy never reads.
   */
  it.each(DEPLOYABLE_KEYS)('resolves every stage suffix to one entry for %s', (deployable) => {
    const plain = getEnvParameterName(deployable, 'production')

    expect(getEnvParameterName(deployable, 'production-bootstrap')).toBe(plain)
    expect(getEnvParameterName(deployable, 'production-website')).toBe(plain)
  })

  it('keeps deployables and stages apart', () => {
    expect(getEnvParameterName('admin', 'staging')).not.toBe(
      getEnvParameterName('control-plane', 'staging'),
    )
    expect(getEnvParameterName('admin', 'staging')).not.toBe(
      getEnvParameterName('admin', 'production'),
    )
  })
})

describe('parseEnvContent', () => {
  it('reads key/value pairs', () => {
    expect(parseEnvContent('A=1\nB=two')).toEqual({ A: '1', B: 'two' })
  })

  it('ignores blank lines and comments', () => {
    expect(parseEnvContent('\n# a comment\nA=1\n\n   \n#B=2\n')).toEqual({ A: '1' })
  })

  it('ignores lines with no separator and lines with an empty key', () => {
    expect(parseEnvContent('NOT_A_PAIR\n=orphan\nA=1')).toEqual({ A: '1' })
  })

  /**
   * The two values most likely to contain `=` are a connection URL and a base64
   * secret, and a split-on-every-`=` truncates both without complaint.
   */
  it('splits on the first separator only', () => {
    expect(
      parseEnvContent('DATABASE_URL=postgres://u:p@h/db?ssl=require\nSECRET=YWJjZA=='),
    ).toEqual({
      DATABASE_URL: 'postgres://u:p@h/db?ssl=require',
      SECRET: 'YWJjZA==',
    })
  })

  it('strips a matched pair of surrounding quotes', () => {
    expect(parseEnvContent(`A="one two"\nB='three'\nC=four`)).toEqual({
      A: 'one two',
      B: 'three',
      C: 'four',
    })
  })

  it('leaves an unmatched quote alone', () => {
    expect(parseEnvContent(`A="one\nB=two"`)).toEqual({ A: '"one', B: 'two"' })
  })

  it('accepts an empty value without inventing one', () => {
    expect(parseEnvContent('A=')).toEqual({ A: '' })
  })

  it('answers an empty record for empty content', () => {
    expect(parseEnvContent('')).toEqual({})
  })
})
