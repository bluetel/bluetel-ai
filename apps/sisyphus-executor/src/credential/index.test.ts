import { describe, expect, it } from 'vitest'

import * as credential from './index'

/**
 * 003/T059. The barrel is the whole public surface of this directory, so it is
 * asserted rather than assumed — and the negative assertion is the interesting
 * one: nothing here may hand out credential material.
 */

describe('the credential barrel', () => {
  it('exports the watch, its default watcher and its debounce', () => {
    expect(typeof credential.watchForRotation).toBe('function')
    expect(typeof credential.watchCredentialFile).toBe('function')
    expect(credential.DEFAULT_ROTATION_DEBOUNCE_MS).toBeGreaterThan(0)
  })

  it('exports nothing but those three values', () => {
    // Types are erased, so this is the whole runtime surface. Keeping it this
    // short is deliberate: a directory that handles credential material should
    // be readable in full before anything is added to it.
    expect(Object.keys(credential).sort()).toStrictEqual([
      'DEFAULT_ROTATION_DEBOUNCE_MS',
      'watchCredentialFile',
      'watchForRotation',
    ])
  })

  it('offers no way to read material out of it', () => {
    // The watch reads the credential file and reports it to the machine surface
    // and nowhere else. A barrel that exported a reader — or a handle that
    // answered with the bytes — would put material one import away from
    // anything in the executor, which is the exposure SC-014 is measured on.
    const readers = Object.keys(credential).filter((name) =>
      /material|read|fetch|secret/iu.test(name),
    )

    expect(readers).toStrictEqual([])
  })
})
