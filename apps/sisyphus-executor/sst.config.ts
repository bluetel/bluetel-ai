/**
 * The executor's application stack.
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
 * names from the same `getBucketNames` the panel builds them with, so the two
 * stacks cannot disagree about a name or a retention schedule.
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
 *
 * ---------------------------------------------------------------------------
 * Three files, and why this one only builds the application stack
 * ---------------------------------------------------------------------------
 * `sst-bootstrap.config.ts` creates the configuration entry this file reads, and
 * `sst-install.config.ts` generates types with no credentials. One file
 * branching on a stage suffix made every invocation evaluate the other two's
 * preconditions, and let a mistyped stage string reach the wrong stack. The
 * config file now selects the stack; the stage selects only the environment
 * (FR-199).
 *
 * Configuration is resolved inside `app()` / `run()` and every import is a
 * dynamic `await import()`: the ambient globals do not exist at
 * module-evaluation time, and `createSafeEnv` snapshots `SKIP_ENV_VALIDATION`
 * when its module is first evaluated (FR-202).
 */

/** What `nx run sisyphus-executor:build` produces, and what an instance runs. */
const RELEASE_ARTIFACT_PATH = 'dist/main.js'

/**
 * Parameter Store path naming the current release, in the same shape as the
 * database's connection-url parameter. An instance reads exactly this one entry
 * to find out what to run.
 */
const getReleaseKeyParameterName = (stage: string): string =>
  `/sisyphus/${stage}/executor/release-key`

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
    parameterName: getEnvParameterName('executor', sstStage),
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
      name: 'sisyphus-executor',
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
    const { createHash } = await import('node:crypto')
    const { readFileSync } = await import('node:fs')

    const {
      BUCKET_SERVER_SIDE_ENCRYPTION,
      getBucketNames,
      getStackScope,
      // The package barrel — never a module inside it.
    } = await import('@bluetel-ai/sisyphus-infra')

    await loadStageConfiguration($app.stage)

    const scope = getStackScope($app.stage)
    const stage = scope.stack

    // Names, not resources — the panel's stack creates these buckets.
    const bucketNames = getBucketNames(scope)

    const contents = readFileSync(RELEASE_ARTIFACT_PATH)
    const digest = createHash('sha256').update(contents).digest('hex')

    // Content-addressed, so redeploying an unchanged build is a no-op and a
    // rollback is a parameter change rather than a re-upload.
    const releaseKey = `releases/${stage}/${digest}/main.js`

    const release = new aws.s3.BucketObject('SisyphusExecutorRelease', {
      bucket: bucketNames.bundles,
      key: releaseKey,
      source: new $util.asset.FileAsset(RELEASE_ARTIFACT_PATH),
      contentType: 'application/javascript',
      serverSideEncryption: BUCKET_SERVER_SIDE_ENCRYPTION,
    })

    new aws.ssm.Parameter('SisyphusExecutorReleaseKey', {
      name: getReleaseKeyParameterName(stage),
      // Not a credential: an instance may only read it, and the object it names
      // is readable only by a role the control plane issues per workflow.
      type: 'String',
      value: releaseKey,
      description: `Sisyphus executor release key for stage "${stage}"`,
    })

    return {
      releaseKey: release.key,
      releaseDigest: digest,
      releaseBucket: bucketNames.bundles,
      releaseKeyParameter: getReleaseKeyParameterName(stage),
    }
  },
})
