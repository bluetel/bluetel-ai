import { describe, expect, it } from 'vitest'

import * as credentialGroups from './index'

describe('the credential-group admin barrel', () => {
  it('exposes both screens, their parts and their pure modules, so nothing imports an internal', () => {
    for (const name of [
      'CredentialGroupsPanel',
      'ProfileCredentialGroupsPanel',
      'CredentialGroupCard',
      'CreateGroupForm',
      'AttachmentRow',
      'AttachmentGateNotice',
      'toCredentialGroupReadouts',
      'deletionBlockersFromCounts',
      'describeDeletionRefusal',
      'readDeletionConditions',
      'DISABLE_ALTERNATIVE',
      'evaluateAttachmentGate',
      'moveAttachment',
      'preferenceReadout',
      'describeAttachmentError',
      'describeCredentialGroupError',
    ]) {
      expect(credentialGroups).toHaveProperty(name)
    }
  })

  it('exports no primitive of its own — the panel has one primitive set (FR-033)', () => {
    expect(credentialGroups).not.toHaveProperty('Button')
    expect(credentialGroups).not.toHaveProperty('Field')
    expect(credentialGroups).not.toHaveProperty('LaunchSelect')
  })
})
