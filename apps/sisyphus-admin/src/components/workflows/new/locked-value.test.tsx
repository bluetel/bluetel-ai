import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { LockedValue } from './locked-value'

const render = (props: Partial<Parameters<typeof LockedValue>[0]> = {}) =>
  renderToStaticMarkup(<LockedValue label="Model" value="claude-opus-5" {...props} />)

describe('LockedValue (FR-023, FR-123)', () => {
  it('shows the value the run will use, rather than hiding the field', () => {
    expect(render()).toContain('claude-opus-5')
  })

  it('reports that it is locked, in the console’s own state vocabulary', () => {
    expect(render()).toContain('locked')
  })

  it('says who fixed it, so the lock reads as a decision rather than as a fault', () => {
    expect(render()).toContain('fixed by the execution profile')
  })

  it('offers nothing to type into — a locked field is a readout', () => {
    const markup = render()

    expect(markup).not.toContain('<input')
    expect(markup).not.toContain('<select')
  })

  it('reads a blank value as what it means rather than as an empty box', () => {
    expect(render({ value: '', blankReadout: 'no cap' })).toContain('no cap')
  })

  it('carries a field’s own clause of consequence when it has one', () => {
    expect(render({ hint: 'blank means no cap' })).toContain('blank means no cap')
  })

  it('renders a refusal with a code and a next action, never a dropped override', () => {
    const markup = render({
      error: { code: 'E_LAUNCH_LOCKED_MODEL', action: 'Launch with the profile’s value.' },
    })

    expect(markup).toContain('E_LAUNCH_LOCKED_MODEL')
    expect(markup).toContain('Launch with the profile’s value.')
  })
})
