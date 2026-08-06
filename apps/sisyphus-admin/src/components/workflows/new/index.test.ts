import { describe, expect, it } from 'vitest'

import * as launch from './index'

describe('the launch barrel', () => {
  it('exposes the screen, its parts and its pure modules, so nothing imports an internal', () => {
    for (const name of [
      'AdHocLaunchForm',
      'LaunchPanel',
      'ProfileLaunchForm',
      'ProfileLaunchFields',
      'LockedValue',
      'JobSpecFields',
      'WorkspaceSourceFields',
      'LaunchSelect',
      'PromptField',
      'EMPTY_LAUNCH_FORM',
      'toStartAdHocInput',
      'toStartWorkflowInput',
      'prefillFromProfile',
      'describeLaunchFieldLocks',
      'lockedFieldRefusals',
      'describeLaunch',
      'describeLaunchError',
      'describeProfileLaunch',
      'describeProfileLaunchError',
    ]) {
      expect(launch).toHaveProperty(name)
    }
  })

  it('exports no primitive of its own — the panel has one primitive set (FR-033)', () => {
    // `LaunchSelect` and `PromptField` fill the two gaps in that set by composing
    // `fieldControlVariants` rather than restating it, and are named here so the day they move
    // into `src/components/ui` is a deletion rather than a rewrite.
    expect(launch).not.toHaveProperty('Button')
    expect(launch).not.toHaveProperty('Field')
    expect(launch).not.toHaveProperty('Card')
  })
})
