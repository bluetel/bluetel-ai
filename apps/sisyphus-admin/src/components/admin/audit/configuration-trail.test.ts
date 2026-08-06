import { describe, expect, it } from 'vitest'

import type { ConfigurationAuditEntry } from './configuration-trail'
import { describeActor, summariseDetail, toConfigurationTrailReadouts } from './configuration-trail'
import { NO_ACTOR } from './grant-trail'

/**
 * Shaping one row of FR-178's trail.
 *
 * The assertions that carry their weight are about *not inventing things*: the timestamp is the
 * screen's one format, the absent-value readout is the screen's one em dash, and a
 * platform-initiated change stays visibly platform-initiated rather than being dressed up with a
 * name.
 */

const entry = (over: Partial<ConfigurationAuditEntry> = {}): ConfigurationAuditEntry =>
  ({
    id: '0199a1f4-0000-7000-8000-000000000001',
    entityType: 'setup_bundle',
    entityId: '0199a1f4-0000-7000-8000-0000000000bb',
    entityVersion: 3,
    action: 'replaced',
    detail: { digest: 'sha256:abc', sizeBytes: 4096 },
    createdAt: new Date('2026-08-05T09:14:22.031Z'),
    actorUserId: '0199a1f4-0000-7000-8000-0000000000ef',
    actorEmail: 'ada@example.test',
    actorDisplayName: 'Ada Lovelace',
    ...over,
  }) as ConfigurationAuditEntry

describe('toConfigurationTrailReadouts', () => {
  it('reads the entity and the action in the operator’s words', () => {
    const readouts = toConfigurationTrailReadouts(entry())

    expect(readouts.entity).toBe('setup bundle')
    expect(readouts.action).toBe('replaced')
  })

  it('uses the screen’s one timestamp format, not a second one', () => {
    // `formatTimestamp`, imported rather than reimplemented: a private slice here would be a row
    // whose clock disagreed with the row above it.
    expect(toConfigurationTrailReadouts(entry()).at).toBe('2026-08-05 09:14')
  })

  it('shows the version where the entity is versioned, and the absent readout where it is not', () => {
    expect(toConfigurationTrailReadouts(entry()).version).toBe('3')
    expect(toConfigurationTrailReadouts(entry({ entityVersion: null })).version).toBe(NO_ACTOR)
  })

  it('keeps the entity id, because that is what an admin follows the trail with', () => {
    expect(toConfigurationTrailReadouts(entry()).entityId).toBe(
      '0199a1f4-0000-7000-8000-0000000000bb',
    )
  })
})

describe('describeActor', () => {
  it('names the admin where the join found one', () => {
    expect(describeActor(entry())).toBe('Ada Lovelace')
  })

  it('falls back to the id, which is what the user list is searched with', () => {
    expect(describeActor(entry({ actorDisplayName: null }))).toBe(
      '0199a1f4-0000-7000-8000-0000000000ef',
    )
  })

  it('reads a platform-initiated change as no actor, using the screen’s one em dash (FR-174)', () => {
    // Not "system": nothing signed in, and naming it would make the trail claim a person acted.
    expect(describeActor(entry({ actorUserId: null, actorDisplayName: null }))).toBe(NO_ACTOR)
  })
})

describe('summariseDetail', () => {
  it('lists the recorded keys, so a reader can tell whether the entry is worth opening', () => {
    expect(summariseDetail({ digest: 'sha256:abc', sizeBytes: 4096 })).toBe('digest, sizeBytes')
  })

  it('reads nothing recorded as the absent readout rather than as an empty cell', () => {
    expect(summariseDetail(null)).toBe(NO_ACTOR)
    expect(summariseDetail({})).toBe(NO_ACTOR)
    expect(summariseDetail(undefined)).toBe(NO_ACTOR)
  })

  it('does not treat an array or a scalar as an object with keys', () => {
    expect(summariseDetail([1, 2, 3])).toBe(NO_ACTOR)
    expect(summariseDetail('sha256:abc')).toBe(NO_ACTOR)
  })

  it('does not expand the value, only the keys', () => {
    // A row that expands to twelve lines is a row nobody scans past.
    expect(summariseDetail({ credential: 'arn:aws:secret' })).not.toContain('arn:aws:secret')
  })
})
