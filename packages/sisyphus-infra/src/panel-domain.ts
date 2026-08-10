/**
 * The panel's public domain per stage, and the two rules that keep a deploy from
 * disturbing the hosted zone it writes into.
 *
 * ---------------------------------------------------------------------------
 * One zone, shared with the company's live sites
 * ---------------------------------------------------------------------------
 * `bluetel.co.uk` is hosted in this AWS account and carries the company's main
 * site and others. The panel's records are added *into* it — there is no
 * delegated child zone — so what protects those existing records is not
 * separation but two invariants, both enforced before a record is created:
 *
 * 1. **Only names under `sisyphus.bluetel.co.uk`.** {@link assertPanelDnsZone}
 *    refuses any domain outside that namespace. Without it, a stage domain typed
 *    as `www.bluetel.co.uk` is a perfectly valid record in a perfectly valid
 *    zone, aimed at the front page.
 * 2. **Create, never replace.** The zone id is pinned and overwrite is left off,
 *    so a name that already exists fails the deploy instead of being taken over.
 *    Nothing this repository declares can edit a record it did not create.
 *
 * The zone is also only ever *read* — looked up by name, never declared as a
 * resource — so no stack holds it in state and no teardown can remove it or the
 * records it carries. A `sst destroy` removes the panel's own record sets and
 * nothing else.
 *
 * ---------------------------------------------------------------------------
 * Why the zone is pinned explicitly
 * ---------------------------------------------------------------------------
 * Given no zone, the deployment tool's Route 53 adapter resolves a domain by
 * walking it upwards until some hosted zone contains it. That happens to find
 * the right zone here, but it is a search whose result depends on which zones
 * exist at deploy time; pinning the id makes the target a decision this module
 * made rather than one a lookup arrived at.
 *
 * Everything here is plain data derived from a stage string, which is why it is
 * under test while the construct that consumes it is not (FR-200): a wrong
 * domain, or a guard that admits a name outside the Sisyphus namespace, deploys
 * perfectly well and reports nothing.
 */

import { getPlainStage } from './get-plain-stage'
import { isDeployStage, type DeployStage } from './sst-app'

/**
 * The hosted zone the panel's records are created in. Shared with the company's
 * live sites — see the note above before changing anything about how it is used.
 */
export const PANEL_DNS_ZONE_NAME = 'bluetel.co.uk'

/**
 * Production's domain, and the suffix every DNS name this repository creates must
 * sit under. It is the boundary {@link assertPanelDnsZone} enforces inside the
 * shared zone.
 */
export const PANEL_DOMAIN_ROOT = 'sisyphus.bluetel.co.uk'

/**
 * The label each deploy stage is served under. `null` means {@link
 * PANEL_DOMAIN_ROOT} itself, which production takes.
 *
 * Keyed by {@link DeployStage} rather than by `string`, so adding a deploy stage
 * fails to compile here instead of silently deploying it with no domain.
 */
const PANEL_SUBDOMAINS: Readonly<Record<DeployStage, string | null>> = {
  production: null,
  staging: 'staging',
}

/**
 * The panel's domain for a stage, or `undefined` for a stage that has none.
 *
 * Only the two deploy stages get a domain. A personal stage deliberately does
 * not: it would add a record to the shared zone that its own teardown then has to
 * remember to remove. Those stages keep the deployment tool's generated URL,
 * which is what `SISYPHUS_PANEL_URL` carries for them.
 *
 * Derived from the **plain** stage, so `production-website` answers as
 * `production` does.
 *
 * @example
 * getPanelDomain('production')       // → 'sisyphus.bluetel.co.uk'
 * getPanelDomain('staging')          // → 'staging.sisyphus.bluetel.co.uk'
 * getPanelDomain('local')            // → undefined
 */
