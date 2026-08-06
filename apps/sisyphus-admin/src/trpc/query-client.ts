import { defaultShouldDehydrateQuery, QueryClient } from '@tanstack/react-query'
import superjson from 'superjson'

/**
 * How long a query's data is considered fresh before a refetch is worth doing.
 *
 * Thirty seconds is the console's shared default: the fleet view and the workflow detail are read
 * many times a day and a run does not change state every second.
 *
 * It is a **default**, not a policy — `staleTime` is settable per query, which is what the log
 * viewer (T077) needs, since a live tail is worthless if it is thirty seconds behind. Baking the
 * value into the client rather than into the defaults would have made that impossible without
 * a second client.
 */
export const DEFAULT_STALE_TIME_MS = 30_000

/**
 * A `QueryClient` configured for the panel.
 *
 * `superjson` on both sides of hydration, because the contract's transformer is `superjson`: a
 * `Date` or a numeric column that survived the wire would otherwise turn back into a string as it
 * crossed from the server render into the client cache.
 *
 * Pending queries are dehydrated too, so a server component can start a fetch and let the client
 * pick up the same promise rather than issuing it a second time.
 */
export const createQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: DEFAULT_STALE_TIME_MS,
      },
      dehydrate: {
        serializeData: superjson.serialize,
        shouldDehydrateQuery: (query) =>
          defaultShouldDehydrateQuery(query) || query.state.status === 'pending',
      },
      hydrate: {
        deserializeData: superjson.deserialize,
      },
    },
  })

/**
 * The browser's single client. Undefined on the server, where every request gets a fresh one.
 */
let browserQueryClient: QueryClient | undefined

/**
 * The `QueryClient` for the current realm.
 *
 * On the server this is a **new** client every call. That is not an optimisation oversight: a
 * shared server-side cache would let one operator's request serve another operator's data, and this
 * console is access-scoped per profile (FR-190). In the browser the client is a singleton, so a
 * re-render or a suspended boundary does not throw the cache away mid-navigation.
 */
export const getQueryClient = (): QueryClient => {
  if (typeof window === 'undefined') return createQueryClient()
  browserQueryClient ??= createQueryClient()
  return browserQueryClient
}
