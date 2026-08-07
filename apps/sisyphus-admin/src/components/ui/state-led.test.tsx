import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { StateLed } from './state-led'

describe('StateLed', () => {
  it('is a square lamp at the LED size and radius, not a round bullet', () => {
    const markup = renderToStaticMarkup(<StateLed />)
    expect(markup).toContain('h-led')
    expect(markup).toContain('w-led')
    expect(markup).toContain('rounded-led')
    expect(markup).not.toContain('rounded-full')
  })

  it('takes its colour from the chip around it rather than from a prop', () => {
    expect(renderToStaticMarkup(<StateLed />)).toContain('bg-current')
  })

  it('holds steady by default', () => {
    const markup = renderToStaticMarkup(<StateLed />)
    expect(markup).not.toContain('animate-led-pulse')
    expect(markup).toContain('data-pulse="false"')
  })

  it('pulses only when told a machine is working', () => {
    const markup = renderToStaticMarkup(<StateLed pulse />)
    expect(markup).toContain('animate-led-pulse')
    expect(markup).toContain('data-pulse="true"')
  })

  it('is decorative, because the readout beside it already says the state in words', () => {
    expect(renderToStaticMarkup(<StateLed pulse />)).toContain('aria-hidden="true"')
  })
})
