import { describe, expect, it } from 'vitest'

import {
  ABORT_INCOMPLETE_MULTIPART_UPLOAD_DAYS,
  DEFAULT_INFREQUENT_ACCESS_DAYS,
  DEFAULT_RETENTION_DAYS,
  OBJECT_CLASSES,
  WORKFLOW_PARTITION_PREFIX,
  buildLifecycleRule,
  getLifecycleTransitions,
  getObjectExpiresAt,
  getRetentionDays,
  getWorkflowObjectPrefix,
  hasObjectExpired,
  isVersionedObjectClass,
} from './retention'

describe('OBJECT_CLASSES', () => {
  it('covers the four classes the platform durably stores', () => {
    expect([...OBJECT_CLASSES].sort()).toEqual(['artifacts', 'bundles', 'logs', 'snapshots'])
  })

  it('gives every class a retention and a transition decision, so none defaults by omission', () => {
    for (const objectClass of OBJECT_CLASSES) {
      expect(DEFAULT_RETENTION_DAYS).toHaveProperty(objectClass)
      expect(DEFAULT_INFREQUENT_ACCESS_DAYS).toHaveProperty(objectClass)
    }
  })
})

describe('getWorkflowObjectPrefix', () => {
  it('partitions every object under its workflow', () => {
    expect(getWorkflowObjectPrefix('wf_01H8')).toBe('workflow/wf_01H8/')
  })

  it('ends with a slash so one workflow prefix cannot match another', () => {
    expect(getWorkflowObjectPrefix('wf_1')).not.toBe(getWorkflowObjectPrefix('wf_10').slice(0, -2))
    expect(getWorkflowObjectPrefix('wf_1').endsWith('/')).toBe(true)
  })

  it('refuses an empty workflow id rather than returning the bucket root', () => {
    expect(() => getWorkflowObjectPrefix('')).toThrow('empty workflow id')
    expect(() => getWorkflowObjectPrefix('   ')).toThrow('empty workflow id')
  })

  it('sits under the same partition root every lifecycle rule is scoped to', () => {
    expect(getWorkflowObjectPrefix('wf_01H8').startsWith(WORKFLOW_PARTITION_PREFIX)).toBe(true)
  })
})

describe('getRetentionDays', () => {
  it('reports the default schedule for each class', () => {
    expect(getRetentionDays('artifacts')).toBe(365)
    expect(getRetentionDays('logs')).toBe(90)
    expect(getRetentionDays('snapshots')).toBe(30)
    expect(getRetentionDays('bundles')).toBeNull()
  })

  it('never expires bundle archives, because FR-090 makes them immutable', () => {
    expect(DEFAULT_RETENTION_DAYS.bundles).toBeNull()
    expect(getRetentionDays('bundles')).toBeNull()
  })

  it('honours a per-class override and leaves the other classes alone', () => {
    const config = { retentionDays: { logs: 7 } }

    expect(getRetentionDays('logs', config)).toBe(7)
    expect(getRetentionDays('snapshots', config)).toBe(30)
  })

  it('allows an override to disable expiry entirely', () => {
    expect(getRetentionDays('logs', { retentionDays: { logs: null } })).toBeNull()
  })

  it('refuses a non-positive retention rather than emitting an invalid rule', () => {
    expect(() => getRetentionDays('logs', { retentionDays: { logs: 0 } })).toThrow(
      'must be a positive number of days',
    )
    expect(() => getRetentionDays('logs', { retentionDays: { logs: -1 } })).toThrow(
      'must be a positive number of days',
    )
  })
})

describe('isVersionedObjectClass', () => {
  it('versions bundle archives, so a superseded archive stays recoverable', () => {
    expect(isVersionedObjectClass('bundles')).toBe(true)
  })

  it('leaves the other three classes unversioned', () => {
    expect(isVersionedObjectClass('logs')).toBe(false)
    expect(isVersionedObjectClass('snapshots')).toBe(false)
    expect(isVersionedObjectClass('artifacts')).toBe(false)
  })
})

describe('getLifecycleTransitions', () => {
  it('transitions the two long-lived classes to infrequent access', () => {
    expect(getLifecycleTransitions('artifacts')).toEqual([
      { days: DEFAULT_INFREQUENT_ACCESS_DAYS.artifacts, storageClass: 'STANDARD_IA' },
    ])
    expect(getLifecycleTransitions('logs')).toEqual([
      { days: DEFAULT_INFREQUENT_ACCESS_DAYS.logs, storageClass: 'STANDARD_IA' },
    ])
  })

  it('leaves the hot classes alone — a resume and a bootstrap both read on the hot path', () => {
    expect(getLifecycleTransitions('snapshots')).toEqual([])
    expect(getLifecycleTransitions('bundles')).toEqual([])
  })

  it('drops a transition that expiry would overtake, which AWS would reject', () => {
    expect(getLifecycleTransitions('logs', { retentionDays: { logs: 14 } })).toEqual([])
    expect(getLifecycleTransitions('logs', { retentionDays: { logs: 30 } })).toEqual([])
  })

  it('keeps the transition when the override still leaves room for it', () => {
    expect(getLifecycleTransitions('logs', { retentionDays: { logs: 31 } })).toEqual([
      { days: 30, storageClass: 'STANDARD_IA' },
    ])
  })

  it('moves nothing into a storage class other than infrequent access', () => {
    for (const objectClass of OBJECT_CLASSES) {
      for (const transition of getLifecycleTransitions(objectClass)) {
        expect(transition.storageClass).toBe('STANDARD_IA')
      }
    }
  })
})

