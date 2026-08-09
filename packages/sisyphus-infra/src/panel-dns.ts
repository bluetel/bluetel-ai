/**
 * The panel's custom-domain argument, resolved against the shared hosted zone.
 *
 * This is the deploy-time half of `panel-domain.ts`: it looks the zone up, checks
 * both of that module's invariants, and hands the deployment tool a domain pinned
 * to the zone it just checked. The decisions worth asserting — which domain a
 * stage gets, and which names may be created — are next door under test; nothing
 * here restates one (FR-200).
 *
 * `bluetel.co.uk` carries the company's live sites, so three things are
 * deliberate:
 *
 * 1. **The zone is read, never declared.** A lookup keeps it out of stack state
 *    entirely, so no update and no teardown can touch the zone or the records
 *    this repository did not create.
 * 2. **The zone id is passed explicitly.** Given none, the tool's Route 53
 *    adapter searches upwards from the domain for a zone that contains it. It
 *    would land here anyway; pinning makes the target a decision rather than the
 *    result of whichever zones happen to exist.
 * 3. **`override` is off, and off on purpose.** The adapter passes it straight to
 *    `allowOverwrite`, so a name that already exists fails the deploy instead of
 *    being taken over. It is `false` by default and stated anyway: this is the
 *    one line standing between a name collision and a replaced production record,
 *    and it should not be possible to remove it by accident.
 *
 * The record sets that result are the panel's alias for the stage and ACM's
 * validation records, all under `sisyphus.bluetel.co.uk`.
 */

import type { NextjsWebsiteConfig } from './nextjs-website'
import {
  PANEL_DNS_ZONE_NAME,
  assertPanelDnsZone,
  getMissingPanelDnsZoneMessage,
  getPanelDomain,
} from './panel-domain'

export interface PanelDomainConfig {
  /** SST stage name; the plain stage decides the domain. */
  readonly sstStage: string
}

/**
 * Resolves the panel's `domain` argument for a stage, or `undefined` for a stage
 * that has no domain and keeps the tool's generated URL.
 *
 * Async because the zone lookup has to be awaited inside a `try`: only the
 * Promise form of `getZone` lets an absence be caught and re-thrown as something
 * an operator can act on — the same reason `createOidcProvider` awaits its
 * lookup.
 */
export const createPanelDomain = async (
  config: PanelDomainConfig,
): Promise<NextjsWebsiteConfig['domain']> => {
  const name = getPanelDomain(config.sstStage)

  if (name === undefined) {
    return undefined
  }

  const zone = await lookupPanelZone(name)

  // Before any record is declared: the right zone, and a name inside the panel's
  // own namespace rather than a live site's.
  assertPanelDnsZone({ zoneName: zone.name, domain: name })

  return { name, dns: sst.aws.dns({ zone: zone.zoneId, override: false }) }
}

const lookupPanelZone = async (
  domain: string,
): Promise<{ readonly name: string; readonly zoneId: string }> => {
  try {
    const zone = await aws.route53.getZone({ name: PANEL_DNS_ZONE_NAME, privateZone: false })

    return { name: zone.name, zoneId: zone.zoneId }
  } catch {
    throw new Error(getMissingPanelDnsZoneMessage(domain))
  }
}
