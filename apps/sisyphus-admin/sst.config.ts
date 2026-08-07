/**
 * SST deployment for the Sisyphus panel — and, with it, the stage's shared data
 * plane.
 *
 * ---------------------------------------------------------------------------
 * Why the panel owns the buckets and the database
 * ---------------------------------------------------------------------------
 * Three SST apps deploy into one stage. A shared resource must therefore have
 * exactly one owner, or two stacks fight over it — and three configs each
 * declaring their own artifacts bucket are three chances to disagree about
 * retention, a disagreement that surfaces as evidence vanishing early. The panel
 * creates the four buckets and the database. The control plane and the executor
 * derive the same names from the same builders in `sisyphus-infra`, and neither
 * declares a bucket of its own.
 *
 * Everything structural therefore comes from `sisyphus-infra`. What is declared
 * inline is only what nothing else could share: the Next.js site, and the
 * argument shapes the AWS provider wants.
 */

import {
  DEFAULT_AWS_REGION,
  buildDeployRoleTrustPolicy,
  buildSstApp,
  createBuckets,
  createDatabase,
  getEnvSecret,
  getResourceIdentifier,
  getStackScope,
  isBootstrapStage,
  isDeployStage,
  readEnvRecord,
  resolveOidcProviderArn,
  type BucketLifecycleRule,
  type BucketSpecification,
  type DatabaseSpecification,
  type ParameterSpecification,
  type SstAppInput,
  type SstConfigDefinition,
  // The package barrel — never a module inside it.
} from '@bluetel-ai/sisyphus-infra'

/**
 * SST injects `$config`, `$app`, `$output`, `$util`, `aws` and `sst` as globals
 * typed by the generated `.sst/platform/config.d.ts`. That file only exists
 * after `sst install` and is git-ignored, so CI never sees it. Declaring the
 * slice this config uses at module scope — where it shadows the generated
 * globals rather than colliding with them — is what lets the file typecheck on a
 * clean checkout, with no install step and no cloud access.
 */
interface PulumiOutput<TValue> {
  readonly apply: <TResult>(transform: (value: TValue) => TResult) => PulumiOutput<TResult>
}

/** A value a resource argument accepts: known now, or known after a create. */
type DeployValue = PulumiOutput<string> | string

interface AwsBucketResource {
  readonly bucket: PulumiOutput<string>
  readonly arn: PulumiOutput<string>
}

interface AwsDatabaseResource {
  readonly endpoint: PulumiOutput<string>
}

interface AwsLifecycleExpiration {
  readonly days?: number
  readonly expiredObjectDeleteMarker?: boolean
}

interface AwsLifecycleRule {
  readonly id: string
  readonly status: 'Enabled'
  readonly filter: { readonly prefix: string }
  readonly expiration?: AwsLifecycleExpiration
  readonly transitions: readonly { readonly days: number; readonly storageClass: string }[]
  readonly abortIncompleteMultipartUpload: { readonly daysAfterInitiation: number }
}

declare const $config: <TOutputs>(
  definition: SstConfigDefinition<TOutputs>,
) => SstConfigDefinition<TOutputs>

declare const $app: { readonly name: string; readonly stage: string }

declare const $output: (value: DeployValue) => PulumiOutput<string>

declare const $util: { readonly secret: (value: DeployValue) => PulumiOutput<string> }

