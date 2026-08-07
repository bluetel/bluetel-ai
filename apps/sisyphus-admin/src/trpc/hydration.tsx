import { dehydrate, HydrationBoundary, type QueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'

interface HydrateClientProps {
  /**
   * The request's query client, from `getQueryClient()` in the server component that prefetched.
   *
   * Passed explicitly rather than resolved here, because a React-cached per-request client is a
   * server-only API and this component has to stay importable from the same barrel a client
   * component imports.
   */
  queryClient: QueryClient
  children: ReactNode
}

/**
 * The RSC half of the data flow: hand a server component's prefetched cache to the client.
 *
 * A server component fetches into `getQueryClient()`, wraps its subtree in this, and the matching
 * `useQuery` on the client picks the data up out of the hydrated cache instead of issuing a second
 * request on mount. The `superjson` de/serialisation configured on the client is what makes the
 * round trip type-preserving.
 */
export const HydrateClient = ({ queryClient, children }: HydrateClientProps) => (
  <HydrationBoundary state={dehydrate(queryClient)}>{children}</HydrationBoundary>
)
