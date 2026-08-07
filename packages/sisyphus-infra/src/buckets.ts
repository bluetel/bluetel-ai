/**
 * Object storage for the four classes of object the platform durably stores:
 * agent logs, session snapshots, setup-bundle archives and run artifacts.
 *
 * FR-071 asks for private, encrypted, per-workflow-partitioned storage with a
 * lifecycle policy expiring **each class** on its own schedule — which is why
 * these are four buckets with four lifecycle rules rather than one bucket with
 * four prefixes. A single bucket could not expire snapshots monthly while
 * keeping bundle archives forever.
 *
 * A lifecycle rule here expires **objects**. It never touches the row that
 * describes one: an expired artifact stays listed, with its expiry, so a gap in
 * the record reads as retention rather than loss. See `getObjectExpiresAt`.
 *
 * Every number and every rule below comes from `retention.ts`, which holds the
 * schedules as plain data under direct test, and every name from `lib.ts`. This
 * module decides only which resources carry them, which is a decision the deploy
 * verifies and a unit test could not.
 */

import { getBucketName, type ResourceScope } from './lib'
import {
  buildLifecycleRule,
  isVersionedObjectClass,
  type LifecycleRule,
  type ObjectClass,
  type RetentionConfig,
} from './retention'
import { isDeployStage } from './sst-app'

/**
 * The encryption every bucket applies by default. Exported because the executor's
 * release upload names it on the object it writes, and an object written with a
 * different algorithm than the bucket's default is the one way to get an
 * unencrypted object into an encrypted bucket.
 */
export const BUCKET_SERVER_SIDE_ENCRYPTION = 'AES256'

export interface BucketsConfig extends RetentionConfig {
  readonly scope: ResourceScope
}

/** The four buckets, keyed by the class of object each holds. */
export type Buckets = Readonly<Record<ObjectClass, aws.s3.BucketV2>>

/**
 * Translates one schedule from `retention.ts` into the provider's lifecycle
 * shape.
 *
 * A class that never expires still sweeps its delete markers where it has
 * versions to accumulate them. AWS rejects a rule carrying both an expiry and a
 * delete-marker sweep, which is why these two are exclusive rather than
 * combined.
 */
const toLifecycleRule = (
  rule: LifecycleRule,
): aws.types.input.s3.BucketLifecycleConfigurationV2Rule => ({
  id: rule.id,
  status: 'Enabled',
  filter: { prefix: rule.prefix },
  expiration:
    rule.expirationDays !== null
      ? { days: rule.expirationDays }
      : rule.cleanExpiredObjectDeleteMarker
        ? { expiredObjectDeleteMarker: true }
        : undefined,
  transitions: rule.transitions.map((transition) => ({
    days: transition.days,
    storageClass: transition.storageClass,
  })),
  abortIncompleteMultipartUpload: {
    daysAfterInitiation: rule.abortIncompleteMultipartUploadDays,
  },
})

const createBucket = (config: BucketsConfig, objectClass: ObjectClass): aws.s3.BucketV2 => {
  const name = getBucketName(config.scope, objectClass)

  const bucket = new aws.s3.BucketV2(name, {
    bucket: name,
    // A deploy stage keeps its objects; a personal stage must be destroyable, or
    // it is a stage nobody deletes.
    forceDestroy: !isDeployStage(config.scope.stack),
  })

  // No class of object here is ever publicly readable (FR-071).
  new aws.s3.BucketPublicAccessBlock(`${name}-public-access-block`, {
    bucket: bucket.bucket,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
  })

  new aws.s3.BucketServerSideEncryptionConfigurationV2(`${name}-encryption`, {
    bucket: bucket.bucket,
    rules: [
      {
        applyServerSideEncryptionByDefault: { sseAlgorithm: BUCKET_SERVER_SIDE_ENCRYPTION },
      },
    ],
  })

  // Only bundle archives are versioned, to make FR-090's immutability
  // recoverable rather than merely asserted.
  new aws.s3.BucketVersioningV2(`${name}-versioning`, {
    bucket: bucket.bucket,
    versioningConfiguration: {
      status: isVersionedObjectClass(objectClass) ? 'Enabled' : 'Suspended',
    },
  })

  // The retention schedule is never restated here: the rule comes from
  // `buildLifecycleRule`, which is also what stamps an artifact row's
  // `expires_at`, so the record and the bucket cannot drift apart.
  new aws.s3.BucketLifecycleConfigurationV2(`${name}-lifecycle`, {
    bucket: bucket.bucket,
    rules: [toLifecycleRule(buildLifecycleRule(objectClass, config))],
  })

  return bucket
}

/**
 * Creates all four buckets for a stage. Exactly one stack calls this — the
 * panel's — and the other two derive the same names from {@link getBucketName}
 * without declaring a bucket of their own.
 */
export const createBuckets = (config: BucketsConfig): Buckets => ({
  artifacts: createBucket(config, 'artifacts'),
  bundles: createBucket(config, 'bundles'),
  logs: createBucket(config, 'logs'),
  snapshots: createBucket(config, 'snapshots'),
})