describe('buildLifecycleRule', () => {
  it('expires each class on its own schedule', () => {
    expect(buildLifecycleRule('logs').expirationDays).toBe(90)
    expect(buildLifecycleRule('snapshots').expirationDays).toBe(30)
    expect(buildLifecycleRule('artifacts').expirationDays).toBe(365)
    expect(buildLifecycleRule('bundles').expirationDays).toBeNull()
  })

  it('scopes every rule to the workflow partition', () => {
    for (const objectClass of OBJECT_CLASSES) {
      expect(buildLifecycleRule(objectClass).prefix).toBe('workflow/')
    }
  })

  it('gives each class its own rule id, so one class cannot inherit another schedule', () => {
    const ids = OBJECT_CLASSES.map((objectClass) => buildLifecycleRule(objectClass).id)

    expect(ids).toEqual(['artifacts-expiry', 'bundles-expiry', 'logs-expiry', 'snapshots-expiry'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('never expires a previous version, because FR-090 makes superseded archives part of the record', () => {
    for (const objectClass of OBJECT_CLASSES) {
      expect(buildLifecycleRule(objectClass).previousVersionExpirationDays).toBeNull()
    }
  })

  it('sweeps delete markers only where there are versions to accumulate them', () => {
    expect(buildLifecycleRule('bundles').cleanExpiredObjectDeleteMarker).toBe(true)
    expect(buildLifecycleRule('logs').cleanExpiredObjectDeleteMarker).toBe(false)
  })

  it('aborts abandoned multipart uploads on every class', () => {
    for (const objectClass of OBJECT_CLASSES) {
      expect(buildLifecycleRule(objectClass).abortIncompleteMultipartUploadDays).toBe(7)
      expect(buildLifecycleRule(objectClass).abortIncompleteMultipartUploadDays).toBe(
        ABORT_INCOMPLETE_MULTIPART_UPLOAD_DAYS,
      )
    }
  })

  it('carries the transitions the class is entitled to', () => {
    expect(buildLifecycleRule('artifacts').transitions).toEqual([
      { days: 30, storageClass: 'STANDARD_IA' },
    ])
    expect(buildLifecycleRule('snapshots').transitions).toEqual([])
  })

  it('honours a per-class retention override', () => {
    expect(buildLifecycleRule('logs', { retentionDays: { logs: 7 } }).expirationDays).toBe(7)
    expect(buildLifecycleRule('snapshots', { retentionDays: { logs: 7 } }).expirationDays).toBe(30)
  })

  it('allows an override to disable expiry entirely', () => {
    expect(buildLifecycleRule('logs', { retentionDays: { logs: null } }).expirationDays).toBeNull()
  })

  it('drops a transition that a shortened retention would overtake', () => {
    const shortened = buildLifecycleRule('logs', { retentionDays: { logs: 14 } })

    expect(shortened.expirationDays).toBe(14)
    expect(shortened.transitions).toEqual([])
  })

  it('rejects a non-positive retention rather than emitting an invalid rule', () => {
    expect(() => buildLifecycleRule('logs', { retentionDays: { logs: 0 } })).toThrow(
      'must be a positive number of days',
    )
    expect(() => buildLifecycleRule('logs', { retentionDays: { logs: -1 } })).toThrow(
      'must be a positive number of days',
    )
  })
})

describe('getObjectExpiresAt', () => {
  const createdAt = new Date('2026-01-01T00:00:00.000Z')

  it('stamps an artifact with the same date the bucket rule acts on', () => {
    expect(buildLifecycleRule('artifacts').expirationDays).toBe(365)
    expect(getObjectExpiresAt('artifacts', createdAt)).toEqual(new Date('2027-01-01T00:00:00.000Z'))
  })

  it('agrees with the lifecycle rule for every class, so a row cannot outrun its object', () => {
    for (const objectClass of OBJECT_CLASSES) {
      const { expirationDays } = buildLifecycleRule(objectClass)
      const expiresAt = getObjectExpiresAt(objectClass, createdAt)

      if (expirationDays === null) {
        expect(expiresAt).toBeNull()
        continue
      }

      expect(expiresAt?.getTime()).toBe(createdAt.getTime() + expirationDays * 86_400_000)
    }
  })

  it('leaves a bundle archive with no expiry at all', () => {
    expect(getObjectExpiresAt('bundles', createdAt)).toBeNull()
  })

  it('honours the stage override, so a short-retention stage stamps short-retention rows', () => {
    expect(getObjectExpiresAt('logs', createdAt, { retentionDays: { logs: 1 } })).toEqual(
      new Date('2026-01-02T00:00:00.000Z'),
    )
  })
})

describe('hasObjectExpired', () => {
  const expiresAt = new Date('2027-01-01T00:00:00.000Z')

  it('reads an expired artifact as retained-then-expired rather than missing', () => {
    expect(hasObjectExpired(expiresAt, new Date('2027-06-01T00:00:00.000Z'))).toBe(true)
    expect(hasObjectExpired(expiresAt, new Date('2026-06-01T00:00:00.000Z'))).toBe(false)
  })

  it('treats the expiry instant itself as expired', () => {
    expect(hasObjectExpired(expiresAt, expiresAt)).toBe(true)
  })

  it('never reports an object with no expiry as expired', () => {
    expect(hasObjectExpired(null, new Date('2099-01-01T00:00:00.000Z'))).toBe(false)
  })
})
