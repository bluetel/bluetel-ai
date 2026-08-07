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
 * the record reads as retention rather than loss. See {@link getObjectExpiresAt}.
 */

import { getResourceIdentifier, type ResourceScope } from './lib'

/** The four classes of object, each with its own bucket and retention schedule. */
export type BucketObjectClass = 'artifacts' | 'bundles' | 'logs' | 'snapshots'

/**
 * Every object key begins `workflow/<workflowId>/`, which is what makes FR-071's
 * per-workflow partitioning a property of the key space rather than a naming
 * convention — a lifecycle rule or a bucket policy can be scoped to one workflow.
 */
const WORKFLOW_PARTITION_ROOT = 'workflow'

/**
 * The key prefix every object belonging to `workflowId` must sit under.
 * Trailing slash included so it composes directly into a policy resource ARN.
 */
export const getWorkflowObjectPrefix = (workflowId: string): string => {
  if (workflowId.trim() === '') {
    throw new Error('Cannot build a workflow object prefix from an empty workflow id')
  }

  return `${WORKFLOW_PARTITION_ROOT}/${workflowId}/`
}

/**
 * Default expiry per object class, in days. `null` means the class never
 * expires.
 *
 * Bundle archives never expire and are versioned, because FR-090 makes them
 * immutable once registered — a workflow that ran two years ago must still be
 * explicable in terms of the exact archive it ran against. Logs outlive the
 * typical audit window, snapshots only need to outlive a resumable run, and
 * artifacts sit between the two.
 */
export const DEFAULT_RETENTION_DAYS: Readonly<Record<BucketObjectClass, number | null>> = {
  artifacts: 365,
  bundles: null,
  logs: 90,
  snapshots: 30,
}

/**
 * Days after creation an object moves to infrequent-access storage, per class.
 * `null` means the class is never transitioned.
 *
 * Logs and artifacts are read heavily for a few days after a run and then only
 * when somebody is explaining that run, so a transition is close to free.
 * Snapshots never transition because they only live thirty days and a resume
 * reads them on the hot path. Bundle archives never transition because every run
 * that references a bundle reads it while bootstrapping, and retrieval charges
 * on that path would be a per-run cost, not an archival one.
 */
export const DEFAULT_INFREQUENT_ACCESS_DAYS: Readonly<Record<BucketObjectClass, number | null>> = {
  artifacts: 30,
  bundles: null,
  logs: 30,
  snapshots: null,
}

/** The only non-default storage class any object here is ever moved into. */
export type BucketStorageClass = 'STANDARD_IA'

export interface BucketLifecycleTransition {
  readonly days: number
  readonly storageClass: BucketStorageClass
}

export interface BucketLifecycleRule {
  readonly id: string
  /** Scoped to the workflow partition root, so nothing outside it is ever expired. */
  readonly prefix: string
  /** `null` disables expiry for this class. */
  readonly expirationDays: number | null
  /** Storage-class moves applied before expiry, cheapest-correct first. */
  readonly transitions: readonly BucketLifecycleTransition[]
  /**
   * Always `null`. Only bundle archives are versioned, and FR-090 makes a
   * superseded archive part of the record of every run that used it — expiring
   * a previous version would make a two-year-old run unexplainable.
   */
  readonly previousVersionExpirationDays: null
  /**
   * Sweeps the delete markers a versioned bucket accumulates. It removes
   * markers, never object versions, so it cannot destroy a retained archive.
   */
  readonly cleanExpiredObjectDeleteMarker: boolean
  readonly abortIncompleteMultipartUploadDays: number
}

export interface BucketSpecification {
  readonly objectClass: BucketObjectClass
  readonly name: string
  /** Always true — no class of object here is ever publicly readable (FR-071). */
  readonly blockPublicAccess: true
  readonly serverSideEncryption: 'AES256'
  /** Only bundle archives are versioned, to make FR-090 immutability recoverable. */
  readonly versioned: boolean
  readonly workflowPartitionRoot: string
  readonly lifecycleRules: readonly BucketLifecycleRule[]
}

export type BucketSpecifications = Readonly<Record<BucketObjectClass, BucketSpecification>>

export interface BucketsConfig {
  readonly scope: ResourceScope
  /**
   * Per-class expiry override, in days. `null` disables expiry for that class.
   * Anything not named keeps its {@link DEFAULT_RETENTION_DAYS} value.
   */
  readonly retentionDays?: Partial<Readonly<Record<BucketObjectClass, number | null>>>
}

const VERSIONED_OBJECT_CLASSES: readonly BucketObjectClass[] = ['bundles']

const ABORT_INCOMPLETE_MULTIPART_UPLOAD_DAYS = 7

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

/** What a stage actually retains a class for, once overrides are applied. */
export const getRetentionDays = (
  objectClass: BucketObjectClass,
  config: Pick<BucketsConfig, 'retentionDays'> = {},
): number | null => {
  const override = config.retentionDays?.[objectClass]
  const expirationDays = override === undefined ? DEFAULT_RETENTION_DAYS[objectClass] : override

  if (expirationDays !== null && expirationDays <= 0) {
    throw new Error(
      `Retention for "${objectClass}" must be a positive number of days or null, received ${String(expirationDays)}`,
    )
  }

  return expirationDays
}

