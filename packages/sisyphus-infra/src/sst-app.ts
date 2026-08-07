/**
 * The stage vocabulary, and the one teardown decision the three deployables must
 * not disagree about.
 *
 * Removal policy is here rather than in each config for the same reason bucket
 * retention is: three deployables each spelling out their own policy are three
 * chances to disagree, and the disagreement only shows up the day somebody tears
 * a stage down. A deploy stage retains its resources; anything else — a personal
 * stage, a review stage — removes them, because a personal stage that cannot be
 * torn down is a stage nobody deletes.
 *
 * Everything here is plain data derived from a stage string. The config file
 * spreads {@link getStageRemoval} into the object it returns from `app()`; the
 * shape of that object is the deployment tool's own type and is not restated
 * here (FR-066).
 */

import { getPlainStage } from './get-plain-stage'

/** The only stages CI deploys, and the only ones that retain their resources. */
export const DEPLOY_STAGES = ['production', 'staging'] as const

export type DeployStage = (typeof DEPLOY_STAGES)[number]

export const isDeployStage = (stage: string): stage is DeployStage =>
  (DEPLOY_STAGES as readonly string[]).includes(stage)

/** The one stage whose resources are sized, backed up and protected differently. */
export const PRODUCTION_STAGE = 'production'

/**
 * Whether a stage is production, decided from the **plain** stage so
 * `production-bootstrap` and `production-website` answer as `production` does.
 * Every "is this production?" test routes through here (FR-202).
 */
export const isProductionStage = (sstStage: string): boolean =>
  getPlainStage(sstStage) === PRODUCTION_STAGE

/** Matches `deploy.yml`'s `vars.AWS_REGION || 'eu-west-2'` fallback. */
export const DEFAULT_AWS_REGION = 'eu-west-2'

export type SstRemovalPolicy = 'remove' | 'retain'

/** What a stage does when its stack is torn down. */
export interface StageRemoval {
  readonly removal: SstRemovalPolicy
  /** Production alone refuses a destructive update without an explicit unprotect. */
  readonly protect: boolean
}

/**
 * The teardown policy for one stage, spread into the object a deployable's
 * `app()` returns.
 *
 * The plain stage decides it, so `production-bootstrap` is protected exactly as
 * `production` is — the bootstrap stage holds the account's identity provider,
 * which is the single resource whose accidental removal breaks every other
 * stage's ability to deploy.
 */
export const getStageRemoval = (sstStage: string): StageRemoval => {
  const stage = getPlainStage(sstStage)

  return {
    removal: isDeployStage(stage) ? 'retain' : 'remove',
    protect: isProductionStage(stage),
  }
}
