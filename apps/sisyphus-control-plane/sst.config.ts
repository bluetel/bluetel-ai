/**
 * SST deployment for the control plane.
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
 * their names from the same `sisyphus-infra` builders, so the two stacks cannot
 * disagree about what a bucket is called or how long it retains an object. Nor
 * does it create the per-integration schedules: those are created and removed by
 * the control plane itself whenever an integration changes (FR-100), which is
 * why `createScheduler` provisions only the group and the tick.
 */

import {
  DEFAULT_AWS_REGION,
  POLICY_VERSION,
  buildBucketSpecifications,
  buildSstApp,
  createScheduler,
  getConnectionUrlParameterName,
  getEnvSecret,
  getResourceIdentifier,
  getStackScope,
  readEnvRecord,
  type PolicyDocument,
  type ScheduleSpecification,
  type SchedulerGroupSpecification,
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

type DeployValue = PulumiOutput<string> | string

declare const $config: <TOutputs>(
  definition: SstConfigDefinition<TOutputs>,
) => SstConfigDefinition<TOutputs>

declare const $app: { readonly name: string; readonly stage: string }

declare const $util: { readonly secret: (value: DeployValue) => PulumiOutput<string> }

declare const aws: {
  readonly getCallerIdentity: () => Promise<{ readonly accountId: string }>
  readonly iam: {
    readonly Role: new (
      name: string,
      args: { readonly name: string; readonly assumeRolePolicy: string },
    ) => { readonly name: PulumiOutput<string>; readonly arn: PulumiOutput<string> }
    readonly RolePolicy: new (
      name: string,
      args: {
        readonly name: string
        readonly role: PulumiOutput<string>
        readonly policy: string
      },
    ) => object
  }
  readonly scheduler: {
    readonly ScheduleGroup: new (
      name: string,
      args: { readonly name: string },
    ) => { readonly name: PulumiOutput<string> }
    readonly Schedule: new (
      name: string,
      args: {
        readonly name: string
        readonly groupName: string
        readonly scheduleExpression: string
        readonly scheduleExpressionTimezone: string
        readonly flexibleTimeWindow: { readonly mode: 'OFF' }
        readonly state: 'DISABLED' | 'ENABLED'
        readonly target: {
          readonly arn: string
          readonly roleArn: string
          readonly input: string
        }
      },
    ) => { readonly name: PulumiOutput<string> }
  }
}

declare const sst: {
  readonly aws: {
    readonly Function: new (
      name: string,
      args: {
        readonly name: string
        readonly handler: string
        readonly runtime: string
        readonly timeout: string
        readonly memory: string
        readonly environment: Readonly<Record<string, DeployValue>>
      },
    ) => { readonly arn: PulumiOutput<string> }
  }
}

/**
 * The control plane's Lambda entry point, owned by the app rather than by this
 * config.
 */
const CONTROL_PLANE_HANDLER = 'src/main.handler'

const CONTROL_PLANE_RUNTIME = 'nodejs22.x'

/** A tick drains a queue and reconciles a fleet; a minute is generous but finite. */
const CONTROL_PLANE_TIMEOUT = '5 minutes'

const CONTROL_PLANE_MEMORY = '1024 MB'

const region = process.env.AWS_REGION ?? DEFAULT_AWS_REGION

/**
 * EventBridge Scheduler assumes this role in order to invoke the control plane.
 * It can invoke exactly one function and do nothing else.
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

export default $config({
  app: (input: SstAppInput) =>
    buildSstApp({ appName: 'sisyphus-control-plane', sstStage: input.stage, region }),

  run: async () => {
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

    // Names, not resources: the panel's stack creates these buckets. Deriving
    // the names from the same builder is what makes "the same bucket" a fact
    // rather than a convention.
    const buckets = buildBucketSpecifications({ scope })
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

    const scheduler = createScheduler(
      {
        createScheduleGroup: (name: string, specification: SchedulerGroupSpecification) =>
          new aws.scheduler.ScheduleGroup(name, { name: specification.name }),
        createSchedule: (name: string, specification: ScheduleSpecification) =>
          new aws.scheduler.Schedule(name, {
            name: specification.name,
            groupName: specification.groupName,
            scheduleExpression: specification.scheduleExpression,
            scheduleExpressionTimezone: specification.scheduleExpressionTimezone,
            flexibleTimeWindow: { mode: specification.flexibleTimeWindowMode },
            state: specification.state,
            target: {
              arn: specification.target.arn,
              roleArn: specification.target.roleArn,
              input: specification.target.input,
            },
          }),
      },
      { scope, target: { functionArn, roleArn: schedulerRoleArn } },
    )

    new sst.aws.Function('SisyphusControlPlane', {
      name: functionName,
      handler: CONTROL_PLANE_HANDLER,
      runtime: CONTROL_PLANE_RUNTIME,
      timeout: CONTROL_PLANE_TIMEOUT,
      memory: CONTROL_PLANE_MEMORY,
      environment: {
        AWS_REGION: region,
        SISYPHUS_STAGE: stage,
        DATABASE_URL: getEnvSecret($util.secret, environment, 'DATABASE_URL'),
        SISYPHUS_MACHINE_SURFACE_URL: requireClearValue('SISYPHUS_MACHINE_SURFACE_URL'),
        SISYPHUS_MACHINE_CREDENTIAL_SECRET: getEnvSecret(
          $util.secret,
          environment,
          'SISYPHUS_MACHINE_CREDENTIAL_SECRET',
        ),
        SISYPHUS_SLACK_BOT_TOKEN: getEnvSecret(
          $util.secret,
          environment,
          'SISYPHUS_SLACK_BOT_TOKEN',
        ),
        SISYPHUS_BOOTSTRAP_ADMIN_EMAILS: requireClearValue('SISYPHUS_BOOTSTRAP_ADMIN_EMAILS'),
        SISYPHUS_PANEL_URL: requireClearValue('SISYPHUS_PANEL_URL'),
        SISYPHUS_LOGS_BUCKET: buckets.logs.name,
        SISYPHUS_SNAPSHOTS_BUCKET: buckets.snapshots.name,
        SISYPHUS_BUNDLES_BUCKET: buckets.bundles.name,
        SISYPHUS_ARTIFACTS_BUCKET: buckets.artifacts.name,
        SISYPHUS_SCHEDULE_GROUP_NAME: scheduler.groupSpecification.name,
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
      scheduleGroup: scheduler.groupSpecification.name,
      databaseParameter: getConnectionUrlParameterName(stage),
    }
  },
})
