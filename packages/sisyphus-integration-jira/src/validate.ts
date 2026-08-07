import type { ValidationCheck, ValidationResult } from '@bluetel-ai/sisyphus-api/contracts'

import type { JiraRestClient, JiraUser } from './client'
import type { JiraIntegrationConfig, ResolvedJiraConfig } from './config'
import { parseJiraConfig } from './config'
import { isPlatformAuthored } from './is-platform-authored'
import { buildDiscoveryJql } from './jql'
import { sanitiseFailure } from './sanitise-failure'

/**
 * The gate for enabling an integration (T114, FR-097).
 *
 * ## Why a shape check is not a validation
 *
 * A configuration can be perfectly well-formed and completely wrong: the right shape around a
 * base URL for a site that was renamed, a token that was revoked last week, a project key with a
 * typo in it. Enabling on the strength of the shape means the failure surfaces as a scheduled
 * tick failing at three in the morning against an empty board, and FR-106 dutifully counting
 * failures towards auto-disabling something that was never going to work. So this **calls Jira**,
 * and an integration whose configuration cannot reach Jira does not enable.
 *
 * ## The four checks, in the order a failure makes the rest meaningless
 *
 * 1. **configuration** — the shape. First, because nothing else can run without it, and it is the
 *    only one that does not need the network.
 * 2. **connectivity** — who the credential authenticates as. The cheapest call that proves the
 *    deployment is reachable *and* the credential is accepted, which are two different failures
 *    with the same symptom if you never ask.
 * 3. **service account** — that the identity whose comments Sisyphus will exclude is the identity
 *    it will comment as. A mismatch here is silent and expensive: every run posts comments that
 *    the next run reads back as task input (FR-161), and nothing looks broken until the prompts
 *    start growing.
 * 4. **discovery** — the actual discovery query, run for a single result. Not a generic ping: the
 *    query this integration will run every tick, so a mistyped project key or a filter naming a
 *    field this deployment does not have fails here, at the moment somebody is looking at it,
 *    rather than on the first tick.
 *
 * ## It does not throw
 *
 * Every failure is a check to show an admin. An exception here would surface in the panel as a
 * stack trace and, worse, might carry the credential out with it — so failures go through
 * `./sanitise-failure` and come back as text.
 */

export const CONFIGURATION_CHECK = 'configuration'
export const CONNECTIVITY_CHECK = 'connectivity'
export const SERVICE_ACCOUNT_CHECK = 'service_account'
export const DISCOVERY_CHECK = 'discovery'

const result = (checks: readonly ValidationCheck[]): ValidationResult => ({
  ok: checks.every((check) => check.ok),
  checks,
})

const describeUser = (user: JiraUser): string =>
  user.accountId ?? user.emailAddress ?? user.displayName ?? 'an unidentifiable account'

/**
 * The identity the platform will exclude from prompts must be the one it comments as.
 *
 * Where an integration names a service account, this is the check that it is the credential's own
 * — the two drifting apart is how FR-161's loop reopens without anything appearing to break.
 * Where it names none, the credential's account is used, so the requirement is simply that there
 * is one.
 */
const serviceAccountCheck = (config: ResolvedJiraConfig, user: JiraUser): ValidationCheck => {
  const configured = config.serviceAccount ?? {}

  if (configured.accountId === undefined && configured.emailAddress === undefined) {
    if (user.accountId === undefined && user.emailAddress === undefined) {
      return {
        name: SERVICE_ACCOUNT_CHECK,
        ok: false,
        detail:
          'The credential resolves to no account id or email address, and no service account is ' +
          'configured. Sisyphus could not tell its own comments from a human’s, and every run ' +
          'would read the previous run’s comments back as task input.',
      }
    }

    return {
      name: SERVICE_ACCOUNT_CHECK,
      ok: true,
      detail: `Sisyphus will comment as, and exclude, ${describeUser(user)}.`,
    }
  }

  if (!isPlatformAuthored(user, configured)) {
    return {
      name: SERVICE_ACCOUNT_CHECK,
      ok: false,
      detail:
        `The credential authenticates as ${describeUser(user)}, which is not the configured ` +
        'service account. Comments posted by this credential would not be recognised as ' +
        'Sisyphus’s own, and would be fed back into the next run’s prompt.',
    }
  }

  return {
    name: SERVICE_ACCOUNT_CHECK,
    ok: true,
    detail: 'The credential authenticates as the configured service account.',
  }
}

/**
 * @param client - The Jira seam, constructed with the credential being validated.
 * @param config - The configuration as the panel holds it, defaults unapplied.
 * @returns Every check, and whether the integration may be enabled.
 */
export const validate = async (
  client: JiraRestClient,
  config: JiraIntegrationConfig,
): Promise<ValidationResult> => {
  const parsed = parseJiraConfig(config)

  if (!parsed.success) {
    return result([
      {
        name: CONFIGURATION_CHECK,
        ok: false,
        detail: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
          .join('; '),
      },
    ])
  }

  const resolved = parsed.data
  const configuration: ValidationCheck = { name: CONFIGURATION_CHECK, ok: true }

  let user: JiraUser
  try {
    user = await client.currentUser()
  } catch (error) {
    // Everything after this would be guesswork, so the remaining checks are not reported as
    // passing — they are not reported at all.
    return result([
      configuration,
      {
        name: CONNECTIVITY_CHECK,
        ok: false,
        detail: `Could not reach ${resolved.baseUrl}: ${sanitiseFailure(error)}`,
      },
    ])
  }

  const connectivity: ValidationCheck = {
    name: CONNECTIVITY_CHECK,
    ok: true,
    detail: `Reached ${resolved.baseUrl} as ${describeUser(user)}.`,
  }

  const serviceAccount = serviceAccountCheck(resolved, user)

  try {
    const page = await client.searchIssues({
      jql: buildDiscoveryJql(resolved),
      startAt: 0,
      maxResults: 1,
    })

    return result([
      configuration,
      connectivity,
      serviceAccount,
      {
        name: DISCOVERY_CHECK,
        ok: true,
        detail: `The discovery query ran; the board currently matches ${
          page.total === undefined ? 'an unreported number of' : String(page.total)
        } tickets.`,
      },
    ])
  } catch (error) {
    return result([
      configuration,
      connectivity,
      serviceAccount,
      {
        name: DISCOVERY_CHECK,
        ok: false,
        detail: `The discovery query was rejected: ${sanitiseFailure(error)}`,
      },
    ])
  }
}
