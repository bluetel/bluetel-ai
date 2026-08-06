import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { HydrateClient } from './hydration'
import { TRPCReactProvider } from './provider'
import { createQueryClient } from './query-client'

/**
 * `HydrateClient` hands a server-side cache to the client cache, so it is only meaningful inside
 * the provider tree. Rendering it the way a page actually would is also the assertion that the two
 * compose.
 */
const renderInPanel = (children: ReactNode): string =>
  renderToStaticMarkup(
    <TRPCReactProvider siteUrl="https://sisyphus.example.com">{children}</TRPCReactProvider>,
  )

describe('HydrateClient', () => {
  it('renders the subtree it is hydrating', () => {
    const markup = renderInPanel(
      <HydrateClient queryClient={createQueryClient()}>
        <span>workflow</span>
      </HydrateClient>,
    )
    expect(markup).toBe('<span>workflow</span>')
  })

  it('does not throw when the server component prefetched nothing', () => {
    expect(() =>
      renderInPanel(
        <HydrateClient queryClient={createQueryClient()}>
          <span>workflow</span>
        </HydrateClient>,
      ),
    ).not.toThrow()
  })

  it('carries a prefetched result across the boundary', () => {
    const queryClient = createQueryClient()
    queryClient.setQueryData(['workflow', 'list'], [{ id: 'wf_1' }])
    expect(() =>
      renderInPanel(
        <HydrateClient queryClient={queryClient}>
          <span>workflow</span>
        </HydrateClient>,
      ),
    ).not.toThrow()
  })
})
