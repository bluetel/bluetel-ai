import dns from 'node:dns'

/**
 * Falls back to a public resolver when the system resolver cannot answer.
 *
 * Some operators' machines route all DNS through a VPN-style resolver (observed with Tailscale's
 * MagicDNS) that answers "no records" for a public AWS hostname the tunnel's own routes can
 * otherwise reach — `sst tunnel` adds routes for the VPC's private subnets, but never touches DNS,
 * so a resolver that cannot see the public internet still cannot resolve the RDS endpoint into the
 * private IP those routes cover. The system resolver is tried first, so this changes nothing for
 * an operator whose DNS already works.
 */

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address?: string | dns.LookupAddress[],
  family?: number,
) => void

/**
 * The one shape this module needs out of `dns.lookup` — always called with an options object.
 * `dns.lookup`'s real type is a five-way overload keyed on how many arguments are passed and
 * whether the callback wants one address or all of them; pinning a single shape here, and casting
 * onto and off of the real export at the two points that touch it, keeps the rest of this module
 * free of that overload resolution.
 */
type SimpleLookup = (hostname: string, options: dns.LookupOptions, callback: LookupCallback) => void

const PUBLIC_DNS_SERVERS = ['8.8.8.8', '1.1.1.1']

export interface PublicDnsFallbackOptions {
  /** Defaults to `dns.lookup`. Overridable so tests never touch the real resolver. */
  readonly systemLookup?: SimpleLookup
  /** Defaults to a `dns.promises.Resolver` pointed at `PUBLIC_DNS_SERVERS`. */
  readonly resolvePublicly?: (hostname: string) => Promise<string[]>
}

const defaultPublicResolver = (): ((hostname: string) => Promise<string[]>) => {
  const resolver = new dns.promises.Resolver()
  resolver.setServers(PUBLIC_DNS_SERVERS)
  return (hostname) => resolver.resolve4(hostname)
}

/**
 * Installs the fallback on `dns.lookup` and returns a function that restores the original.
 *
 * Every caller must restore it: this patches a process-wide built-in, and leaving it in place
 * would mask a genuinely broken hostname in whatever runs after the migration.
 */
export const installPublicDnsFallback = (options: PublicDnsFallbackOptions = {}): (() => void) => {
  const originalLookup = dns.lookup
  const systemLookup = options.systemLookup ?? (originalLookup as unknown as SimpleLookup)
  const resolvePublicly = options.resolvePublicly ?? defaultPublicResolver()

  const fallbackLookup: SimpleLookup = (hostname, lookupOptions, callback) => {
    systemLookup(hostname, lookupOptions, (systemError, address, family) => {
      if (!systemError) {
        callback(null, address, family)
        return
      }

      resolvePublicly(hostname).then(
        (addresses) => {
          if (addresses.length === 0) {
            callback(systemError)
            return
          }
          callback(
            null,
            lookupOptions.all === true
              ? addresses.map((resolved) => ({ address: resolved, family: 4 }))
              : addresses[0],
            4,
          )
        },
        () => {
          callback(systemError)
        },
      )
    })
  }

  dns.lookup = fallbackLookup as unknown as typeof dns.lookup

  return () => {
    dns.lookup = originalLookup
  }
}
