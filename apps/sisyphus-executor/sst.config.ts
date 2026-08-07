/**
 * SST deployment for the executor.
 *
 * The executor is not a service. It is the program an instance runs, so what
 * deploys is the **release**: the built bundle, published at a content-addressed
 * key, plus the parameter that says which key is current. An instance's user
 * data reads the parameter and fetches the object; nothing here launches an
 * instance, because launching is the control plane's job (FR-038).
 *
 * ---------------------------------------------------------------------------
 * Two things this config deliberately does not create
 * ---------------------------------------------------------------------------
 * **No bucket.** The panel's stack owns all four. This config derives their
 * names from the same `buildBucketSpecifications` the panel builds them with, so
 * the two stacks cannot disagree about a name or a retention schedule.
 *
 * **No runner role.** `createRunnerRole` scopes every S3 grant to one workflow's
 * partition, which is what stops one run reading another's logs (FR-071). A
 * role created at deploy time could only be scoped to every workflow at once, so
 * the role is created per launch by the control plane instead.
 *
 * The release lives in the bundles bucket under `releases/`, outside the
 * `workflow/` prefix every lifecycle rule is scoped to. That is not a
 * convenience: it means no expiry rule can reach a release, and the bucket that
 * holds it is the one bucket that is versioned and never expires — the same
 * properties an immutable release wants (FR-090).
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import {
  DEFAULT_AWS_REGION,
  buildBucketSpecifications,
  buildSstApp,
  getStackScope,
  type SstAppInput,
  type SstConfigDefinition,
  // The package barrel — never a module inside it.
} from '@bluetel-ai/sisyphus-infra'

/**
 * The slice of SST's generated globals this config uses, declared at module
 * scope. `.sst/platform/config.d.ts` only exists after `sst install` and is
 * git-ignored, so declaring them here is what keeps the file checkable in CI.
 */
interface PulumiOutput<TValue> {
  readonly apply: <TResult>(transform: (value: TValue) => TResult) => PulumiOutput<TResult>
}

declare const $config: <TOutputs>(
  definition: SstConfigDefinition<TOutputs>,
) => SstConfigDefinition<TOutputs>

declare const $app: { readonly name: string; readonly stage: string }

declare const aws: {
  readonly s3: {
    readonly BucketObject: new (
      name: string,
      args: {
        readonly bucket: string
        readonly key: string
        readonly source: string
        readonly contentType: string
        readonly serverSideEncryption: string
      },
    ) => { readonly key: PulumiOutput<string> }
  }
  readonly ssm: {
    readonly Parameter: new (
      name: string,
      args: {
        readonly name: string
        readonly type: string
        readonly value: string
        readonly description: string
      },
    ) => object
  }
}

/** What `nx run sisyphus-executor:build` produces, and what an instance runs. */
const RELEASE_ARTIFACT_PATH = 'dist/main.js'

/**
 * Parameter Store path naming the current release, in the same shape as the
 * database's connection-url parameter. An instance reads exactly this one entry
 * to find out what to run.
 */
const getReleaseKeyParameterName = (stage: string): string =>
  `/sisyphus/${stage}/executor/release-key`

const region = process.env.AWS_REGION ?? DEFAULT_AWS_REGION

export default $config({
  app: (input: SstAppInput) =>
    buildSstApp({ appName: 'sisyphus-executor', sstStage: input.stage, region }),

  run: () => {
    const scope = getStackScope($app.stage)
    const stage = scope.stack

    // Names, not resources — the panel's stack creates these buckets.
    const buckets = buildBucketSpecifications({ scope })

    const contents = readFileSync(RELEASE_ARTIFACT_PATH)
    const digest = createHash('sha256').update(contents).digest('hex')

    // Content-addressed, so redeploying an unchanged build is a no-op and a
    // rollback is a parameter change rather than a re-upload.
    const releaseKey = `releases/${stage}/${digest}/main.js`

    const release = new aws.s3.BucketObject('SisyphusExecutorRelease', {
      bucket: buckets.bundles.name,
      key: releaseKey,
      source: RELEASE_ARTIFACT_PATH,
      contentType: 'application/javascript',
      serverSideEncryption: buckets.bundles.serverSideEncryption,
    })

    new aws.ssm.Parameter('SisyphusExecutorReleaseKey', {
      name: getReleaseKeyParameterName(stage),
      // Not a credential: an instance may only read it, and the object it names
      // is readable only by a role the control plane issues per workflow.
      type: 'String',
      value: releaseKey,
      description: `Sisyphus executor release key for stage "${stage}"`,
    })

    return Promise.resolve({
      releaseKey: release.key,
      releaseDigest: digest,
      releaseBucket: buckets.bundles.name,
      releaseKeyParameter: getReleaseKeyParameterName(stage),
    })
  },
})
