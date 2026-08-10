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
 * No bucket, no database and no VPC. The panel's stack owns all three; this
 * config derives bucket names from the same `sisyphus-infra` helper, so the
 * two stacks cannot disagree about what a bucket is called or how long it
 * retains an object, and it reads the database's connection URL and the
 * shared VPC's subnet and security-group ids straight from the SSM parameters
 * the panel's stack publishes, so there is exactly one place each value comes
 * from. This function attaches itself to the VPC's private subnets on the
 * shared app security group in order to reach that database, since a database
 * that is not publicly accessible is only reachable from inside the VPC.
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
      EXECUTOR_RUNNER_ROLE_NAME,
      POLICY_VERSION,
      buildControlPlanePolicy,
      createScheduler,
      getAgentCredentialSecretPrefix,
      getAppSecurityGroupIdParameterName,
      getAppSubnetIdsParameterName,
      getBucketNames,
      getConnectionUrlParameterName,
      getEnvSecret,
      getExecutorInstanceProfileParameterName,
      getExecutorSecurityGroupIdsParameterName,
      getExecutorSubnetIdsParameterName,
      getPanelUrl,
      getResourceIdentifier,
      getStackScope,
      omitReservedLambdaEnv,
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

    // Same reasoning, for the same failure mode: the executor's stack creates
    // the instance profile (fleet-wide today — see the caveat on
    // `createRunnerRole`) and publishes its ARN here, so a profile it recreates
    // cannot leave this deployable pointed at one that no longer exists. Not a
    // secret, so no decryption to ask for.
    const { value: executorInstanceProfileArn } = await aws.ssm.getParameter({
      name: getExecutorInstanceProfileParameterName(stage),
    })

    // Same reasoning again, and this time the publisher is the panel's stack:
    // it creates the one shared VPC every deployable's compute lives in
    // (`createSisyphusVpc` in `vpc.ts`) alongside the buckets and the database,
    // so this deployable already depends on the panel's stack deploying first —
    // reading the VPC's published ids from here adds no new ordering
    // requirement beyond that existing one.
    //
    // Two different pairs, for two different tenants of that VPC: the
    // executor's public subnets and its security group go into this function's
    // own environment, for the EC2 instances it launches — the exact shape
    // `SISYPHUS_EXECUTOR_SUBNET_IDS` and `SISYPHUS_EXECUTOR_SECURITY_GROUP_IDS`
    // already take at runtime. The app's private subnets and security group,
    // below, are what this function attaches *itself* to, so it can reach the
    // database.
    const { value: executorSubnetIds } = await aws.ssm.getParameter({
      name: getExecutorSubnetIdsParameterName(stage),
    })
    const { value: executorSecurityGroupIds } = await aws.ssm.getParameter({
      name: getExecutorSecurityGroupIdsParameterName(stage),
    })
    const { value: appSubnetIds } = await aws.ssm.getParameter({
      name: getAppSubnetIdsParameterName(stage),
    })
    const { value: appSecurityGroupId } = await aws.ssm.getParameter({
      name: getAppSecurityGroupIdParameterName(stage),
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

    // Derived for the same reason the bucket names above are, and against the
    // same failure: this is the one place a stage's agent credentials live, and
    // the value has to be identical in three places at once — the environment
    // this function reads it from at runtime, the IAM statement that scopes
    // what it may do to those secrets, and (later) the executor's own grant to
    // read them. An operator-edited env blob cannot keep those three in step,
    // and getting it wrong does not fail a deploy: it either points the control
    // plane at secrets its policy does not cover, or — worse, and silently —
    // at another stage's.
    const agentCredentialSecretPrefix = getAgentCredentialSecretPrefix(scope)

    const functionName = getResourceIdentifier(scope, 'control-plane')

    // The function's own ARN, composed rather than read back from the resource:
    // reading it would make the function's environment depend on the function.
    const { accountId } = await aws.getCallerIdentity()
    const functionArn = `arn:aws:lambda:${region}:${accountId}:function:${functionName}`

    // Composed rather than read back from the executor's stack output, for the
    // same reason `functionArn` above is: `iam:PassRole` needs the role behind
    // the instance profile, not the profile itself, and the executor's stack
    // publishes only the profile's ARN (see `getExecutorInstanceProfileParameterName`
    // in `lib.ts`). `EXECUTOR_RUNNER_ROLE_NAME` is the one place both stacks read
    // the role's name suffix from, so this and `createRunnerRole` in
    // `runner-role.ts` cannot name the role differently.
    const executorRunnerRoleArn = `arn:aws:iam::${accountId}:role/${getResourceIdentifier(scope, EXECUTOR_RUNNER_ROLE_NAME)}`

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

    const controlPlanePolicy = buildControlPlanePolicy({
      region,
      accountId,
      executorRunnerRoleArn,
      agentCredentialSecretPrefix,
      schedulerGroupName: scheduler.groupName,
      schedulerRoleArn,
    })

    new sst.aws.Function('SisyphusControlPlane', {
      name: functionName,
      handler: CONTROL_PLANE_HANDLER,
      runtime: CONTROL_PLANE_RUNTIME,
      timeout: CONTROL_PLANE_TIMEOUT,
      memory: CONTROL_PLANE_MEMORY,
      // Inside the shared VPC's private subnets, on the one app security group
      // the database's own security group admits — the same pair the panel's
      // server function attaches to, and for the same reason: this Lambda has
      // to be inside the VPC to reach a database that is not publicly
      // accessible (FR-072's `publiclyAccessible: false` in `database.ts`).
      vpc: {
        privateSubnets: appSubnetIds.split(','),
        securityGroups: [appSecurityGroupId],
      },
      // `buildControlPlanePolicy` is the asserted source of truth for what this
      // function may do (FR-200); this maps its statements onto the shape SST's
      // own `permissions` prop takes rather than restating them. `Condition` has
      // no equivalent there — none of `controlPlanePolicy`'s statements use one,
      // so nothing is lost in the mapping.
      permissions: controlPlanePolicy.Statement.map((statement) => ({
        effect: statement.Effect === 'Allow' ? ('allow' as const) : ('deny' as const),
        actions: [...statement.Action],
        resources: [...(statement.Resource ?? [])],
      })),
      // AWS_REGION is injected into every Lambda's runtime automatically;
      // declaring it too is rejected at deploy time, so it is filtered rather
      // than simply omitted below — the value still comes from `region` for
      // any reader that expects it to be present in this object's shape.
      environment: omitReservedLambdaEnv({
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
        // Same derivation the panel's own stack uses, for the same reason the
        // variable exists at all: both hosts write run links for the same run,
        // and a stage whose panel is served from `sisyphus.bluetel.co.uk` must
        // not have the sweep linking to whatever origin this deployable's env
        // blob was last edited with. A stage with no domain still reads it.
        SISYPHUS_PANEL_URL: getPanelUrl($app.stage) ?? requireClearValue('SISYPHUS_PANEL_URL'),
        SISYPHUS_LOGS_BUCKET: bucketNames.logs,
        SISYPHUS_SNAPSHOTS_BUCKET: bucketNames.snapshots,
        SISYPHUS_BUNDLES_BUCKET: bucketNames.bundles,
        SISYPHUS_ARTIFACTS_BUCKET: bucketNames.artifacts,
        SISYPHUS_AGENT_CREDENTIAL_SECRET_PREFIX: agentCredentialSecretPrefix,
        SISYPHUS_SCHEDULE_GROUP_NAME: scheduler.groupName,
        SISYPHUS_SCHEDULER_TARGET_ARN: functionArn,
        SISYPHUS_SCHEDULER_ROLE_ARN: schedulerRoleArn,
        SISYPHUS_EXECUTOR_AMI_ID: requireClearValue('SISYPHUS_EXECUTOR_AMI_ID'),
        SISYPHUS_EXECUTOR_INSTANCE_PROFILE_ARN: executorInstanceProfileArn,
        SISYPHUS_EXECUTOR_SUBNET_IDS: executorSubnetIds,
        SISYPHUS_EXECUTOR_SECURITY_GROUP_IDS: executorSecurityGroupIds,
      }),
    })

    return {
      controlPlaneArn: functionArn,
      scheduleGroup: scheduler.groupName,
      databaseParameter: getConnectionUrlParameterName(stage),
      executorInstanceProfileArn,
    }
  },
})
