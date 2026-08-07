import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Button } from './button'

describe('Button', () => {
  it('renders its label and reports an idle state', () => {
    const markup = renderToStaticMarkup(<Button>Start run</Button>)
    expect(markup).toContain('Start run')
    expect(markup).toContain('data-state="idle"')
    expect(markup).toContain('aria-busy="false"')
  })

  it('replaces the label with the live readout while in flight, and shows no spinner', () => {
    const markup = renderToStaticMarkup(
      <Button pending readout="Running 04:21">
        Start run
      </Button>,
    )
    expect(markup).toContain('Running 04:21')
    expect(markup).not.toContain('Start run')
    expect(markup).not.toMatch(/spinner|animate-spin/)
  })

  it('reports the in-flight state to assistive technology and to the DOM', () => {
    const markup = renderToStaticMarkup(<Button pending readout="Running 04:21" />)
    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain('data-state="pending"')
    expect(markup).toContain('disabled')
  })

  it('reports a disabled state distinctly from an in-flight one', () => {
    const markup = renderToStaticMarkup(<Button disabled>Start run</Button>)
    expect(markup).toContain('data-state="disabled"')
    expect(markup).toContain('aria-busy="false"')
  })

  it('stays enabled when a caller explicitly un-disables an in-flight button', () => {
    const markup = renderToStaticMarkup(
      <Button pending readout="Running 04:21" disabled={false}>
        Cancel
      </Button>,
    )
    expect(markup).not.toContain('disabled=""')
    expect(markup).toContain('data-state="pending"')
  })

  it('applies the requested variant', () => {
    expect(renderToStaticMarkup(<Button variant="danger">Destroy</Button>)).toContain('text-rust')
  })

  it('falls back to secondary, so a forgotten variant cannot become a second primary', () => {
    expect(renderToStaticMarkup(<Button>Cancel</Button>)).toContain('shadow-keycap-hairline')
  })

  it('defaults to type=button so a button in a form does not submit it by accident', () => {
    expect(renderToStaticMarkup(<Button>Cancel</Button>)).toContain('type="button"')
    expect(renderToStaticMarkup(<Button type="submit">Save</Button>)).toContain('type="submit"')
  })

  it('composes a caller class through the shared cn', () => {
    const markup = renderToStaticMarkup(<Button className="w-full">Start run</Button>)
    expect(markup).toContain('w-full')
    expect(markup).toContain('type-label-button')
  })

  it('lets the shared cn drop the base utility a caller class conflicts with', () => {
    const markup = renderToStaticMarkup(<Button className="border-ink">Start run</Button>)
    expect(markup).toContain('border-ink')
    expect(markup).not.toContain('border-hairline-hi')
  })

  it('carries the shared focus ring', () => {
    expect(renderToStaticMarkup(<Button>Start run</Button>)).toContain('focus-ring')
  })
})
