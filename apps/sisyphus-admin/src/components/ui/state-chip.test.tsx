import { WORKFLOW_STATES } from '@bluetel-ai/sisyphus-api/client'
import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { StateChip } from './state-chip'
import { WORKFLOW_STATE_PRESENTATION } from './workflow-state-presentation'

describe('StateChip', () => {
  it.each(WORKFLOW_STATES)('derives the colour of %s from the state alone', (state) => {
    const markup = renderToStaticMarkup(<StateChip state={state} />)
    expect(markup).toContain(`text-${WORKFLOW_STATE_PRESENTATION[state].tone}`)
  })

  it.each(WORKFLOW_STATES)(
    'reports %s on the element, so the state is readable from the DOM',
    (state) => {
      expect(renderToStaticMarkup(<StateChip state={state} />)).toContain(`data-state="${state}"`)
    },
  )

  it('renders a lamp and a readout', () => {
    const markup = renderToStaticMarkup(<StateChip state="running" />)
    expect(markup).toContain('h-led')
    expect(markup).toContain('running')
  })

  it('pulses the lamp for a state in which a machine is working', () => {
    expect(renderToStaticMarkup(<StateChip state="running" />)).toContain('animate-led-pulse')
  })

  it('holds the lamp steady for a state in which nothing is running', () => {
    expect(renderToStaticMarkup(<StateChip state="paused" />)).not.toContain('animate-led-pulse')
    expect(renderToStaticMarkup(<StateChip state="failed" />)).not.toContain('animate-led-pulse')
  })

  it('falls back to a graphite idle chip when there is no state behind it', () => {
    const markup = renderToStaticMarkup(<StateChip />)
    expect(markup).toContain('text-graphite')
    expect(markup).toContain('data-state="idle"')
    expect(markup).toContain('idle')
  })

  it('lets a caller extend the readout without touching the colour', () => {
    const markup = renderToStaticMarkup(<StateChip state="running">running 04:21</StateChip>)
    expect(markup).toContain('running 04:21')
    expect(markup).toContain('text-amber')
  })

  /**
   * The chip accepts no colour, tone or class prop. This asserts the consequence at run time: props
   * that are not on the interface are dropped rather than reaching the element, so there is no way
   * to repaint a failed run in the brand colour.
   */
  it('ignores a colour smuggled in as an unknown prop', () => {
    const rogue = {
      tone: 'signal',
      className: 'text-signal',
      style: { color: 'green' },
    } as unknown as ComponentProps<typeof StateChip>
    const markup = renderToStaticMarkup(<StateChip state="failed" {...rogue} />)
    expect(markup).toContain('text-rust')
    expect(markup).not.toContain('text-signal')
    expect(markup).not.toContain('green')
  })
})
