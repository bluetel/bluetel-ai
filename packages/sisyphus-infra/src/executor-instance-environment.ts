/**
 * **The executor instance environment — what a launched instance is configured with, and who
 * produces it (T238, FR-075, FR-202).**
 *
 * ---------------------------------------------------------------------------
 * What this is
 * ---------------------------------------------------------------------------
 * `apps/sisyphus-executor/src/env-schemas.ts` declares the values an instance needs **regardless of
 * which job it happens to be running**: the region, the stage, the machine surface's base URL, the
 * code host's API base, and the four bucket names. Every one of them is required, and the executor
 * validates the lot at boot precisely so a missing one fails naming the variable rather than
 * surfacing as `undefined` halfway through bootstrap.
 *
 * Until this module existed, **nothing in this repository produced any of them.** The job envelope
 * carries job configuration and deliberately carries nothing else (`jobs/job-envelope.ts`), the AMI
 * is stage-agnostic so it cannot carry a stage's bucket names, and the launch unit on that AMI had
 * no source to read an environment from. `SISYPHUS_FORGE_API_URL` was the variable that made the
 * hole visible — it was added by T229 and left with a note saying an operator must "set it on the
 * stage and in the launch unit" — but it was never alone in the hole. This module is the answer for
 * all seven.
 *
 * ---------------------------------------------------------------------------
 * Why it is a published parameter rather than a value on the launch
 * ---------------------------------------------------------------------------
 * The control plane declines to carry the forge's API base on the job envelope, and it is right to:
 * see `jobs/start-workflow.ts`, where `StartWorkflowDependencies.machineSurfaceUrl` explains that a
 * URL identical for every run on a stage is *instance* configuration, not *job* configuration. User
 * data is the envelope's channel and putting stage-wide configuration into it would mean every
 * launch re-stating a constant, in a 16 KiB budget whose only unbounded field is the prompt.
 *
 * So the values travel the way the executor release already travels: the executor's own stack
 * publishes them to Parameter Store under `/sisyphus/<stage>/executor/...`, and the instance's
 * launch unit reads that path at boot exactly as it reads the release key in order to know what to
 * run. One parameter, `.env`-shaped, parseable by `parseEnvContent` — which is the same shape and
 * the same parser as the operator-populated configuration blob, so the launch unit needs no format
 * of its own.
 *
 * That also fixes the ownership question T238 asks, which is the half that matters more than the
 * mechanism. The **producer** is the executor's application stack, because that is the stack that
 * already knows a stage's bucket names and already publishes to this path. The **owner** of the two
 * values a stack cannot derive — the machine surface's URL and the forge's API base — is the
 * stage's deploy-time configuration blob at `/sisyphus/<stage>/executor/env`, populated by an
 * operator and deliberately not committed (FR-202). {@link buildExecutorInstanceEnvironment}
 * refuses to build an environment without them, so a stage that has not been given a forge URL
 * **fails its deploy naming the variable**, rather than deploying cleanly and failing the first
 * real run at boot with the same name several hours later.
 *
 * ---------------------------------------------------------------------------
 * What this does not do, stated so it is not mistaken for done
 * ---------------------------------------------------------------------------
 * The runner role grants no `ssm:GetParameter` — see `buildRunnerPolicy` in `policies.ts`, whose
 * statements are S3, Session Manager and nothing else. That is a pre-existing gap rather than one
 * this module introduces: `/sisyphus/<stage>/executor/release-key` has been published for the same
 * reader since the executor's stack was written, and is unreadable by the same identity for the
 * same reason. The two are one fix, in one place, and it is a change to `RunnerPolicyConfig`'s
 * shape rather than to anything here. Recorded at the producer so the next reader of this file
 * finds it rather than discovering it on an instance.
 *
 * ---------------------------------------------------------------------------
 * Why the pure part is here and the resource is not
 * ---------------------------------------------------------------------------
 * The package note in `index.ts` draws the line: constructs are unit-tested by deploying them, and
 * what gets tested directly is the decision a construct reads — a name, a path, a validation. All
 * of that is here, and `sst.config.ts` does nothing but hand the result to `aws.ssm.Parameter`. A
 * wrong bucket name or an admitted-but-empty forge URL deploys perfectly well and reports nothing,
 * which is exactly the class of defect FR-200 keeps assertable.
 */

