import { describe, expect, it } from 'vitest'

import * as audit from './index'

describe('the configuration audit barrel', () => {
  it('publishes the screen and the shaping its tests reach for', () => {
    expect(Object.keys(audit).sort()).toStrictEqual([
      'ACTION_LABELS',
      'ACTION_OPTIONS',
      'ACTOR_PARAM',
      'AUDIT_PAGE_SIZE',
      'AuditPanel',
      'ConfigurationFilters',
      'ConfigurationTrailCard',
      'EMPTY_AUDIT_SCOPE',
      'EMPTY_CONFIGURATION_SCOPE',
      'ENTITY_ID_PARAM',
      'ENTITY_TYPE_LABELS',
      'ENTITY_TYPE_OPTIONS',
      'ENTITY_TYPE_PARAM',
      'GrantTrailCard',
      'NO_ACTOR',
      'SUBJECT_PARAM',
      'describeActor',
      'hasConfigurationNarrowing',
      'hasInvalidActor',
      'hasInvalidConfigurationScope',
      'hasInvalidEntityId',
      'hasInvalidSubject',
      'hasSubject',
      'isEntityType',
      'isIdentifier',
      'parseAuditScope',
      'parseConfigurationScope',
      'summariseDetail',
      'toAuditSearchParams',
      'toConfigurationAuditInput',
      'toConfigurationSearchParams',
      'toConfigurationTrailReadouts',
      'toGrantTrailReadouts',
      'toRoleChangesInput',
    ])
  })

  it('publishes both filters, because the screen asks two different questions (FR-178)', () => {
    // The subject narrows the two user-shaped trails; the configuration scope narrows the third.
    // One object with both would have half its fields meaningless to whichever query read it.
    expect(audit.EMPTY_AUDIT_SCOPE).toStrictEqual({ subjectUserId: '' })
    expect(audit.EMPTY_CONFIGURATION_SCOPE).toStrictEqual({
      entityType: '',
      entityId: '',
      actorUserId: '',
    })
  })

  it('re-implements nothing the user and grant screens already own', () => {
    // `RoleChangeHistory` stays in `components/admin/users` and `isLiveGrant` in
    // `components/admin/grants`. A second copy of either would be a second opinion about what an
    // append-only trail looks like, and about when a grant stops being in force.
    for (const owned of [
      'RoleChangeHistory',
      'toRoleChangeReadouts',
      'isLiveGrant',
      'formatTimestamp',
      'LaunchSelect',
      'cn',
    ]) {
      expect(Object.keys(audit)).not.toContain(owned)
    }
  })
})