/**
 * When an object stored at `createdAt` falls out of retention — `null` when its
 * class never expires.
 *
 * ---------------------------------------------------------------------------
 * Why this is exported, and why it is derived from the same constant
 * ---------------------------------------------------------------------------
 * An expired artifact must remain **listed, with its expiry**, so that a gap in
 * the record reads as retention rather than as loss. A lifecycle rule can only
 * ever delete the S3 object; the `artifacts` row — and therefore the artifact's
 * kind, its size, when it was made and when it expired — outlives it, and
 * `readArtifacts` selects it unfiltered. That distinction only holds if the
 * `expires_at` stamped on the row is the *same* date the bucket acts on, so the
 * writer stamps the row with this function rather than with a second copy of the
 * schedule. A rule that removed the row along with the object, or a row stamped
 * from a divergent constant, would turn a retained-and-expired artifact back
 * into an unexplained absence.
 */
export const getObjectExpiresAt = (
  objectClass: BucketObjectClass,
  createdAt: Date,
  config: Pick<BucketsConfig, 'retentionDays'> = {},
): Date | null => {
  const retentionDays = getRetentionDays(objectClass, config)

  return retentionDays === null
    ? null
    : new Date(createdAt.getTime() + retentionDays * MILLISECONDS_PER_DAY)
}

/**
 * Whether a recorded expiry has passed. Reading a row whose object is gone is
 * the expected case, not an error — the caller renders "expired on …" instead
 * of a broken link.
 */
export const hasObjectExpired = (expiresAt: Date | null, now: Date): boolean =>
  expiresAt !== null && expiresAt.getTime() <= now.getTime()

const buildLifecycleTransitions = (
  objectClass: BucketObjectClass,
  expirationDays: number | null,
): readonly BucketLifecycleTransition[] => {
  const transitionDays = DEFAULT_INFREQUENT_ACCESS_DAYS[objectClass]

  if (transitionDays === null) {
    return []
  }

  // A transition at or after expiry would never fire, and AWS rejects the rule.
  if (expirationDays !== null && transitionDays >= expirationDays) {
    return []
  }

  return [{ days: transitionDays, storageClass: 'STANDARD_IA' }]
}

const buildBucketSpecification = (
  objectClass: BucketObjectClass,
  config: BucketsConfig,
): BucketSpecification => {
  const expirationDays = getRetentionDays(objectClass, config)
  const versioned = VERSIONED_OBJECT_CLASSES.includes(objectClass)

  return {
    objectClass,
    name: getResourceIdentifier(config.scope, objectClass),
    blockPublicAccess: true,
    serverSideEncryption: 'AES256',
    versioned,
    workflowPartitionRoot: `${WORKFLOW_PARTITION_ROOT}/`,
    lifecycleRules: [
      {
        id: `${objectClass}-expiry`,
        prefix: `${WORKFLOW_PARTITION_ROOT}/`,
        expirationDays,
        transitions: buildLifecycleTransitions(objectClass, expirationDays),
        previousVersionExpirationDays: null,
        cleanExpiredObjectDeleteMarker: versioned,
        abortIncompleteMultipartUploadDays: ABORT_INCOMPLETE_MULTIPART_UPLOAD_DAYS,
      },
    ],
  }
}

/**
 * Pure description of all four buckets. Separated from {@link createBuckets} so
 * the retention and partitioning rules can be asserted without a provider.
 */
export const buildBucketSpecifications = (config: BucketsConfig): BucketSpecifications => ({
  artifacts: buildBucketSpecification('artifacts', config),
  bundles: buildBucketSpecification('bundles', config),
  logs: buildBucketSpecification('logs', config),
  snapshots: buildBucketSpecification('snapshots', config),
})

/**
 * The narrow slice of the SST/Pulumi provider surface this primitive needs.
 * `sst.config.ts` supplies `(name, specification) => new sst.aws.Bucket(...)`.
 */
export interface BucketProvider<TBucket> {
  readonly createBucket: (name: string, specification: BucketSpecification) => TBucket
}

export interface CreatedBucket<TBucket> {
  readonly specification: BucketSpecification
  readonly resource: TBucket
}

export type CreatedBuckets<TBucket> = Readonly<Record<BucketObjectClass, CreatedBucket<TBucket>>>

export const createBuckets = <TBucket>(
  provider: BucketProvider<TBucket>,
  config: BucketsConfig,
): CreatedBuckets<TBucket> => {
  const specifications = buildBucketSpecifications(config)

  const create = (objectClass: BucketObjectClass): CreatedBucket<TBucket> => {
    const specification = specifications[objectClass]

    return { specification, resource: provider.createBucket(specification.name, specification) }
  }

  return {
    artifacts: create('artifacts'),
    bundles: create('bundles'),
    logs: create('logs'),
    snapshots: create('snapshots'),
  }
}
