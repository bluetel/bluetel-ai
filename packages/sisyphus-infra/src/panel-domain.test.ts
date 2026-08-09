import { describe, expect, it } from 'vitest'

import {
  PANEL_DNS_ZONE_NAME,
  PANEL_DOMAIN_ROOT,
  assertPanelDnsZone,
  getMissingPanelDnsZoneMessage,
  getPanelDomain,
  getPanelUrl,
  isPanelDnsName,
} from './panel-domain'

describe('getPanelDomain', () => {
  it('serves production at the domain root and staging under it', () => {
    expect(getPanelDomain('production')).toBe('sisyphus.bluetel.co.uk')
    expect(getPanelDomain('staging')).toBe('staging.sisyphus.bluetel.co.uk')
  })

  it('answers for the plain stage, so an auxiliary stage gets the same domain', () => {
    expect(getPanelDomain('production-website')).toBe('sisyphus.bluetel.co.uk')
    expect(getPanelDomain('staging-website')).toBe('staging.sisyphus.bluetel.co.uk')
  })

  it('gives a personal stage no domain, so it adds no record to the shared zone', () => {
    expect(getPanelDomain('local')).toBeUndefined()
    expect(getPanelDomain('production-like')).toBeUndefined()
    expect(getPanelDomain('')).toBeUndefined()
  })

  it('keeps every stage domain inside the panel namespace', () => {
    for (const stage of ['production', 'staging']) {
      const domain = getPanelDomain(stage)

      expect(domain).toBeDefined()
      expect(isPanelDnsName(domain ?? '')).toBe(true)
    }
  })
})

describe('getPanelUrl', () => {
  it('is the https origin of the stage domain', () => {
    expect(getPanelUrl('production')).toBe('https://sisyphus.bluetel.co.uk')
    expect(getPanelUrl('staging')).toBe('https://staging.sisyphus.bluetel.co.uk')
  })

  it('is absent exactly where the domain is, so the caller falls back to the stage parameter', () => {
    expect(getPanelUrl('local')).toBeUndefined()
  })
})

describe('isPanelDnsName', () => {
  it('admits the panel root and names beneath it', () => {
    expect(isPanelDnsName(PANEL_DOMAIN_ROOT)).toBe(true)
    expect(isPanelDnsName('staging.sisyphus.bluetel.co.uk')).toBe(true)
    // ACM writes its validation record under the name it is validating.
    expect(isPanelDnsName('_acme-challenge.staging.sisyphus.bluetel.co.uk')).toBe(true)
  })

  it('tolerates the trailing dot and casing Route 53 reports', () => {
    expect(isPanelDnsName('Staging.Sisyphus.Bluetel.co.uk.')).toBe(true)
  })

  it('refuses the live sites sharing the zone', () => {
    expect(isPanelDnsName('bluetel.co.uk')).toBe(false)
    expect(isPanelDnsName('www.bluetel.co.uk')).toBe(false)
  })

  it('refuses a sibling name that merely ends with the panel root', () => {
    // The trap a plain `endsWith` falls into: a different site's name.
    expect(isPanelDnsName('not-sisyphus.bluetel.co.uk')).toBe(false)
  })
})

describe('assertPanelDnsZone', () => {
  it('accepts the shared zone for both stage domains', () => {
    for (const domain of ['sisyphus.bluetel.co.uk', 'staging.sisyphus.bluetel.co.uk']) {
      expect(() => assertPanelDnsZone({ zoneName: 'bluetel.co.uk.', domain })).not.toThrow()
    }
  })

  it('refuses a zone that is not the one the panel writes into', () => {
    expect(() =>
      assertPanelDnsZone({ zoneName: 'co.uk', domain: 'sisyphus.bluetel.co.uk' }),
    ).toThrow(/Refusing to create DNS records in hosted zone "co\.uk"/)

    expect(() =>
      assertPanelDnsZone({ zoneName: 'bluetel.com', domain: 'sisyphus.bluetel.co.uk' }),
    ).toThrow(/Refusing to create DNS records in hosted zone/)
  })

  it('refuses a name outside the panel namespace, which the zone would otherwise accept', () => {
    expect(() =>
      assertPanelDnsZone({ zoneName: 'bluetel.co.uk', domain: 'www.bluetel.co.uk' }),
    ).toThrow(/may only create names under "sisyphus\.bluetel\.co\.uk"/)

    expect(() =>
      assertPanelDnsZone({ zoneName: 'bluetel.co.uk', domain: 'bluetel.co.uk' }),
    ).toThrow(/may only create names under/)

    expect(() =>
      assertPanelDnsZone({ zoneName: 'bluetel.co.uk', domain: 'not-sisyphus.bluetel.co.uk' }),
    ).toThrow(/may only create names under/)
  })

  it('agrees with the domains the stages actually deploy', () => {
    for (const stage of ['production', 'staging']) {
      const domain = getPanelDomain(stage)

      expect(() =>
        assertPanelDnsZone({ zoneName: PANEL_DNS_ZONE_NAME, domain: domain ?? '' }),
      ).not.toThrow()
    }
  })
})

describe('getMissingPanelDnsZoneMessage', () => {
  it('names the zone, the domain, and that no other zone is substituted', () => {
    const message = getMissingPanelDnsZoneMessage('staging.sisyphus.bluetel.co.uk')

    expect(message).toContain(PANEL_DNS_ZONE_NAME)
    expect(message).toContain('staging.sisyphus.bluetel.co.uk')
    expect(message).toContain('No other zone will be used')
  })

  it('does not suggest creating the zone, which this repository does not own', () => {
    expect(getMissingPanelDnsZoneMessage('sisyphus.bluetel.co.uk')).toContain(
      'not created or managed by this repository',
    )
  })
})
