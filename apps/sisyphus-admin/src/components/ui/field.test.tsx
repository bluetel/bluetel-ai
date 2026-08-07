import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Field } from './field'

/** Pull the `for`/`id`/`aria-describedby` triple out of rendered markup. */
const attribute = (markup: string, name: string): string | undefined =>
  new RegExp(`${name}="([^"]+)"`).exec(markup)?.[1]

describe('Field', () => {
  it('puts the label above the control, never inside it as a placeholder', () => {
    const markup = renderToStaticMarkup(<Field label="Prompt" name="prompt" />)
    expect(markup.indexOf('<label')).toBeLessThan(markup.indexOf('<input'))
    expect(markup).not.toContain('placeholder="Prompt"')
  })

  it('binds the label to the control it labels', () => {
    const markup = renderToStaticMarkup(<Field label="Prompt" name="prompt" />)
    const labelTarget = attribute(markup, 'for')
    expect(labelTarget).toBeDefined()
    expect(markup).toContain(`id="${String(labelTarget)}"`)
  })

  it('renders no error and describes nothing when the value is accepted', () => {
    const markup = renderToStaticMarkup(<Field label="Prompt" name="prompt" />)
    expect(markup).not.toContain('role="alert"')
    expect(markup).not.toContain('aria-describedby')
    expect(markup).toContain('data-state="valid"')
  })

  it('marks the control invalid and points it at the error it was given', () => {
    const markup = renderToStaticMarkup(
      <Field
        label="Prompt"
        name="prompt"
        error={{ code: 'E_PROMPT_EMPTY', action: 'Describe the change you want.' }}
      />,
    )
    const describedBy = attribute(markup, 'aria-describedby')
    expect(describedBy).toBeDefined()
    expect(markup).toContain(`id="${String(describedBy)}"`)
    expect(markup).toContain('data-state="invalid"')
    expect(markup).toContain('E_PROMPT_EMPTY')
    expect(markup).toContain('Describe the change you want.')
  })

  it('generates a distinct id per field, so two on one page do not collide', () => {
    const markup = renderToStaticMarkup(
      <div>
        <Field label="Prompt" name="prompt" />
        <Field label="Branch" name="branch" />
      </div>,
    )
    const ids = [...markup.matchAll(/for="([^"]+)"/g)].map(([, id]) => id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })

  it('separates label, control and error by the within-a-control step', () => {
    expect(renderToStaticMarkup(<Field label="Prompt" name="prompt" />)).toContain('gap-tight')
  })
})
