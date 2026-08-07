import { EC2Client } from '@aws-sdk/client-ec2'
import { S3Client } from '@aws-sdk/client-s3'
import { SchedulerClient } from '@aws-sdk/client-scheduler'
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import type { SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import { getDatabaseClient } from '@bluetel-ai/sisyphus-api/db'
import type { WorkflowNotifier } from '@bluetel-ai/sisyphus-notify'
import {
  createNotificationStore,
  createWebApiSlackMessenger,
  createWorkflowNotifier,
} from '@bluetel-ai/sisyphus-notify'
import { WebClient } from '@slack/web-api'

import type { ComputeProvisioner, ObjectStore, ScheduleRegistry } from './aws'
import {
  createEc2ComputeProvisioner,
  createEventBridgeScheduleRegistry,
  createS3ObjectStore,
  createSecretsManagerReader,
} from './aws'
import type { env as validatedEnv } from './env'
import type {
  ConnectorRegistry,
  DurabilityBuckets,
  PromptRedactor,
  QueueDrain,
  WorkflowStarter,
} from './jobs'
import {
  createRefusingPromptRedactor,
  createRegisteredConnectorRegistry,
  createWorkflowStarter,
  drainQueue,
} from './jobs'

/**
 * The control plane's composition root (T172).
 *
 * Every job in `jobs/` takes its dependencies as parameters and constructs nothing — which is what
 * makes 536 tests possible against fakes, and what leaves one file to assemble the real thing. This
 * is that file: it is the only place in the app that builds an AWS client or opens a pool, and it
 * is called by `main.ts` once per invocation.
 *
 * ## Why the environment is a parameter
 *
 * `env.ts` validates at import. Taking the validated environment as an argument means importing
 * *this* module validates nothing, so a test can state a configuration rather than mutate
 * `process.env`, and `main.ts` can fail a malformed variable inside the handler — where it is a job
 * failure naming the variable — rather than during module evaluation, where it is a Lambda
 * initialisation error with no event attached to it.
 *
 * ## Why every port is overridable
 *
 * The overrides are not a testing convenience bolted on; they are the seam a deployment wires
 * through. The prompt redactor is the case that matters: {@link createRefusingPromptRedactor} is
 * the default because the standard FR-163 sets lives in the executor's output pipeline and no
 * package publishes it yet, and a deployment that has wired none must fail its ticks loudly rather
 * than write unredacted ticket bodies into `workflows.assembled_prompt`.
 */

/** The validated environment, without importing it — `import type` is erased. */
export type ControlPlaneEnv = typeof validatedEnv

/** Everything the jobs need that they do not construct. One field per port. */
export interface ControlPlaneContext {
  readonly db: SisyphusDatabase
  readonly compute: ComputeProvisioner
  readonly objectStore: ObjectStore
  readonly schedules: ScheduleRegistry
  readonly connectors: ConnectorRegistry
  readonly redactor: PromptRedactor
  /** Resolves `integrations.credential_secret_arn` at tick time, never cached (FR-072). */
  readonly readCredential: (secretArn: string) => Promise<string>
  /** The three classes teardown confirms durable before it destroys anything. */
  readonly buckets: DurabilityBuckets
  /** The platform-wide concurrency ceiling in force (FR-040). */
  readonly ceiling: number
  readonly machineSurfaceUrl: string
  readonly credentialSecret: string
  readonly bootstrapAdminEmails: readonly string[]
  /** Provisioning, as the queue drain's hand-off seam (T052). */
  readonly starter: WorkflowStarter
  /** Re-admission after a release, as teardown and the reconciler take it (FR-040). */
  readonly queueDrain: QueueDrain
  /**
   * How a job tells a run's owner what happened to it (T177, FR-136, FR-139).
   *
   * Assembled here and nowhere else, which is the point: the store, the Slack client and the
   * panel's URL are three things a job would otherwise have to be handed, and a job holding a Slack
   * client is a job a Slack outage can fail — the FR-141 failure the notify layer is shaped against.
   */
  readonly notifier: WorkflowNotifier
}

/**
 * Ports a deployment or a test supplies instead of the ones built from the environment.
 *
 * Absent overrides are built here; a supplied one is used verbatim, including the database handle —
 * which is how a test assembles the real context without opening a pool.
 */
export interface ControlPlaneContextOverrides {
  readonly db?: SisyphusDatabase
  readonly compute?: ComputeProvisioner
  readonly objectStore?: ObjectStore
  readonly schedules?: ScheduleRegistry
  readonly connectors?: ConnectorRegistry
  readonly redactor?: PromptRedactor
  readonly readCredential?: (secretArn: string) => Promise<string>
  readonly notifier?: WorkflowNotifier
}

export interface ControlPlaneContextOptions extends ControlPlaneContextOverrides {
  readonly env: ControlPlaneEnv
}

/**
 * Assemble the context one invocation runs against.
 *
 * The pool comes from {@link getDatabaseClient}, which holds it on the module and hands the same one
 * back: a Lambda container serves many invocations, and one pool per invocation exhausts RDS long
 * before it exhausts anything else. It is deliberately never closed here for the same reason — the
 * next invocation on a warm container is the one that would find it gone.
 *
 * @param options - The validated environment, plus any port the deployment supplies itself.
 */
export const createControlPlaneContext = (
  options: ControlPlaneContextOptions,
): ControlPlaneContext => {
  const { env } = options
  const region = env.AWS_REGION

  const db = options.db ?? getDatabaseClient({ connectionString: env.DATABASE_URL }).db

  const compute =
    options.compute ??
    createEc2ComputeProvisioner({
      client: new EC2Client({ region }),
      configuration: {
        amiId: env.SISYPHUS_EXECUTOR_AMI_ID,
        instanceProfileArn: env.SISYPHUS_EXECUTOR_INSTANCE_PROFILE_ARN,
        subnetIds: env.SISYPHUS_EXECUTOR_SUBNET_IDS,
        securityGroupIds: env.SISYPHUS_EXECUTOR_SECURITY_GROUP_IDS,
        stage: env.SISYPHUS_STAGE,
      },
    })

  const objectStore =
    options.objectStore ?? createS3ObjectStore({ client: new S3Client({ region }) })

  const schedules =
    options.schedules ??
    createEventBridgeScheduleRegistry({
      client: new SchedulerClient({ region }),
      configuration: {
        groupName: env.SISYPHUS_SCHEDULE_GROUP_NAME,
        targetArn: env.SISYPHUS_SCHEDULER_TARGET_ARN,
        roleArn: env.SISYPHUS_SCHEDULER_ROLE_ARN,
      },
    })

  const readCredential =
    options.readCredential ??
    createSecretsManagerReader({ client: new SecretsManagerClient({ region }) }).read

  const ceiling = env.SISYPHUS_CONCURRENCY_CEILING

  const starter = createWorkflowStarter({
    db,
    compute,
    machineSurfaceUrl: env.SISYPHUS_MACHINE_SURFACE_URL,
    credentialSecret: env.SISYPHUS_MACHINE_CREDENTIAL_SECRET,
  })

  return {
    db,
    compute,
    objectStore,
    schedules,
    connectors: options.connectors ?? createRegisteredConnectorRegistry(),
    redactor: options.redactor ?? createRefusingPromptRedactor(),
    readCredential,
    buckets: {
      logs: env.SISYPHUS_LOGS_BUCKET,
      artifacts: env.SISYPHUS_ARTIFACTS_BUCKET,
      snapshots: env.SISYPHUS_SNAPSHOTS_BUCKET,
    },
    ceiling,
    machineSurfaceUrl: env.SISYPHUS_MACHINE_SURFACE_URL,
    credentialSecret: env.SISYPHUS_MACHINE_CREDENTIAL_SECRET,
    bootstrapAdminEmails: env.SISYPHUS_BOOTSTRAP_ADMIN_EMAILS,
    starter,
    // Built here rather than in the job that needs it, so `SISYPHUS_SLACK_BOT_TOKEN` and
    // `SISYPHUS_PANEL_URL` are read in exactly one place and no job is given a way to reach Slack.
    // `WebClient` opens no connection at construction, so this costs nothing on an invocation that
    // never notifies.
    notifier:
      options.notifier ??
      createWorkflowNotifier({
        store: createNotificationStore({ db }),
        messenger: createWebApiSlackMessenger({
          client: new WebClient(env.SISYPHUS_SLACK_BOT_TOKEN),
        }),
        panel: { baseUrl: env.SISYPHUS_PANEL_URL },
      }),
    // The drain the *other* jobs run after they free a slot. It is deliberately not
    // `runDrainQueue`: teardown and the reconciler report a drain that threw rather than failing on
    // it, and the outcome envelope would hide the throw they are meant to report.
    queueDrain: {
      drain: async () => {
        await drainQueue({ db, ceiling, starter })
      },
    },
  }
}