export const getPanelDomain = (sstStage: string): string | undefined => {
  const stage = getPlainStage(sstStage)

  if (!isDeployStage(stage)) {
    return undefined
  }

  const subdomain = PANEL_SUBDOMAINS[stage]

  return subdomain === null ? PANEL_DOMAIN_ROOT : `${subdomain}.${PANEL_DOMAIN_ROOT}`
}

/**
 * The panel's origin for a stage, or `undefined` for a stage without a domain.
 *
 * This is the string `NEXT_PUBLIC_SITE_URL` and `SISYPHUS_PANEL_URL` are set
 * from on a deploy stage. Both must be the origin the browser actually arrived
 * on: the first resolves Auth.js callbacks, the second is written into Slack
 * messages (FR-137). Deriving them from the same place as the certificate and
 * the DNS record is what stops a sign-in redirecting to an origin the
 * certificate does not cover.
 */
export const getPanelUrl = (sstStage: string): string | undefined => {
  const domain = getPanelDomain(sstStage)

  return domain === undefined ? undefined : `https://${domain}`
}

/** Route 53 reports a zone name as `example.com.`; a domain is written without the root dot. */
const normaliseDnsName = (name: string): string => name.replace(/\.+$/, '').toLowerCase()

/**
 * Whether a DNS name belongs to the panel — that is, whether this repository is
 * allowed to create it.
 *
 * The `.` in the suffix test is the whole point: a plain `endsWith` would admit
 * `not-sisyphus.bluetel.co.uk`, which is a different site's name.
 */
export const isPanelDnsName = (name: string): boolean => {
  const candidate = normaliseDnsName(name)

  return candidate === PANEL_DOMAIN_ROOT || candidate.endsWith(`.${PANEL_DOMAIN_ROOT}`)
}

export interface PanelDnsZoneAssertion {
  /** Zone name as Route 53 reported it, with or without the trailing dot. */
  readonly zoneName: string
  /** The domain records are about to be created for. */
  readonly domain: string
}

/**
 * Refuses to create records unless the zone is the expected one *and* the name
 * sits inside the panel's own namespace.
 *
 * This runs before the first record set is declared, and it is the only thing
 * standing between a mistyped stage domain and a record aimed at a live site:
 * `www.bluetel.co.uk` passes every check the deployment tool makes on its own,
 * because it is a real name inside a real zone.
 */
export const assertPanelDnsZone = (assertion: PanelDnsZoneAssertion): void => {
  const zoneName = normaliseDnsName(assertion.zoneName)
  const domain = normaliseDnsName(assertion.domain)

  if (zoneName !== PANEL_DNS_ZONE_NAME) {
    throw new Error(
      `Refusing to create DNS records in hosted zone "${zoneName}". The panel's records belong in ` +
        `"${PANEL_DNS_ZONE_NAME}"; a different zone means the lookup resolved somewhere this ` +
        `deploy has no business writing.`,
    )
  }

  if (!isPanelDnsName(domain)) {
    throw new Error(
      `Refusing to create a DNS record for "${domain}" in hosted zone "${zoneName}". This zone ` +
        `carries the company's live sites, and the panel may only create names under ` +
        `"${PANEL_DOMAIN_ROOT}".`,
    )
  }
}

/**
 * The message a deploy gets when the hosted zone is not in the account.
 *
 * Under test for the same reason the missing-OIDC-provider message is: Route 53's
 * own "no matching hosted zone found" names neither the zone that was expected
 * nor the fact that the deploy stopped on purpose. The last sentence is the
 * point — an absent zone is a stop, not a cue to go looking for another one.
 */
export const getMissingPanelDnsZoneMessage = (domain: string): string =>
  `Hosted zone "${PANEL_DNS_ZONE_NAME}" was not found in this AWS account, so the panel cannot be ` +
  `served at "${domain}". The zone is not created or managed by this repository — it holds the ` +
  `company's live sites — so this is a sign the deploy is pointed at the wrong account rather ` +
  `than something to fix by creating a zone. No other zone will be used instead.`
