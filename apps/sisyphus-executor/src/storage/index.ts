/**
 * Object storage — the real implementations behind the three store interfaces the run depends on
 * (T173).
 *
 * Consumers import from here and never from the modules behind it. What the barrel is holding in
 * place: `client.ts` is the **only** file in the executor that names `S3Client`, so every module
 * above it is exercised against an `S3Operations` fake rather than against a bucket, and the
 * stores in `stores.ts` keep their three distinct failure codes instead of collapsing into one
 * generic storage error the callers could not act on differently.
 */

export { createS3Operations } from './client'
export type { ObjectLocation, S3Operations, S3OperationsOptions } from './client'

export { createS3BundleArchiveStore, createS3SegmentStore, createS3SnapshotStore } from './stores'
export type { BucketBackedStoreOptions } from './stores'
