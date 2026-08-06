'use client'

import { QueryClientProvider } from '@tanstack/react-query'
import { httpBatchLink } from '@trpc/client'
import { type ReactNode, useState } from 'react'
import superjson from 'superjson'

import { api } from './api'
import { resolveTrpcUrl } from './base-url'
import { getQueryClient } from './query-client'

interface TRPCReactProviderProps {
  /**
   * Absolute origin of the panel, read from the validated environment by the server component that
   * mounts this. Passed in rather than imported so the provider stays testable and the environment
   * is resolved in exactly one place.
   */
  siteUrl: string
  children: ReactNode
}

/**
 * Mounts the tRPC client and its query cache for the whole panel.
 *
 * `superjson` is set on the link rather than on the client root, which is where tRPC v11 wants it,
 * and it matches the transformer the router was created with — a mismatch here turns every `Date`
 * into a string somewhere in the middle of a component.
 *
 * The client is built inside `useState` so it survives re-renders; the query client comes from
 * `getQueryClient`, which is a singleton in the browser and a fresh instance per request on the
 * server.
 */
export const TRPCReactProvider = ({ siteUrl, children }: TRPCReactProviderProps) => {
  const queryClient = getQueryClient()
  const [trpcClient] = useState(() =>
    api.createClient({
      links: [
        httpBatchLink({
          url: resolveTrpcUrl(siteUrl),
          transformer: superjson,
        }),
      ],
    }),
  )

  return (
    <api.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </api.Provider>
  )
}
