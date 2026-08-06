import { describe, expect, it } from 'vitest'

import {
  DEFAULT_INFREQUENT_ACCESS_DAYS,
  DEFAULT_RETENTION_DAYS,
  buildBucketSpecifications,
  createBuckets,
  getObjectExpiresAt,
  getRetentionDays,
  getWorkflowObjectPrefix,
  hasObjectExpired,
  type BucketObjectClass,
  type BucketSpecification,
} from './buckets'

const scope = { project: 'sisyphus', stack: 'staging' }

const objectClasses: readonly BucketObjectClass[] = ['artifacts', 'bundles', 'logs', 'snapshots']

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
})

describe('buildBucketSpecifications', () => {
  const specifications = buildBucketSpecifications({ scope })

  it('describes one bucket per object class', () => {
    expect(Object.keys(specifications).sort()).toEqual([...objectClasses])
  })

  it('names each bucket under the stage-scoped identifier', () => {
    expect(specifications.logs.name).toBe('sisyphus-staging-logs')
    expect(specifications.snapshots.name).toBe('sisyphus-staging-snapshots')
  })

  it('makes every bucket private and encrypted', () => {
    for (const objectClass of objectClasses) {
      const specification: BucketSpecification = specifications[objectClass]

      expect(specification.blockPublicAccess).toBe(true)
      expect(specification.serverSideEncryption).toBe('AES256')
    }
  })

  it('scopes every lifecycle rule to the workflow partition', () => {
    for (const objectClass of objectClasses) {
      expect(specifications[objectClass].lifecycleRules).toHaveLength(1)

      for (const rule of specifications[objectClass].lifecycleRules) {
        expect(rule.prefix).toBe('workflow/')
      }
    }
  })

  it('gives each class its own rule id, so one class cannot inherit another schedule', () => {
    const ids = objectClasses.flatMap((objectClass) =>
      specifications[objectClass].lifecycleRules.map((rule) => rule.id),
    )

    expect(ids).toEqual(['artifacts-expiry', 'bundles-expiry', 'logs-expiry', 'snapshots-expiry'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('transitions the two long-lived classes to infrequent access and leaves the hot ones alone', () => {
    expect(specifications.artifacts.lifecycleRules[0]?.transitions).toEqual([
      { days: DEFAULT_INFREQUENT_ACCESS_DAYS.artifacts, storageClass: 'STANDARD_IA' },
    ])
    expect(specifications.logs.lifecycleRules[0]?.transitions).toEqual([
      { days: DEFAULT_INFREQUENT_ACCESS_DAYS.logs, storageClass: 'STANDARD_IA' },
    ])
    expect(specifications.snapshots.lifecycleRules[0]?.transitions).toEqual([])
    expect(specifications.bundles.lifecycleRules[0]?.transitions).toEqual([])
  })

  it('drops a transition that expiry would overtake, which AWS would reject', () => {
    const shortened = buildBucketSpecifications({ scope, retentionDays: { logs: 14 } })

    expect(shortened.logs.lifecycleRules[0]?.expirationDays).toBe(14)
    expect(shortened.logs.lifecycleRules[0]?.transitions).toEqual([])
  })

  it('never expires a previous version, because FR-090 makes superseded archives part of the record', () => {
    for (const objectClass of objectClasses) {
      for (const rule of specifications[objectClass].lifecycleRules) {
        expect(rule.previousVersionExpirationDays).toBeNull()
      }
    }
  })

  it('sweeps delete markers only where there are versions to accumulate them', () => {
    expect(specifications.bundles.lifecycleRules[0]?.cleanExpiredObjectDeleteMarker).toBe(true)
    expect(specifications.logs.lifecycleRules[0]?.cleanExpiredObjectDeleteMarker).toBe(false)
  })

  it('aborts abandoned multipart uploads on every class', () => {
    for (const objectClass of objectClasses) {
      expect(
        specifications[objectClass].lifecycleRules[0]?.abortIncompleteMultipartUploadDays,
      ).toBe(7)
    }
  })

  it('expires each class on its own schedule', () => {
    expect(specifications.logs.lifecycleRules[0]?.expirationDays).toBe(90)
    expect(specifications.snapshots.lifecycleRules[0]?.expirationDays).toBe(30)
    expect(specifications.artifacts.lifecycleRules[0]?.expirationDays).toBe(365)
  })

  it('never expires bundle archives and versions them, because FR-090 makes them immutable', () => {
    expect(DEFAULT_RETENTION_DAYS.bundles).toBeNull()
    expect(specifications.bundles.lifecycleRules[0]?.expirationDays).toBeNull()
    expect(specifications.bundles.versioned).toBe(true)
  })

  it('leaves the other three classes unversioned', () => {
    expect(specifications.logs.versioned).toBe(false)
    expect(specifications.snapshots.versioned).toBe(false)
    expect(specifications.artifacts.versioned).toBe(false)
  })

  it('honours a per-class retention override', () => {
    const overridden = buildBucketSpecifications({ scope, retentionDays: { logs: 7 } })

    expect(overridden.logs.lifecycleRules[0]?.expirationDays).toBe(7)
    expect(overridden.snapshots.lifecycleRules[0]?.expirationDays).toBe(30)
  })

  it('allows an override to disable expiry entirely', () => {
    const overridden = buildBucketSpecifications({ scope, retentionDays: { logs: null } })

    expect(overridden.logs.lifecycleRules[0]?.expirationDays).toBeNull()
  })

  it('rejects a non-positive retention rather than emitting an invalid rule', () => {
    expect(() => buildBucketSpecifications({ scope, retentionDays: { logs: 0 } })).toThrow(
      'must be a positive number of days',
    )
    expect(() => buildBucketSpecifications({ scope, retentionDays: { logs: -1 } })).toThrow(
      'must be a positive number of days',
    )
  })
})

describe('createBuckets', () => {
  it('creates one resource per object class through the supplied provider', () => {
    const created: { name: string; objectClass: BucketObjectClass }[] = []

    const buckets = createBuckets(
      {
        createBucket: (name, specification) => {
          created.push({ name, objectClass: specification.objectClass })

          return { id: name }
        },
      },
      { scope },
    )

    expect(created.map((entry) => entry.objectClass).sort()).toEqual([...objectClasses])
    expect(buckets.logs.resource).toEqual({ id: 'sisyphus-staging-logs' })
    expect(buckets.logs.specification.objectClass).toBe('logs')
  })

  it('passes the resource name and the specification consistently', () => {
    createBuckets(
      {
        createBucket: (name, specification) => {
          expect(name).toBe(specification.name)

          return null
        },
      },
      { scope },
    )
  })
})

describe('getRetentionDays', () => {
  it('reports the default schedule for each class', () => {
    expect(getRetentionDays('artifacts')).toBe(365)
    expect(getRetentionDays('logs')).toBe(90)
    expect(getRetentionDays('snapshots')).toBe(30)
    expect(getRetentionDays('bundles')).toBeNull()
  })

  it('applies the same overrides the buckets are built with', () => {
    expect(getRetentionDays('logs', { retentionDays: { logs: 7 } })).toBe(7)
  })

  it('refuses a non-positive retention', () => {
    expect(() => getRetentionDays('logs', { retentionDays: { logs: 0 } })).toThrow(
      'must be a positive number of days',
    )
  })
})

describe('getObjectExpiresAt', () => {
  const createdAt = new Date('2026-01-01T00:00:00.000Z')

  it('stamps an artifact with the same date the bucket rule acts on', () => {
    const expiresAt = getObjectExpiresAt('artifacts', createdAt)
    const rule = buildBucketSpecifications({ scope }).artifacts.lifecycleRules[0]

    expect(rule.expirationDays).toBe(365)
    expect(expiresAt).toEqual(new Date('2027-01-01T00:00:00.000Z'))
  })

  it('agrees with the lifecycle rule for every class, so a row cannot outrun its object', () => {
    const specifications = buildBucketSpecifications({ scope })

    for (const objectClass of objectClasses) {
      const expirationDays = specifications[objectClass].lifecycleRules[0]?.expirationDays ?? null
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
