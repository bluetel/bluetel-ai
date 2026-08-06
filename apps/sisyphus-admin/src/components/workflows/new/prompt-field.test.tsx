import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { PromptField } from './prompt-field'

const noop = () => undefined

const render = (props: Partial<Parameters<typeof PromptField>[0]> = {}) =>
  renderToStaticMarkup(<PromptField value="" onChange={noop} {...props} />)

describe('PromptField', () => {
  it('is multi-line, so the operator can read what they are about to spend money running', () => {
    expect(render()).toContain('<textarea')
  })

  it('labels the control above it and wires the two together', () => {
    const markup = render()
    const labelTarget = /for="([^"]+)"/.exec(markup)?.[1]

    expect(labelTarget).toBeDefined()
    expect(markup).toContain(`id="${String(labelTarget)}"`)
    expect(markup.indexOf('<label')).toBeLessThan(markup.indexOf('<textarea'))
  })

  it('says the prompt is sent as written, because that is what is recorded (FR-065)', () => {
    expect(render()).toContain('sent as written')
  })

  it('reports its own state (FR-023)', () => {
    expect(render()).toContain('data-state="valid"')
    expect(render({ error: { code: 'E_LAUNCH_PROMPT', action: 'Say what to do.' } })).toContain(
      'data-state="invalid"',
    )
  })

  it('renders a refusal with its code and next action, bound to the control (FR-031)', () => {
    const markup = render({ error: { code: 'E_LAUNCH_PROMPT', action: 'Say what to do.' } })
    const describedBy = /aria-describedby="([^"]+)"/.exec(markup)?.[1]

    expect(markup).toContain('E_LAUNCH_PROMPT')
    expect(markup).toContain(`id="${String(describedBy)}"`)
  })

  it('takes its styling from the shared field control rather than restating it (FR-033)', () => {
    expect(render()).toContain('bg-paper')
  })

  it('carries no literal colour, size or radius (SC-015)', () => {
    expect(render()).not.toMatch(/#[0-9a-fA-F]{3,8}|\d+(?:px|rem)/)
  })
})
