import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ElapsedReadout } from './elapsed-readout'

describe('ElapsedReadout', () => {
  it('opens at zero, so the first frame and the server render agree', () => {
    const markup = renderToStaticMarkup(<ElapsedReadout verb="Deactivating" startedAt={1000} />)

    expect(markup).toContain('Deactivating 0:00')
  })

  it('shows no spinner, because a readout is what replaces one', () => {
    const markup = renderToStaticMarkup(<ElapsedReadout verb="Revoking" startedAt={0} />)

    expect(markup).not.toMatch(/spinner|animate-spin|role="progressbar"/)
  })

  it('asks for tabular figures so the seconds column does not jitter', () => {
    expect(renderToStaticMarkup(<ElapsedReadout verb="Issuing" startedAt={0} />)).toContain(
      'tabular-nums',
    )
  })

  it('sets no mono type token, because a button label is sentence-case Archivo', () => {
    const markup = renderToStaticMarkup(<ElapsedReadout verb="Issuing" startedAt={0} />)

    expect(markup).not.toContain('type-label-mono')
    expect(markup).not.toContain('type-data-mono')
  })
})
