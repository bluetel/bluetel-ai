/**
 * GitHub Actions OIDC federation — the deploy identity, with no long-lived
 * access key anywhere in CI (FR-068).
 *
 * Two things here are requirements rather than preferences:
 *
 * 1. **Create once, look up everywhere.** AWS permits exactly one identity
 *    provider per issuer URL per account, so the production bootstrap creates it
 *    and every other stage looks it up. The lookup uses the **Promise** form of
 *    `getOpenIdConnectProvider` rather than the output form, because only a
 *    Promise can be awaited inside a `try` — an absence has to be caught in
 *    order to be re-thrown as a message naming the bootstrap step. The raw AWS
 *    "NoSuchEntity" gives a developer nothing to act on.
 *
 * 2. **The branch restriction lives in the trust policy, not here.** GitHub's
 *    `sub` claim is `repo:<org>/<repo>:ref:refs/heads/<branch>`, so conditioning
 *    on it with `StringEquals` means FR-067's protected-branch rule is enforced
 *    by IAM. That document is `buildDeployRoleTrustPolicy` in `policies.ts`,
 *    where it is asserted as data — a wildcard there would deploy perfectly well
 *    and hand every branch production credentials.
 */

import { getResourceIdentifier, type ResourceScope } from './lib'
import { getMissingOidcProviderMessage } from './missing-oidc-provider-message'
import { GITHUB_OIDC_AUDIENCE, GITHUB_OIDC_ISSUER_URL, GITHUB_OIDC_THUMBPRINTS } from './policies'
import { isProductionStage } from './sst-app'

export interface OidcProviderConfig {
  readonly scope: ResourceScope
  /** Plain stage name — production creates the provider, everything else looks it up. */
  readonly stage: string
}

/**
 * Creates the identity provider on production and looks it up everywhere else,
 * answering with its ARN either way.
 *
 * The ARN is an `Input` rather than a `string` because production returns the
 * created resource's unresolved output while every other stage returns the plain
 * string the lookup answered with; a caller composing a policy from it resolves
 * it with `$output(...).apply()`.
 */
export const createOidcProvider = async (
  config: OidcProviderConfig,
): Promise<{ readonly arn: $util.Input<string> }> => {
  if (isProductionStage(config.stage)) {
    const provider = new aws.iam.OpenIdConnectProvider(
      getResourceIdentifier(config.scope, 'github-oidc'),
      {
        url: GITHUB_OIDC_ISSUER_URL,
        clientIdLists: [GITHUB_OIDC_AUDIENCE],
        thumbprintLists: [...GITHUB_OIDC_THUMBPRINTS],
      },
    )

    return { arn: provider.arn }
  }

  try {
    const existing = await aws.iam.getOpenIdConnectProvider({ url: GITHUB_OIDC_ISSUER_URL })

    return { arn: existing.arn }
  } catch {
    throw new Error(getMissingOidcProviderMessage(config.stage))
  }
}
