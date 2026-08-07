/**
 * The message a stage gets when the GitHub Actions identity provider has not
 * been bootstrapped.
 *
 * This is a diagnostic string, not a policy document, so it does not belong in
 * `policies.ts` — but it is the whole of what FR-068 asks for beyond the lookup
 * itself ("failing with an explicit message naming the bootstrap step"), and the
 * construct that rethrows it is deploy-verified. So it lives here, on its own,
 * under test: the message must name the stage that failed and the command that
 * fixes it, because "NoSuchEntity" names neither.
 */

import { GITHUB_OIDC_ISSUER_URL } from './policies'
import { PRODUCTION_STAGE } from './sst-app'

export const getMissingOidcProviderMessage = (stage: string): string =>
  `GitHub Actions OIDC provider "${GITHUB_OIDC_ISSUER_URL}" was not found in this AWS account, ` +
  `so stage "${stage}" cannot be bootstrapped. The provider is created once, by the production ` +
  `bootstrap: run \`pnpm nx run sisyphus-admin:bootstrap --configuration=${PRODUCTION_STAGE}\` ` +
  `first, then re-run this bootstrap.`