declare const aws: {
  readonly s3: {
    readonly BucketV2: new (
      name: string,
      args: { readonly bucket: string; readonly forceDestroy: boolean },
    ) => AwsBucketResource
    readonly BucketPublicAccessBlock: new (
      name: string,
      args: {
        readonly bucket: PulumiOutput<string>
        readonly blockPublicAcls: boolean
        readonly blockPublicPolicy: boolean
        readonly ignorePublicAcls: boolean
        readonly restrictPublicBuckets: boolean
      },
    ) => object
    readonly BucketServerSideEncryptionConfigurationV2: new (
      name: string,
      args: {
        readonly bucket: PulumiOutput<string>
        readonly rules: readonly {
          readonly applyServerSideEncryptionByDefault: { readonly sseAlgorithm: string }
        }[]
      },
    ) => object
    readonly BucketVersioningV2: new (
      name: string,
      args: {
        readonly bucket: PulumiOutput<string>
        readonly versioningConfiguration: { readonly status: 'Enabled' | 'Suspended' }
      },
    ) => object
    readonly BucketLifecycleConfigurationV2: new (
      name: string,
      args: { readonly bucket: PulumiOutput<string>; readonly rules: readonly AwsLifecycleRule[] },
    ) => object
  }
  readonly rds: {
    readonly Instance: new (
      name: string,
      args: {
        readonly identifier: string
        readonly engine: string
        readonly engineVersion: string
        readonly instanceClass: string
        readonly allocatedStorage: number
        readonly storageEncrypted: boolean
        readonly publiclyAccessible: boolean
        readonly multiAz: boolean
        readonly backupRetentionPeriod: number
        readonly deletionProtection: boolean
        readonly dbName: string
        readonly username: string
        readonly password: DeployValue
        readonly skipFinalSnapshot: boolean
      },
    ) => AwsDatabaseResource
  }
  readonly ssm: {
    readonly Parameter: new (
      name: string,
      args: {
        readonly name: string
        readonly type: string
        readonly value: DeployValue
        readonly description: string
      },
    ) => object
  }
  readonly iam: {
    readonly OpenIdConnectProvider: new (
      name: string,
      args: {
        readonly url: string
        readonly clientIdLists: readonly string[]
        readonly thumbprintLists: readonly string[]
      },
    ) => { readonly arn: PulumiOutput<string> }
    readonly getOpenIdConnectProvider: (args: {
      readonly url: string
    }) => Promise<{ readonly arn: string }>
    readonly Role: new (
      name: string,
      args: { readonly name: string; readonly assumeRolePolicy: DeployValue },
    ) => { readonly name: PulumiOutput<string>; readonly arn: PulumiOutput<string> }
    readonly RolePolicyAttachment: new (
      name: string,
      args: { readonly role: PulumiOutput<string>; readonly policyArn: string },
    ) => object
  }
}

declare const sst: {
  readonly aws: {
    readonly Nextjs: new (
      name: string,
      args: {
        readonly path: string
        readonly environment: Readonly<Record<string, DeployValue>>
      },
    ) => { readonly url: PulumiOutput<string> }
  }
}

/** The database user the panel and the control plane connect as. */
const DATABASE_USERNAME = 'sisyphus'

/**
 * The deploy role is the one identity that must be able to create every kind of
 * resource a stage contains, so it is not narrowed by permission. It is narrowed
 * by **trust**: `buildDeployRoleTrustPolicy` pins the `sub` claim to a single
 * branch, so a workflow running on any other ref cannot assume it at all
 * (FR-067). That is the control; the pipeline's branch conditions are defence in
 * depth.
 */
const DEPLOY_ROLE_POLICY_ARN = 'arn:aws:iam::aws:policy/AdministratorAccess'

const region = process.env.AWS_REGION ?? DEFAULT_AWS_REGION

const toLifecycleExpiration = (rule: BucketLifecycleRule): AwsLifecycleExpiration | undefined => {
  if (rule.expirationDays !== null) {
    return { days: rule.expirationDays }
  }

  // A class that never expires still sweeps its delete markers where it has
  // versions to accumulate them. AWS rejects a rule carrying both, which is why
  // these two are exclusive rather than combined.
  return rule.cleanExpiredObjectDeleteMarker ? { expiredObjectDeleteMarker: true } : undefined
}