import { getPlainStage } from './get-plain-stage'
import type { ObjectClass } from './retention'

/**
 * The Parameter Store path a stage's executor instance environment is published to.
 *
 * A sibling of `/sisyphus/<stage>/executor/release-key`, and read by the same reader for the same
 * reason: the launch unit needs to know what to run and what to run it with, and neither can be
 * baked into a stage-agnostic AMI. Built from the plain stage so `<stage>-bootstrap` and
 * `<stage>-website` resolve the same entry, as every other path in this package does.
 *
 * Not a `SecureString`, and that is a claim rather than an oversight: nothing in
 * {@link buildExecutorInstanceEnvironment} is a credential. Two URLs, a region, a stage name and
 * four bucket names — every one of which is already visible in an instance's tags, its IAM policy
 * or its network traffic. The credentials an instance needs arrive by three other routes on
 * purpose: the workflow-scoped one in the envelope, the agent's own from the machine surface, and
 * the code host's from the setup bundle (FR-037, FR-075). If a value ever needs encrypting to go
 * here, it does not belong here.
 *
 * @example
 * getExecutorInstanceEnvironmentParameterName('production-bootstrap')
 * // → '/sisyphus/production/executor/instance-environment'
 */
export const getExecutorInstanceEnvironmentParameterName = (stage: string): string =>
  `/sisyphus/${getPlainStage(stage)}/executor/instance-environment`

/**
 * The variables the executor's stack cannot derive and must be given.
 *
 * Both are URLs of things outside this repository, so no naming helper can produce them and no
 * stack output holds them; they are typed into the stage's configuration blob by an operator. They
 * are listed here rather than read ad hoc so that the deploy-time refusal, the doc comment and the
 * test all name the same set.
 *
 * `SISYPHUS_FORGE_API_URL` is the reason this constant exists. It is the base of the code host's
 * REST API — `https://api.github.com`, or a self-hosted equivalent — and the executor's `Forge`
 * implementation cannot open a pull request without it (FR-075). The **credential** for that host
 * is emphatically not here and must never be: the setup bundle installs it and
 * `run/forge-credential.ts` reads it back out of git.
 */
export const REQUIRED_EXECUTOR_STAGE_URLS = [
  'SISYPHUS_MACHINE_SURFACE_URL',
  'SISYPHUS_FORGE_API_URL',
] as const

export type RequiredExecutorStageUrl = (typeof REQUIRED_EXECUTOR_STAGE_URLS)[number]

export interface ExecutorInstanceEnvironmentConfig {
  /** The region the stage is deployed into, and the region the instance's SDK clients take. */
  readonly region: string
  /** The **plain** stage, as `getStackScope(...).stack` yields it. */
  readonly stage: string
  /** From `getBucketNames`, so the instance and the control plane cannot disagree about a name. */
  readonly buckets: Readonly<Record<ObjectClass, string>>
  /**
   * The stage's deploy-time configuration, already parsed — `readEnvRecord(process.env)` at a
   * deploy call site, after `fetchSsmParamToProcessEnv` has merged the blob in.
   *
   * Typed as possibly-absent per key deliberately. `noUncheckedIndexedAccess` is off in this
   * workspace, so a `Record<string, string>` would type every lookup as a present `string` and the
   * refusal below would be dead code the compiler could prove unreachable — while an operator who
   * has not typed the variable in yet produces exactly that lookup at deploy time.
   */
  readonly configuration: Readonly<Record<string, string | undefined>>
}

/**
 * Read one of {@link REQUIRED_EXECUTOR_STAGE_URLS} out of the stage's configuration, or refuse.
 *
 * The refusal is the point of the function. A variable left out and a variable left blank both
 * produce an instance that boots, validates its environment, and dies naming the variable — but
 * that happens on a machine whose only channel for reporting anything is the machine surface it has
 * not configured yet, several minutes and one EC2 launch after the mistake was made. Failing the
 * deploy puts the same name in front of the person who can act on it, at the moment they are
 * acting.
 *
 * The URL is parsed rather than merely checked for emptiness because the executor's schema is
 * `z.string().url()`: a value that is not a URL fails there just as hard as an absent one, and
 * `api.forge.example` without a scheme is the mistake an operator actually makes.
 */
