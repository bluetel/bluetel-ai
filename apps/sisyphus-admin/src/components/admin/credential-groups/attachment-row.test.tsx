import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { ProfileAttachment } from './attachment-order'
import { AttachmentRow } from './attachment-row'

const noop = () => undefined

const attachment = (patch: Partial<ProfileAttachment> = {}): ProfileAttachment => ({
  id: 'attachment-1',
  credentialGroupId: 'group-1',
  name: 'Payments',
  enabled: true,
  archivedAt: null,
  position: 1,
  ...patch,
})

const render = (props: Partial<Parameters<typeof AttachmentRow>[0]> = {}) =>
  renderToStaticMarkup(
    <AttachmentRow
      attachment={attachment()}
      total={3}
      onMove={noop}
      onDetach={noop}
      canMoveEarlier={false}
      canMoveLater
      {...props}
    />,
  )

describe('AttachmentRow (FR-062, FR-064)', () => {
  it('says what the position does, not only what number it is', () => {
    expect(render()).toContain('1st of 3 — tried first')
  })

  it('says a middle row is tried after the one above it', () => {
    expect(render({ attachment: attachment({ position: 2 }), canMoveEarlier: true })).toContain(
      '2nd of 3 — tried after the 1st',
    )
  })

  it('carries its position as an attribute, so the order is readable without parsing prose', () => {
    expect(render({ attachment: attachment({ position: 2 }) })).toContain('data-position="2"')
  })

  it('names the controls for what they do to the order rather than for a direction', () => {
    const markup = render()

    expect(markup).toContain('Move earlier')
    expect(markup).toContain('Move later')
  })

  it('disables the move that would fall off the end rather than hiding it', () => {
    const markup = render({ canMoveEarlier: false, canMoveLater: true })

    expect(markup).toContain('Move earlier')
    expect(markup).toContain('data-state="disabled"')
  })

  it('offers detaching, which is the only way an attachment is removed', () => {
    expect(render()).toContain('Detach')
  })
})

describe('an attachment that is present and useless', () => {
  it('says a disabled group hands nothing to a run, and that selection passes over it', () => {
    const markup = render({ attachment: attachment({ enabled: false }) })

    expect(markup).toContain('this group is unavailable')
    expect(markup).toContain('passes over it')
  })

  it('reports a deleted group as deleted rather than as disabled', () => {
    expect(render({ attachment: attachment({ archivedAt: new Date() }) })).toContain('deleted')
  })

  it('says nothing of the sort about a usable one', () => {
    expect(render()).not.toContain('this group is unavailable')
  })
})