const toLifecycleRule = (rule: BucketLifecycleRule): AwsLifecycleRule => ({
  id: rule.id,
  status: 'Enabled',
  filter: { prefix: rule.prefix },
  expiration: toLifecycleExpiration(rule),
  transitions: rule.transitions.map((transition) => ({
    days: transition.days,
    storageClass: transition.storageClass,
  })),
  abortIncompleteMultipartUpload: {
    daysAfterInitiation: rule.abortIncompleteMultipartUploadDays,
  },
})

export default $config({
  app: (input: SstAppInput) =>
    buildSstApp({ appName: 'sisyphus-admin', sstStage: input.stage, region }),

  run: async () => {
    const scope = getStackScope($app.stage)
    const stage = scope.stack
    const environment = readEnvRecord(process.env)

    /** Deploy-time configuration that is not a credential and must stay legible. */
    const requireClearValue = (key: string): string => {
      const value: string | undefined = environment[key]

      if (!value) {
        throw new Error(`Missing environment variable: ${key}`)
      }

      return value
    }

    // ----------------------------------------------------------------------
    // Bootstrap stage: the account-level identity CI deploys with (FR-068).
    // Created once by `production-bootstrap` and looked up by every other
    // stage, which is why this is a stage of its own rather than a branch of
    // the application stack.
    // ----------------------------------------------------------------------
    if (isBootstrapStage($app.stage)) {
      const oidcProviderArn = await resolveOidcProviderArn<DeployValue>(
        {
          createProvider: (name, specification) =>
            new aws.iam.OpenIdConnectProvider(name, {
              url: specification.url,
              clientIdLists: specification.clientIdList,
              thumbprintLists: specification.thumbprintList,
            }),
          lookupProvider: (url) => aws.iam.getOpenIdConnectProvider({ url }),
        },
        { scope, stage },
      )

      const githubRepo = requireClearValue('SISYPHUS_GITHUB_REPO')
      const deployRoleName = getResourceIdentifier(scope, 'deploy')

      const deployRole = new aws.iam.Role(deployRoleName, {
        name: deployRoleName,
        assumeRolePolicy: $output(oidcProviderArn).apply((arn) =>
          JSON.stringify(buildDeployRoleTrustPolicy({ oidcProviderArn: arn, githubRepo, stage })),
        ),
      })

      new aws.iam.RolePolicyAttachment(`${deployRoleName}-policy`, {
        role: deployRole.name,
        policyArn: DEPLOY_ROLE_POLICY_ARN,
      })

      return { deployRoleArn: deployRole.arn }
    }

    // ----------------------------------------------------------------------
    // Application stage: the shared data plane, then the panel on top of it.
    // ----------------------------------------------------------------------
    const createBucketResource = (
      name: string,
      specification: BucketSpecification,
    ): AwsBucketResource => {
      const resource = new aws.s3.BucketV2(name, {
        bucket: name,
        // A deploy stage keeps its objects; a personal stage must be destroyable.
        forceDestroy: !isDeployStage(stage),
      })

      new aws.s3.BucketPublicAccessBlock(`${name}-public-access-block`, {
        bucket: resource.bucket,
        blockPublicAcls: specification.blockPublicAccess,
        blockPublicPolicy: specification.blockPublicAccess,
        ignorePublicAcls: specification.blockPublicAccess,
        restrictPublicBuckets: specification.blockPublicAccess,
      })

      new aws.s3.BucketServerSideEncryptionConfigurationV2(`${name}-encryption`, {
        bucket: resource.bucket,
        rules: [
          {
            applyServerSideEncryptionByDefault: {
              sseAlgorithm: specification.serverSideEncryption,
            },
          },
        ],
      })

      new aws.s3.BucketVersioningV2(`${name}-versioning`, {
        bucket: resource.bucket,
        versioningConfiguration: { status: specification.versioned ? 'Enabled' : 'Suspended' },
      })

      // The retention schedule is never restated here: the rules come from
      // `buildBucketSpecifications`, which is also what stamps an artifact row's
      // `expires_at`, so the record and the bucket cannot drift apart.
      new aws.s3.BucketLifecycleConfigurationV2(`${name}-lifecycle`, {
        bucket: resource.bucket,
        rules: specification.lifecycleRules.map(toLifecycleRule),
      })

      return resource
    }

    const buckets = createBuckets({ createBucket: createBucketResource }, { scope })

    const databasePassword = requireClearValue('SISYPHUS_DATABASE_PASSWORD')

    const buildConnectionUrl = (instance: AwsDatabaseResource): PulumiOutput<string> =>
      $util.secret(
        instance.endpoint.apply(
          (endpoint) =>
            `postgres://${DATABASE_USERNAME}:${encodeURIComponent(databasePassword)}@${endpoint}/${DATABASE_USERNAME}`,
        ),
      )

    const database = createDatabase(
      {
        createInstance: (name: string, specification: DatabaseSpecification) =>
          new aws.rds.Instance(name, {
            identifier: specification.identifier,
            engine: specification.engine,
            engineVersion: specification.engineVersion,
            instanceClass: specification.instanceClass,
            allocatedStorage: specification.allocatedStorageGb,
            storageEncrypted: specification.storageEncrypted,
            publiclyAccessible: specification.publiclyAccessible,
            multiAz: specification.multiAvailabilityZone,
            backupRetentionPeriod: specification.backupRetentionDays,
            deletionProtection: specification.deletionProtection,
            dbName: specification.databaseName,
            username: DATABASE_USERNAME,
            password: $util.secret(databasePassword),
            skipFinalSnapshot: !specification.deletionProtection,
          }),
        createParameter: (name: string, specification: ParameterSpecification<DeployValue>) =>
          new aws.ssm.Parameter(name, {
            name: specification.name,
            type: specification.type,
            value: specification.value,
            description: specification.description,
          }),
      },
      { scope, stage },
      buildConnectionUrl,
    )

    const site = new sst.aws.Nextjs('SisyphusPanel', {
      path: '.',
      environment: {
        AWS_REGION: region,
        SISYPHUS_STAGE: stage,
        DATABASE_URL: buildConnectionUrl(database.instance),
        AUTH_SECRET: getEnvSecret($util.secret, environment, 'AUTH_SECRET'),
        AUTH_GOOGLE_ID: getEnvSecret($util.secret, environment, 'AUTH_GOOGLE_ID'),
        AUTH_GOOGLE_SECRET: getEnvSecret($util.secret, environment, 'AUTH_GOOGLE_SECRET'),
        SISYPHUS_MACHINE_CREDENTIAL_SECRET: getEnvSecret(
          $util.secret,
          environment,
          'SISYPHUS_MACHINE_CREDENTIAL_SECRET',
        ),
        SISYPHUS_PERMITTED_EMAIL_DOMAINS: requireClearValue('SISYPHUS_PERMITTED_EMAIL_DOMAINS'),
        // Inlined into the browser bundle at build time, so never secrets.
        NEXT_PUBLIC_NODE_ENV: requireClearValue('NEXT_PUBLIC_NODE_ENV'),
        NEXT_PUBLIC_SITE_URL: requireClearValue('NEXT_PUBLIC_SITE_URL'),
        SISYPHUS_LOGS_BUCKET: buckets.logs.specification.name,
        SISYPHUS_SNAPSHOTS_BUCKET: buckets.snapshots.specification.name,
        SISYPHUS_BUNDLES_BUCKET: buckets.bundles.specification.name,
        SISYPHUS_ARTIFACTS_BUCKET: buckets.artifacts.specification.name,
      },
    })

    return {
      panelUrl: site.url,
      databaseParameter: database.specification.connectionUrlParameterName,
      artifactsBucket: buckets.artifacts.specification.name,
      bundlesBucket: buckets.bundles.specification.name,
      logsBucket: buckets.logs.specification.name,
      snapshotsBucket: buckets.snapshots.specification.name,
    }
  },
})
