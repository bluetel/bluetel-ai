import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { AttachmentGateNotice } from './attachment-gate-notice'
import type { ProfileAttachment } from './attachment-order'

const attachment = (patch: Partial<ProfileAttachment> = {}): ProfileAttachment => ({
  id: 'attachment-1',
  credentialGroupId: 'group-1',
  name: 'Payments',
  enabled: true,
  archivedAt: null,
  position: 1,
  ...patch,
})

const render = (attachments: readonly ProfileAttachment[]) =>
  renderToStaticMarkup(<AttachmentGateNotice attachments={attachments} />)

/**
 * The property under test is the one FR-065 is about: the refusal is on screen **without anything
 * having been submitted**. Every case below renders the component with attachments and nothing
 * else — no error prop, no pending state, no rejected mutation — so a rewrite that made this
 * sentence depend on a bounced save would fail here.
 */
describe('the FR-065 refusal, inline rather than at the save', () => {
  it('refuses a profile with no attached group as soon as the list is read', () => {
    const markup = render([])

    expect(markup).toContain('E_PROFILE_NO_CREDENTIAL_GROUP')
    expect(markup).toContain('no attached credential group')
  })

  it('names the missing attachment as the fix, which is what the requirement asks it to name', () => {
    expect(render([])).toContain('Attach at least one credential group')
  })

  it('says the refusal is here rather than at launch', () => {
    expect(render([])).toContain('rather than at launch')
  })

  it('is announced, because it appears without the administrator doing anything', () => {
    expect(render([])).toContain('aria-label="Why this profile cannot be enabled"')
  })

  it('refuses a profile whose attached groups are all unusable, and says so differently', () => {
    const markup = render([attachment({ enabled: false })])

    expect(markup).toContain('E_PROFILE_CREDENTIAL_GROUPS_UNAVAILABLE')
    expect(markup).toContain('Re-enable')
    expect(markup).not.toContain('E_PROFILE_NO_CREDENTIAL_GROUP')
  })
})

describe('the passing case', () => {
  it('states that the profile can draw on something, rather than rendering nothing', () => {
    const markup = render([attachment()])

    expect(markup).toContain('1 of 1')
    expect(markup).not.toContain('E_PROFILE_NO_CREDENTIAL_GROUP')
  })

  it('spells out the FR-064 selection rule against the order actually attached', () => {
    const markup = render([
      attachment(),
      attachment({
        id: 'attachment-2',
        credentialGroupId: 'group-2',
        name: 'Reserve',
        position: 2,
      }),
    ])

    expect(markup).toContain('Payments')
    expect(markup).toContain('next usable group in the order below')
  })
})
