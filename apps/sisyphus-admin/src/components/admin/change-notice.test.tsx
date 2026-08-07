import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ChangeNotice } from './change-notice'

const render = (readout = 'flagged 3', detail = '3 runs they own are now flagged.') =>
  renderToStaticMarkup(<ChangeNotice readout={readout} detail={detail} />)

describe('ChangeNotice', () => {
  it('renders the readout and the sentence behind it', () => {
    const markup = render()

    expect(markup).toContain('flagged 3')
    expect(markup).toContain('3 runs they own are now flagged.')
  })

  it('announces politely rather than interrupting, because the operator asked for this', () => {
    const markup = render()

    expect(markup).toContain('role="status"')
    expect(markup).not.toContain('role="alert"')
  })

  it('reports a zero count too, so a notice is not only ever a warning', () => {
    expect(render('flagged 0', 'Nothing was left behind.')).toContain('flagged 0')
  })

  it('uses the idle chip, because an admin action’s outcome is not a workflow state', () => {
    const markup = render()

    expect(markup).toContain('data-state="idle"')
    expect(markup).not.toContain('text-verdigris')
    expect(markup).not.toContain('text-rust')
  })

  it('carries no literal colour, size or radius', () => {
    expect(render()).not.toMatch(/#[0-9a-fA-F]{3,8}|\d+(?:px|rem)/)
  })
})
