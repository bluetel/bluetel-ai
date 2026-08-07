import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { LaunchOption } from './launch-select'
import { LaunchSelect } from './launch-select'

const noop = () => undefined

const options: readonly LaunchOption[] = [
  { value: 'delegated', label: 'Delegated' },
  { value: 'autonomous', label: 'Autonomous' },
]

const render = (props: Partial<Parameters<typeof LaunchSelect>[0]> = {}) =>
  renderToStaticMarkup(
    <LaunchSelect
      label="Workflow type"
      value=""
      options={options}
      placeholder="Choose one"
      onChange={noop}
      {...props}
    />,
  )

describe('LaunchSelect', () => {
  it('renders every choice by its label', () => {
    const markup = render()

    expect(markup).toContain('Delegated')
    expect(markup).toContain('Autonomous')
  })

  it('opens on the placeholder, so nothing is chosen by default', () => {
    expect(render()).toContain('Choose one')
  })

  it('labels the control above it, never as a placeholder standing in for a label', () => {
    const markup = render()
    const labelTarget = /for="([^"]+)"/.exec(markup)?.[1]

    expect(labelTarget).toBeDefined()
    expect(markup).toContain(`id="${String(labelTarget)}"`)
    expect(markup.indexOf('<label')).toBeLessThan(markup.indexOf('<select'))
  })

  it('reports its own state, the way every interactive element does (FR-023)', () => {
    expect(render()).toContain('data-state="valid"')
    expect(render()).toContain('aria-invalid="false"')
  })

  it('renders a refusal with its code and next action, bound to the control (FR-031)', () => {
    const markup = render({ error: { code: 'E_LAUNCH_MODEL', action: 'Choose a model.' } })
    const describedBy = /aria-describedby="([^"]+)"/.exec(markup)?.[1]

    expect(markup).toContain('E_LAUNCH_MODEL')
    expect(markup).toContain(`id="${String(describedBy)}"`)
    expect(markup).toContain('data-state="invalid"')
  })

  it('binds the hint when there is no error, so the hint is announced too', () => {
    const markup = render({ hint: 'a workspace is versioned' })
    const describedBy = /aria-describedby="([^"]+)"/.exec(markup)?.[1]

    expect(describedBy).toMatch(/-hint$/)
    expect(markup).toContain('a workspace is versioned')
  })

  it('lets the refusal win over the hint, since the refusal is what to act on', () => {
    const markup = render({
      hint: 'a workspace is versioned',
      error: { code: 'E_LAUNCH_MODEL', action: 'Choose a model.' },
    })

    expect(/aria-describedby="([^"]+)"/.exec(markup)?.[1]).toMatch(/-error$/)
  })

  it('disables itself when asked', () => {
    expect(render({ disabled: true })).toContain('disabled')
  })

  it('takes its styling from the shared field control rather than restating it (FR-033)', () => {
    const markup = render()

    expect(markup).toContain('bg-paper')
    expect(markup).toContain('border-hairline-hi')
  })

  it('carries no literal colour, size or radius (SC-015)', () => {
    expect(render()).not.toMatch(/#[0-9a-fA-F]{3,8}|\d+(?:px|rem)/)
  })
})
