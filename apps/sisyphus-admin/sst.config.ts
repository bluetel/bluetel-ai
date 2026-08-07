/**
 * The panel's application stack — and, with it, the stage's shared data plane.
 *
 * ---------------------------------------------------------------------------
 * Why the panel owns the buckets and the database
 * ---------------------------------------------------------------------------
 * Three SST apps deploy into one stage. A shared resource must therefore have
 * exactly one owner, or two stacks fight over it — and three configs each
 * declaring their own artifacts bucket are three chances to disagree about
 * retention, a disagreement that surfaces as evidence vanishing early. The panel
 * creates the four buckets and the database. The control plane and the executor
 * derive the same names from the same helpers in `sisyphus-infra`, and neither
 * declares a bucket of its own.
 *
 * Everything structural comes from `sisyphus-infra`, and it comes as a function
 * call: nothing sits between the import and the resource (FR-066).
 *
 * ---------------------------------------------------------------------------
 * Three files, and why this one only builds the application stack
 * ---------------------------------------------------------------------------
 * `sst-bootstrap.config.ts` builds the once-per-stage prerequisites and
 * `sst-install.config.ts` generates types with no credentials. They used to be
 * one file branching on a stage suffix, which meant every invocation evaluated
 * preconditions belonging to the other two — and a stage string typed wrong was
 * enough to reach the wrong stack. The config file now selects the stack and the
 * stage selects only the environment (FR-199).
 *
 * ---------------------------------------------------------------------------
 * Two mechanics that look stylistic and are not
 * ---------------------------------------------------------------------------
 * Configuration is resolved *inside* `app()` and `run()`, and every import is a
 * dynamic `await import()`. The ambient globals do not exist at module-evaluation
 * time, and `createSafeEnv` snapshots `SKIP_ENV_VALIDATION` when its module is
 * first evaluated — a static import would read it before this config had set the
 * stage (FR-202).
 */

/** The database user the panel and the control plane connect as. */
const DATABASE_USERNAME = 'sisyphus'

/**
 * Loads the stage's deploy-time configuration into `process.env`.
 *
 * The entry is created by this app's bootstrap stack and populated by an
 * operator; it is read here rather than committed, so a credential never lands
 * in the repository (FR-202). Values already present in the environment win, so
 * a workflow's `AWS_REGION` still overrides the stored one.
 */
const loadStageConfiguration = async (sstStage: string): Promise<string> => {
  const { DEFAULT_AWS_REGION } = await import('@bluetel-ai/sisyphus-infra')
  const { fetchSsmParamToProcessEnv, getEnvParameterName } =
    await import('@bluetel-ai/sisyphus-infra/scripts')

  const region = process.env.AWS_REGION ?? DEFAULT_AWS_REGION

  await fetchSsmParamToProcessEnv({
    parameterName: getEnvParameterName('admin', sstStage),
    region,
  })

  return region
}

export default $config({
  app: async (input) => {
    const { getStageRemoval, isBootstrapStage } = await import('@bluetel-ai/sisyphus-infra')

    // The config file selects the stack; the stage selects only the environment.
    // This is the other half of that: a stage belonging to the sibling config is
    // refused outright, so neither half of the pair can be reached by getting a
    // stage string wrong (FR-199).
    if (isBootstrapStage(input.stage)) {
      throw new Error(
        `Stage "${input.stage}" belongs to sst-bootstrap.config.ts. This config builds the ` +
          `application stack; deploy it against the plain stage.`,
      )
    }

    const region = await loadStageConfiguration(input.stage)

    return {
      // Per deployable, and deliberately *not* the resource-name prefix.
      name: 'sisyphus-admin',
      home: 'aws',
      ...getStageRemoval(input.stage),
      // Pinned, and pinned identically in `sst-bootstrap.config.ts` and
      // `sst-install.config.ts`. The install config generates the types this
      // file is compiled against; a drift here compiles against one API and
      // deploys against another.
      providers: { aws: { version: '6.66.2', region: region as aws.Region } },
    }
  },

  run: async () => {
    const {
      createBuckets,
      createDatabase,
      createNextjsWebsite,
      getBucketNames,
      getEnvSecret,
      getStackScope,
      readEnvRecord,
      // The package barrel — never a module inside it.
    } = await import('@bluetel-ai/sisyphus-infra')

    const region = await loadStageConfiguration($app.stage)

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

    /**
     * `$util.secret` is overloaded, and passing it as a bare function reference
     * selects the overload that infers `undefined`. Naming the argument and the
     * return type picks the one that wraps a string.
     */
    const wrapSecret = (value: string): $util.Output<string> => $util.secret(value)

    // ----------------------------------------------------------------------
    // The shared data plane, then the panel on top of it.
    // ----------------------------------------------------------------------
    createBuckets({ scope })

    const bucketNames = getBucketNames(scope)

    const database = createDatabase({
      scope,
      stage,
      username: DATABASE_USERNAME,
      password: requireClearValue('SISYPHUS_DATABASE_PASSWORD'),
    })

    const site = createNextjsWebsite({
      path: '.',
      environment: {
        AWS_REGION: region,
        SISYPHUS_STAGE: stage,
        DATABASE_URL: database.connectionUrl,
        AUTH_SECRET: getEnvSecret(wrapSecret, environment, 'AUTH_SECRET'),
        AUTH_GOOGLE_ID: getEnvSecret(wrapSecret, environment, 'AUTH_GOOGLE_ID'),
        AUTH_GOOGLE_SECRET: getEnvSecret(wrapSecret, environment, 'AUTH_GOOGLE_SECRET'),
        SISYPHUS_MACHINE_CREDENTIAL_SECRET: getEnvSecret(
          wrapSecret,
          environment,
          'SISYPHUS_MACHINE_CREDENTIAL_SECRET',
        ),
        SISYPHUS_PERMITTED_EMAIL_DOMAINS: requireClearValue('SISYPHUS_PERMITTED_EMAIL_DOMAINS'),
        // The panel mounts the machine surface, so it delivers FR-136's notifications for every
        // outcome an executor reports. Same two variables the control plane reads, from the same
        // stage configuration: one Slack app, and one origin that run links point at.
        SISYPHUS_SLACK_BOT_TOKEN: getEnvSecret(wrapSecret, environment, 'SISYPHUS_SLACK_BOT_TOKEN'),
        SISYPHUS_PANEL_URL: requireClearValue('SISYPHUS_PANEL_URL'),
        // Inlined into the browser bundle at build time, so never secrets.
        NEXT_PUBLIC_NODE_ENV: requireClearValue('NEXT_PUBLIC_NODE_ENV'),
        NEXT_PUBLIC_SITE_URL: requireClearValue('NEXT_PUBLIC_SITE_URL'),
        SISYPHUS_LOGS_BUCKET: bucketNames.logs,
        SISYPHUS_SNAPSHOTS_BUCKET: bucketNames.snapshots,
        SISYPHUS_BUNDLES_BUCKET: bucketNames.bundles,
        SISYPHUS_ARTIFACTS_BUCKET: bucketNames.artifacts,
      },
    })

    return {
      panelUrl: site.url,
      databaseParameter: database.connectionUrlParameterName,
      artifactsBucket: bucketNames.artifacts,
      bundlesBucket: bucketNames.bundles,
      logsBucket: bucketNames.logs,
      snapshotsBucket: bucketNames.snapshots,
    }
  },
})
