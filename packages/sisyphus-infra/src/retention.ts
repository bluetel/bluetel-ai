/**
 * How long each class of durably stored object lives, and what it costs while
 * it lives there.
 *
 * ---------------------------------------------------------------------------
 * Why this is its own module
 * ---------------------------------------------------------------------------
 * Nothing here touches a provider: no SST, no Pulumi, no AWS SDK. A lifecycle
 * rule is plain data, and a mistake in it — a class expiring on another class's
 * schedule, a transition that AWS silently refuses, a versioned archive swept by
 * a rule meant for delete markers — is a **retention defect that no deploy
 * reports**. The bucket that carries the rule is verified by deploying it; the
 * schedule it carries is verified here (FR-200).
 *
 * The same numbers are read twice by design: the lifecycle rule tells S3 when to
 * delete the object, and {@link getObjectExpiresAt} stamps the database row that
 * outlives it. Both come from {@link DEFAULT_RETENTION_DAYS}, so an expired
 * artifact reads as "retained, then expired" rather than as an unexplained
 * absence — see {@link getObjectExpiresAt}.
 */

/** The four classes of object, each with its own bucket and retention schedule. */
export type ObjectClass = 'artifacts' | 'bundles' | 'logs' | 'snapshots'

/** Every class, in a stable order, so a caller can fan out over all of them. */
export const OBJECT_CLASSES: readonly ObjectClass[] = ['artifacts', 'bundles', 'logs', 'snapshots']

/**
 * Every object key begins `workflow/<workflowId>/`, which is what makes FR-071's
 * per-workflow partitioning a property of the key space rather than a naming
 * convention — a lifecycle rule or a bucket policy can be scoped to one workflow.
 */
const WORKFLOW_PARTITION_ROOT = 'workflow'

/**
 * The prefix every lifecycle rule is scoped to, so nothing stored outside the
 * workflow partition is ever expired by one.
 */
export const WORKFLOW_PARTITION_PREFIX = `${WORKFLOW_PARTITION_ROOT}/`

/**
 * The key prefix every object belonging to `workflowId` must sit under.
 * Trailing slash included so it composes directly into a policy resource ARN.
 */
export const getWorkflowObjectPrefix = (workflowId: string): string => {
  if (workflowId.trim() === '') {
    throw new Error('Cannot build a workflow object prefix from an empty workflow id')
  }

  return `${WORKFLOW_PARTITION_PREFIX}${workflowId}/`
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
export const DEFAULT_RETENTION_DAYS: Readonly<Record<ObjectClass, number | null>> = {
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
export const DEFAULT_INFREQUENT_ACCESS_DAYS: Readonly<Record<ObjectClass, number | null>> = {
  artifacts: 30,
  bundles: null,
  logs: 30,
  snapshots: null,
}

/**
 * The classes stored with versioning on. Only bundle archives, and only to make
 * FR-090's immutability recoverable rather than merely asserted.
 */
export const VERSIONED_OBJECT_CLASSES: readonly ObjectClass[] = ['bundles']

export const isVersionedObjectClass = (objectClass: ObjectClass): boolean =>
  VERSIONED_OBJECT_CLASSES.includes(objectClass)

/**
 * Abandoned multipart uploads are billed and invisible, so every class sweeps
 * them. A week is longer than any upload this platform performs.
 */
export const ABORT_INCOMPLETE_MULTIPART_UPLOAD_DAYS = 7

/** The only non-default storage class any object here is ever moved into. */
export type StorageClass = 'STANDARD_IA'

export interface LifecycleTransition {
  readonly days: number
  readonly storageClass: StorageClass
}

export interface LifecycleRule {
  readonly id: string
  /** Scoped to the workflow partition root, so nothing outside it is ever expired. */
  readonly prefix: string
  /** `null` disables expiry for this class. */
  readonly expirationDays: number | null
  /** Storage-class moves applied before expiry, cheapest-correct first. */
  readonly transitions: readonly LifecycleTransition[]
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

export interface RetentionConfig {
  /**
   * Per-class expiry override, in days. `null` disables expiry for that class.
   * Anything not named keeps its {@link DEFAULT_RETENTION_DAYS} value.
   */
  readonly retentionDays?: Partial<Readonly<Record<ObjectClass, number | null>>>
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

/** What a stage actually retains a class for, once overrides are applied. */
export const getRetentionDays = (
  objectClass: ObjectClass,
  config: RetentionConfig = {},
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
 * The storage-class moves for a class, given what that stage retains it for.
 *
 * A transition scheduled at or after expiry would never fire, and AWS rejects
 * the rule outright — so a stage that shortens retention below the transition
 * point silently loses the transition rather than failing to deploy.
 */
export const getLifecycleTransitions = (
  objectClass: ObjectClass,
  config: RetentionConfig = {},
): readonly LifecycleTransition[] => {
  const transitionDays = DEFAULT_INFREQUENT_ACCESS_DAYS[objectClass]

  if (transitionDays === null) {
    return []
  }

  const expirationDays = getRetentionDays(objectClass, config)

  if (expirationDays !== null && transitionDays >= expirationDays) {
    return []
  }

  return [{ days: transitionDays, storageClass: 'STANDARD_IA' }]
}

/**
 * The single lifecycle rule a class's bucket carries.
 *
 * One rule per bucket, with an id naming its class, because a rule id is how a
 * schedule is identified in the console and in a plan diff — two classes sharing
 * an id is how one class silently inherits the other's schedule.
 */
export const buildLifecycleRule = (
  objectClass: ObjectClass,
  config: RetentionConfig = {},
): LifecycleRule => ({
  id: `${objectClass}-expiry`,
  prefix: WORKFLOW_PARTITION_PREFIX,
  expirationDays: getRetentionDays(objectClass, config),
  transitions: getLifecycleTransitions(objectClass, config),
  previousVersionExpirationDays: null,
  cleanExpiredObjectDeleteMarker: isVersionedObjectClass(objectClass),
  abortIncompleteMultipartUploadDays: ABORT_INCOMPLETE_MULTIPART_UPLOAD_DAYS,
})

/**
 * When an object stored at `createdAt` falls out of retention — `null` when its
 * class never expires.
 *
 * ---------------------------------------------------------------------------
 * Why this is derived from the same constant the lifecycle rule reads
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
  objectClass: ObjectClass,
  createdAt: Date,
  config: RetentionConfig = {},
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
