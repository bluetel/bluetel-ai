/**
 * The `app()` half of a deployable's `sst.config.ts`, and the types its `run()`
 * half is written against.
 *
 * Removal policy is here rather than in each config for the same reason bucket
 * retention is: three deployables each spelling out their own policy are three
 * chances to disagree, and the disagreement only shows up the day somebody tears
 * a stage down. A deploy stage retains its resources; anything else — a personal
 * stage, a review stage — removes them, because a personal stage that cannot be
 * torn down is a stage nobody deletes.
 *
 * Nothing here imports SST. `SstConfigDefinition` is the shape `$config` takes,
 * declared structurally so a config file typechecks without the generated
 * `.sst/platform/config.d.ts` that only exists after `sst install`. See the note
 * at the top of `index.ts`.
 */

import { getPlainStage } from './get-plain-stage'

/** The only stages CI deploys, and the only ones that retain their resources. */
export const DEPLOY_STAGES = ['production', 'staging'] as const

export type DeployStage = (typeof DEPLOY_STAGES)[number]

export const isDeployStage = (stage: string): stage is DeployStage =>
  (DEPLOY_STAGES as readonly string[]).includes(stage)

/** Matches `deploy.yml`'s `vars.AWS_REGION || 'eu-west-2'` fallback. */
export const DEFAULT_AWS_REGION = 'eu-west-2'

export type SstRemovalPolicy = 'remove' | 'retain'

/** The single argument SST hands `app()`. Only `stage` is depended on here. */
export interface SstAppInput {
  readonly stage: string
}

export interface SstAppConfig {
  readonly name: string
  readonly home: 'aws'
  readonly removal: SstRemovalPolicy
  /** Production alone refuses a destructive update without an explicit unprotect. */
  readonly protect: boolean
  readonly providers: { readonly aws: { readonly region: string } }
}

export interface SstAppOptions {
  /** SST app name — per deployable, and deliberately *not* the resource-name prefix. */
  readonly appName: string
  /** `input.stage`, suffix included. */
  readonly sstStage: string
  readonly region?: string
}

/**
 * The `app()` return value for one deployable.
 *
 * The plain stage decides the policy, so `production-bootstrap` is protected
 * exactly as `production` is — the bootstrap stage holds the account's identity
 * provider, which is the single resource whose accidental removal breaks every
 * other stage's ability to deploy.
 */
export const buildSstApp = (options: SstAppOptions): SstAppConfig => {
  if (options.appName.trim() === '') {
    throw new Error('Cannot build an SST app config without an app name')
  }

  const stage = getPlainStage(options.sstStage)

  return {
    name: options.appName,
    home: 'aws',
    removal: isDeployStage(stage) ? 'retain' : 'remove',
    protect: stage === 'production',
    providers: { aws: { region: options.region ?? DEFAULT_AWS_REGION } },
  }
}

/**
 * The shape `$config` accepts. A config file declares `$config` locally against
 * this type, so the file still typechecks in CI, where `.sst/` does not exist,
 * without widening any app's tsconfig.
 */
export interface SstConfigDefinition<TOutputs> {
  readonly app: (input: SstAppInput) => SstAppConfig
  readonly run: () => Promise<TOutputs>
}
