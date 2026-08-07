import { describe, expect, it } from 'vitest'

import * as profiles from './index'

describe('the execution-profile admin barrel', () => {
  it('exposes the screen, its parts and its pure modules, so nothing imports an internal', () => {
    for (const name of [
      'ProfilesPanel',
      'ProfileCard',
      'ProfileEditor',
      'EMPTY_PROFILE',
      'draftFromProfileVersion',
      'toCreateProfileInput',
      'toUpdateProfileInput',
      'withLockedField',
      'toProfileReadouts',
      'profileVersionReadout',
      'describeEnableRefusal',
      'readEnableFailures',
      'describeProfilePublish',
      'describeProfileEnable',
      'describeProfileError',
    ]) {
      expect(profiles).toHaveProperty(name)
    }
  })

  it('exports no primitive of its own — the panel has one primitive set (FR-033)', () => {
    expect(profiles).not.toHaveProperty('Button')
    expect(profiles).not.toHaveProperty('Field')
    expect(profiles).not.toHaveProperty('LaunchSelect')
  })
})
