/**
 * GitHub Actions OIDC federation — the deploy identity, with no long-lived
 * access key anywhere in CI (FR-068).
 *
 * Two things here are requirements rather than preferences:
 *
 * 1. **Create once, look up everywhere.** AWS permits exactly one identity
 *    provider per issuer URL per account, so the production bootstrap creates it
 *    and every other stage looks it up. When it is absent the lookup failure is
 *    translated into a message naming the bootstrap step, because the raw AWS
 *    "not found" gives a developer nothing to act on (FR-068).
 *
 * 2. **The branch restriction lives in the trust policy.** GitHub's `sub` claim
 *    is `repo:<org>/<repo>:ref:refs/heads/<branch>`, so conditioning on it with
 *    `StringEquals` means FR-067's protected-branch rule is enforced by IAM. A
 *    pipeline misconfiguration, or a workflow file edited on a feature branch,
 *    cannot obtain deploy credentials. The pipeline's own branch conditions stay
 *    as defence in depth, not as the control.
 */

import {
  POLICY_VERSION,
  getResourceIdentifier,
  type PolicyDocument,
  type ResourceScope,
} from './lib'

export const GITHUB_OIDC_ISSUER_URL = 'https://token.actions.githubusercontent.com'

/** The claim namespace AWS exposes the GitHub token's claims under. */
const GITHUB_OIDC_CLAIM_PREFIX = 'token.actions.githubusercontent.com'

export const GITHUB_OIDC_AUDIENCE = 'sts.amazonaws.com'

/**
 * GitHub's certificate thumbprints. AWS no longer verifies these for the
 * well-known GitHub issuer, but the field is still required on creation.
 */
export const GITHUB_OIDC_THUMBPRINTS: readonly string[] = [
  '6938fd4d98bab03faadb97b34396831e3780aea1',
  '1c58a3a8518e8759bf075b76b750d4f2df264fcd',
]

const PRODUCTION_STAGE = 'production'
const STAGING_STAGE = 'staging'

/**
 * The one branch each deployable stage may be deployed from. Returns
 * `undefined` for any other stage: personal stages are deployed from a
 * developer's own credentials and are deliberately given no CI identity.
 */
export const getDeployBranchRef = (stage: string): string | undefined => {
  if (stage === PRODUCTION_STAGE) {
    return 'refs/heads/main'
  }

  if (stage === STAGING_STAGE) {
    return 'refs/heads/staging'
  }

  return undefined
}

/**
 * The exact `sub` claim a GitHub Actions token must carry to assume the deploy
 * role for `stage`.
 *
 * @example
 * getTrustedSubject('bluetel/universal-react-monorepo', 'production')
 * // → 'repo:bluetel/universal-react-monorepo:ref:refs/heads/main'
 */
export const getTrustedSubject = (githubRepo: string, stage: string): string => {
  const ref = getDeployBranchRef(stage)

  if (ref === undefined) {
    throw new Error(
      `Stage "${stage}" has no protected deploy branch, so no CI deploy role can be issued for it. ` +
        `Only "${PRODUCTION_STAGE}" (refs/heads/main) and "${STAGING_STAGE}" (refs/heads/staging) deploy from CI.`,
    )
  }

  return `repo:${githubRepo}:ref:${ref}`
}

export interface DeployRoleTrustPolicyConfig {
  /** ARN of the identity provider, already resolved from any Pulumi output. */
  readonly oidcProviderArn: string
  /** Repository in `org/repo` form. */
  readonly githubRepo: string
  /** Plain stage name the role deploys. */
  readonly stage: string
}

/**
 * The deploy role's trust policy. `StringEquals` on `sub`, never `StringLike`:
 * a wildcard would trust every branch and every pull-request workflow in the
 * repository, which is the exact failure FR-067 is written against.
 */
export const buildDeployRoleTrustPolicy = (
  config: DeployRoleTrustPolicyConfig,
): PolicyDocument => ({
  Version: POLICY_VERSION,
  Statement: [
    {
      Sid: 'GitHubActionsProtectedBranch',
      Effect: 'Allow',
      Principal: { Federated: [config.oidcProviderArn] },
      Action: ['sts:AssumeRoleWithWebIdentity'],
      Condition: {
        StringEquals: {
          [`${GITHUB_OIDC_CLAIM_PREFIX}:aud`]: [GITHUB_OIDC_AUDIENCE],
          [`${GITHUB_OIDC_CLAIM_PREFIX}:sub`]: [getTrustedSubject(config.githubRepo, config.stage)],
        },
      },
    },
  ],
})

export interface OidcProviderSpecification {
  readonly url: string
  readonly clientIdList: readonly string[]
  readonly thumbprintList: readonly string[]
}

export const buildOidcProviderSpecification = (): OidcProviderSpecification => ({
  url: GITHUB_OIDC_ISSUER_URL,
  clientIdList: [GITHUB_OIDC_AUDIENCE],
  thumbprintList: GITHUB_OIDC_THUMBPRINTS,
})

/**
 * The narrow slice of the SST/Pulumi provider surface this primitive needs.
 * `lookupProvider` is the promise-based `aws.iam.getOpenIdConnectProvider`, used
 * rather than the output-based form so the absence can be caught and explained
 * before Pulumi surfaces a raw AWS error.
 */
export interface OidcProviderSurface<TArn> {
  readonly createProvider: (
    name: string,
    specification: OidcProviderSpecification,
  ) => { readonly arn: TArn }
  readonly lookupProvider: (url: string) => Promise<{ readonly arn: TArn }>
}

export interface OidcProviderConfig {
  readonly scope: ResourceScope
  /** Plain stage name — production creates, everything else looks up. */
  readonly stage: string
}

/**
 * The message a stage gets when the provider has not been bootstrapped. It
 * names the command to run, because "NoSuchEntity" does not.
 */
export const getMissingOidcProviderMessage = (stage: string): string =>
  `GitHub Actions OIDC provider "${GITHUB_OIDC_ISSUER_URL}" was not found in this AWS account, ` +
  `so stage "${stage}" cannot be bootstrapped. The provider is created once, by the production ` +
  `bootstrap: run \`pnpm nx run sisyphus-admin:bootstrap --configuration=${PRODUCTION_STAGE}\` ` +
  `first, then re-run this bootstrap.`

/**
 * Creates the identity provider on production and looks it up everywhere else,
 * returning its ARN either way.
 */
export const resolveOidcProviderArn = async <TArn>(
  surface: OidcProviderSurface<TArn>,
  config: OidcProviderConfig,
): Promise<TArn> => {
  if (config.stage === PRODUCTION_STAGE) {
    return surface.createProvider(
      getResourceIdentifier(config.scope, 'github-oidc'),
      buildOidcProviderSpecification(),
    ).arn
  }

  try {
    const existing = await surface.lookupProvider(GITHUB_OIDC_ISSUER_URL)

    return existing.arn
  } catch {
    throw new Error(getMissingOidcProviderMessage(config.stage))
  }
}
