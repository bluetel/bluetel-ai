import type { JiraRestClient } from './client'
import type { ResolvedJiraConfig } from './config'
import type { PlatformIdentity } from './is-platform-authored'

/**
 * Working out which identity is Sisyphus's own (FR-161).
 *
 * Everything downstream of this turns on it. The platform comments on tickets it picks up, skips
 * and finishes (FR-142, FR-143, FR-144), and a ticket's comments go into the next prompt (FR-159).
 * If the platform's identity is unknown, none of its own comments can be recognised, so the second
 * run on a ticket is told to do the work *and* handed Sisyphus's account of having done it — and
 * the third run gets both, and so on. The failure compounds rather than showing up once.
 *
 * ## Configured wins over derived, and neither may be absent
 *
 * The credential's own account is the obvious answer and the default one. It is not the *first*
 * answer, because a credential rotated to a different service account would stop recognising
 * comments the old account posted — the loop reopens on every ticket with history. An explicitly
 * configured identity survives that, so it is preferred where an admin has set one.
 *
 * Where neither is available this **throws**. That is the whole point: the alternative is a tick
 * that quietly treats every one of Sisyphus's own comments as human input.
 */

export class UnknownPlatformIdentityError extends Error {
  constructor() {
    super(
      'The Jira credential resolves to no account id or email, and no service account is ' +
        'configured. Sisyphus cannot tell its own comments apart from a human’s, so the tick is ' +
        'refused rather than feeding its own write-back back into the next prompt (FR-161).',
    )
    this.name = 'UnknownPlatformIdentityError'
  }
}

const isIdentifiable = (identity: PlatformIdentity): boolean =>
  identity.accountId !== undefined || identity.emailAddress !== undefined

const withoutEmpties = (identity: {
  accountId?: string | null
  emailAddress?: string | null
}): PlatformIdentity => ({
  ...(identity.accountId ? { accountId: identity.accountId } : {}),
  ...(identity.emailAddress ? { emailAddress: identity.emailAddress } : {}),
})

/**
 * @param config - The board configuration, which may name the service account explicitly.
 * @param client - Used only when it does not.
 * @returns The identity whose comments are the platform's own.
 * @throws {UnknownPlatformIdentityError} When no identity can be established.
 */
export const resolvePlatformIdentity = async (
  config: ResolvedJiraConfig,
  client: JiraRestClient,
): Promise<PlatformIdentity> => {
  const configured = withoutEmpties(config.serviceAccount ?? {})

  if (isIdentifiable(configured)) {
    return configured
  }

  const derived = withoutEmpties(await client.currentUser())

  if (!isIdentifiable(derived)) {
    throw new UnknownPlatformIdentityError()
  }

  return derived
}
