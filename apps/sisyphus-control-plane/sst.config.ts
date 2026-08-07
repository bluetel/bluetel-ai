/**
 * The control plane's application stack.
 *
 * The control plane has no inbound network surface (FR-035): nothing calls it
 * over HTTP, and EventBridge Scheduler invokes it directly. So what deploys here
 * is a function plus the schedule group and tick that drive it, and nothing that
 * would introduce an endpoint.
 *
 * ---------------------------------------------------------------------------
 * What this config deliberately does not create
 * ---------------------------------------------------------------------------
 * No bucket and no database. The panel's stack owns both; this config derives
 * bucket names from the same `sisyphus-infra` helper, so the two stacks cannot
 * disagree about what a bucket is called or how long it retains an object, and
 * it reads the database's connection URL straight from the SSM parameter the
 * panel's stack publishes, so there is exactly one place that value comes from.
 * Nor does it create the per-integration schedules: those are created and
 * removed by the control plane itself whenever an integration changes
 * (FR-100), which is why `createScheduler` provisions only the group and the
 * tick.
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
 * when its module is first evaluated (FR-202). The one static import below is
 * `import type`, which TypeScript erases entirely — no module is evaluated, so
 * the rule it protects is not engaged.
 */

import type { PolicyDocument } from '@bluetel-ai/sisyphus-infra'

/**
 * The control plane's Lambda entry point, owned by the app rather than by this
 * config.
 */
const CONTROL_PLANE_HANDLER = 'src/main.handler'

const CONTROL_PLANE_RUNTIME = 'nodejs22.x'

/** A tick drains a queue and reconciles a fleet; five minutes is generous but finite. */
const CONTROL_PLANE_TIMEOUT = '5 minutes'

