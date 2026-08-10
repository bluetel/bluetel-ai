import { describe, expect, it } from 'vitest'

import type { ProfileAttachment } from './attachment-order'
import {
  attachmentOrderIds,
  canMoveAttachment,
  moveAttachment,
  ordinal,
  preferenceReadout,
} from './attachment-order'

const attachment = (position: number, credentialGroupId: string): ProfileAttachment => ({
  id: `attachment-${credentialGroupId}`,
  credentialGroupId,
  name: `Group ${credentialGroupId}`,
  enabled: true,
  archivedAt: null,
  position,
})

const three: readonly ProfileAttachment[] = [
  attachment(1, 'a'),
  attachment(2, 'b'),
  attachment(3, 'c'),
]

describe('saying what a position means (FR-062, FR-064)', () => {
  it('numbers rows as ordinals, including the teens the naive rule gets wrong', () => {
    expect(ordinal(1)).toBe('1st')
    expect(ordinal(2)).toBe('2nd')
    expect(ordinal(3)).toBe('3rd')
    expect(ordinal(4)).toBe('4th')
    expect(ordinal(11)).toBe('11th')
    expect(ordinal(12)).toBe('12th')
    expect(ordinal(13)).toBe('13th')
    expect(ordinal(21)).toBe('21st')
  })

  it('says the first attachment is tried first, rather than leaving that to be inferred', () => {
    expect(preferenceReadout(1, 3)).toBe('1st of 3 — tried first')
  })

  it('says the last attachment is tried last', () => {
    expect(preferenceReadout(3, 3)).toBe('3rd of 3 — tried last')
  })

  it('says what a middle attachment comes after, so the order reads as a sequence', () => {
    expect(preferenceReadout(2, 3)).toBe('2nd of 3 — tried after the 1st')
  })

  it('says the only attachment is tried first, which is also the honest reading', () => {
    expect(preferenceReadout(1, 1)).toBe('1st of 1 — tried first')
  })
})

describe('moving one attachment (FR-062)', () => {
  it('sends the whole order, which is what the reorder procedure checks against', () => {
    expect(attachmentOrderIds(three)).toEqual(['a', 'b', 'c'])
    expect(moveAttachment(three, 'c', 'earlier')).toEqual(['a', 'c', 'b'])
  })

  it('moves a row one place later', () => {
    expect(moveAttachment(three, 'a', 'later')).toEqual(['b', 'a', 'c'])
  })

  it('refuses to move the first row earlier, rather than sending an order that changed nothing', () => {
    expect(moveAttachment(three, 'a', 'earlier')).toBeUndefined()
    expect(canMoveAttachment(three, 'a', 'earlier')).toBe(false)
  })

  it('refuses to move the last row later', () => {
    expect(moveAttachment(three, 'c', 'later')).toBeUndefined()
    expect(canMoveAttachment(three, 'c', 'later')).toBe(false)
  })

  it('refuses to move a group that is not attached', () => {
    expect(moveAttachment(three, 'z', 'earlier')).toBeUndefined()
  })

  it('never adds, drops or repeats a group, which is what would make the router refuse', () => {
    const moved = moveAttachment(three, 'b', 'later')

    expect(moved).toHaveLength(3)
    expect([...(moved ?? [])].sort()).toEqual(['a', 'b', 'c'])
  })

  it('leaves the list it was given untouched', () => {
    moveAttachment(three, 'b', 'later')

    expect(attachmentOrderIds(three)).toEqual(['a', 'b', 'c'])
  })
})
