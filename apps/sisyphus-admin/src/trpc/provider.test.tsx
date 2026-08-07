import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { TRPCReactProvider } from './provider'

describe('TRPCReactProvider', () => {
  it('mounts and renders the panel underneath it', () => {
    const markup = renderToStaticMarkup(
      <TRPCReactProvider siteUrl="https://sisyphus.example.com">
        <span>panel</span>
      </TRPCReactProvider>,
    )
    expect(markup).toBe('<span>panel</span>')
  })

  it('builds a client against the configured origin without throwing', () => {
    expect(() =>
      renderToStaticMarkup(
        <TRPCReactProvider siteUrl="http://localhost:3003">
          <span>panel</span>
        </TRPCReactProvider>,
      ),
    ).not.toThrow()
  })
})