const CONTROL_PLANE_MEMORY = '1024 MB'

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
    parameterName: getEnvParameterName('control-plane', sstStage),
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
      name: 'sisyphus-control-plane',
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
      POLICY_VERSION,
      createScheduler,
      getBucketNames,
      getConnectionUrlParameterName,
      getEnvSecret,
      getResourceIdentifier,
      getStackScope,
      readEnvRecord,
      // The package barrel — never a module inside it.
    } = await import('@bluetel-ai/sisyphus-infra')

    const region = await loadStageConfiguration($app.stage)

    const scope = getStackScope($app.stage)
    const stage = scope.stack
    const environment = readEnvRecord(process.env)

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

    // Read the panel's own published parameter rather than a copy of the value
    // living in this deployable's env blob. The env blob is operator-populated
    // and has no mechanism to notice a password rotation or a recreated
    // instance; reading the parameter the panel's stack writes to means there
    // is exactly one place the connection URL can come from.
    const { value: databaseConnectionUrl } = await aws.ssm.getParameter({
      name: getConnectionUrlParameterName(stage),
      withDecryption: true,
    })

    /**
     * EventBridge Scheduler assumes this role in order to invoke the control
     * plane. It can invoke exactly one function and do nothing else.
     */
    const buildSchedulerTrustPolicy = (): PolicyDocument => ({
      Version: POLICY_VERSION,
      Statement: [
        {
          Sid: 'EventBridgeSchedulerAssumption',
          Effect: 'Allow',
          Principal: { Service: ['scheduler.amazonaws.com'] },
          Action: ['sts:AssumeRole'],
        },
      ],
    })

    const buildSchedulerInvokePolicy = (functionArn: string): PolicyDocument => ({
      Version: POLICY_VERSION,
      Statement: [
        {
          Sid: 'InvokeControlPlane',
          Effect: 'Allow',
          Action: ['lambda:InvokeFunction'],
          Resource: [functionArn],
        },
      ],
    })

    // Names, not resources: the panel's stack creates these buckets. Deriving
    // the names from the same helper is what makes "the same bucket" a fact
    // rather than a convention.
    const bucketNames = getBucketNames(scope)
    const functionName = getResourceIdentifier(scope, 'control-plane')

    // The function's own ARN, composed rather than read back from the resource:
    // reading it would make the function's environment depend on the function.
    const { accountId } = await aws.getCallerIdentity()
    const functionArn = `arn:aws:lambda:${region}:${accountId}:function:${functionName}`

    const schedulerRoleName = getResourceIdentifier(scope, 'scheduler-invoke')
    const schedulerRoleArn = `arn:aws:iam::${accountId}:role/${schedulerRoleName}`

    const schedulerRole = new aws.iam.Role(schedulerRoleName, {
      name: schedulerRoleName,
      assumeRolePolicy: JSON.stringify(buildSchedulerTrustPolicy()),
    })

    new aws.iam.RolePolicy(`${schedulerRoleName}-policy`, {
      name: schedulerRoleName,
      role: schedulerRole.name,
      policy: JSON.stringify(buildSchedulerInvokePolicy(functionArn)),
    })

    const scheduler = createScheduler({
      scope,
      target: { functionArn, roleArn: schedulerRoleArn },
    })

    new sst.aws.Function('SisyphusControlPlane', {
      name: functionName,
      handler: CONTROL_PLANE_HANDLER,
      runtime: CONTROL_PLANE_RUNTIME,
      timeout: CONTROL_PLANE_TIMEOUT,
      memory: CONTROL_PLANE_MEMORY,
      environment: {
        AWS_REGION: region,
        SISYPHUS_STAGE: stage,
        DATABASE_URL: wrapSecret(databaseConnectionUrl),
        SISYPHUS_MACHINE_SURFACE_URL: requireClearValue('SISYPHUS_MACHINE_SURFACE_URL'),
        SISYPHUS_MACHINE_CREDENTIAL_SECRET: getEnvSecret(
          wrapSecret,
          environment,
          'SISYPHUS_MACHINE_CREDENTIAL_SECRET',
        ),
        SISYPHUS_SLACK_BOT_TOKEN: getEnvSecret(wrapSecret, environment, 'SISYPHUS_SLACK_BOT_TOKEN'),
        SISYPHUS_BOOTSTRAP_ADMIN_EMAILS: requireClearValue('SISYPHUS_BOOTSTRAP_ADMIN_EMAILS'),
        SISYPHUS_PANEL_URL: requireClearValue('SISYPHUS_PANEL_URL'),
        SISYPHUS_LOGS_BUCKET: bucketNames.logs,
        SISYPHUS_SNAPSHOTS_BUCKET: bucketNames.snapshots,
        SISYPHUS_BUNDLES_BUCKET: bucketNames.bundles,
        SISYPHUS_ARTIFACTS_BUCKET: bucketNames.artifacts,
        SISYPHUS_SCHEDULE_GROUP_NAME: scheduler.groupName,
        SISYPHUS_SCHEDULER_TARGET_ARN: functionArn,
        SISYPHUS_SCHEDULER_ROLE_ARN: schedulerRoleArn,
        SISYPHUS_EXECUTOR_AMI_ID: requireClearValue('SISYPHUS_EXECUTOR_AMI_ID'),
        SISYPHUS_EXECUTOR_INSTANCE_PROFILE_ARN: requireClearValue(
          'SISYPHUS_EXECUTOR_INSTANCE_PROFILE_ARN',
        ),
        SISYPHUS_EXECUTOR_SUBNET_IDS: requireClearValue('SISYPHUS_EXECUTOR_SUBNET_IDS'),
        SISYPHUS_EXECUTOR_SECURITY_GROUP_IDS: requireClearValue(
          'SISYPHUS_EXECUTOR_SECURITY_GROUP_IDS',
        ),
      },
    })

    return {
      controlPlaneArn: functionArn,
      scheduleGroup: scheduler.groupName,
      databaseParameter: getConnectionUrlParameterName(stage),
    }
  },
})