const requireStageUrl = (
  configuration: Readonly<Record<string, string | undefined>>,
  key: RequiredExecutorStageUrl,
): string => {
  const value = configuration[key]?.trim()

  if (value === undefined || value === '') {
    throw new Error(
      `Missing ${key} in the executor's deploy-time configuration. It is instance configuration ` +
        `rather than job configuration — identical for every run on this stage — so it is set on ` +
        `the stage's parameter and published to the instance environment, never carried on a job ` +
        `envelope. Add it to the executor's configuration entry for this stage and deploy again; ` +
        `without it every instance this stage launches fails at boot naming this variable.`,
    )
  }

  let parsed: URL

  try {
    parsed = new URL(value)
  } catch {
    throw new Error(
      `${key} is set to "${value}", which is not a URL. The executor validates it as one at boot ` +
        `(env-schemas.ts), so a bare host such as "api.forge.example" fails there exactly as an ` +
        `absent value would. Include the scheme.`,
    )
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `${key} is set to "${value}", whose scheme is "${parsed.protocol}". The executor reaches ` +
        `this URL over HTTP; no other scheme can be fetched.`,
    )
  }

  return value
}

/**
 * Build the environment every instance on a stage is launched with.
 *
 * Deliberately **total**: every key the executor's `serverSchemas` declares without a default is
 * produced here, so "the instance environment" is one object with one producer rather than a set of
 * variables each acquired from somewhere different.
 *
 * `SISYPHUS_WORKSPACE_ROOT` is the exception, and by omission rather than by oversight. It defaults
 * to `/workspace` and the executor's schema says a deployed instance must not override it: the
 * agent derives its session directory from the absolute working directory, so an unpinned root
 * makes a restored session unfindable (FR-051). Emitting it here would create a second place the
 * value could be set and therefore a place it could be set wrongly.
 *
 * @param config - The stage's region, plain stage, bucket names and deploy-time configuration.
 * @returns The variables, in the order the executor's schema declares them.
 * @throws If either of {@link REQUIRED_EXECUTOR_STAGE_URLS} is absent or is not an HTTP(S) URL.
 */
export const buildExecutorInstanceEnvironment = (
  config: ExecutorInstanceEnvironmentConfig,
): Record<string, string> => ({
  AWS_REGION: config.region,
  SISYPHUS_STAGE: config.stage,
  SISYPHUS_MACHINE_SURFACE_URL: requireStageUrl(
    config.configuration,
    'SISYPHUS_MACHINE_SURFACE_URL',
  ),
  SISYPHUS_FORGE_API_URL: requireStageUrl(config.configuration, 'SISYPHUS_FORGE_API_URL'),
  SISYPHUS_LOGS_BUCKET: config.buckets.logs,
  SISYPHUS_SNAPSHOTS_BUCKET: config.buckets.snapshots,
  SISYPHUS_BUNDLES_BUCKET: config.buckets.bundles,
  SISYPHUS_ARTIFACTS_BUCKET: config.buckets.artifacts,
})

/**
 * Render the environment as the `.env`-shaped body of the published parameter.
 *
 * The same shape `parseEnvContent` reads, which is the whole reason for the choice: the launch unit
 * parses one format, and it is the format this repository's own deploy path already parses. A JSON
 * object would have been just as expressible and would have obliged whatever reads it on the
 * instance — a shell script, most likely — to acquire a JSON parser in order to export eight
 * variables.
 *
 * Values are not quoted. Every one of them is a region, a stage name, a bucket name or a URL; none
 * can contain a newline, and `parseEnvContent` trims and unquotes on the way back in, so quoting
 * would round-trip identically and read worse in the console.
 */
export const formatExecutorInstanceEnvironment = (
  environment: Readonly<Record<string, string>>,
): string =>
  `${Object.entries(environment)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n`
