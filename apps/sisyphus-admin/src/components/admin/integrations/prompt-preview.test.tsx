import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { APPENDED_FIELDS, PromptPreview } from './prompt-preview'

const noop = () => undefined

const render = (props: Partial<Parameters<typeof PromptPreview>[0]> = {}) =>
  renderToStaticMarkup(
    <PromptPreview externalId="FIX-1" onExternalIdChange={noop} onPreview={noop} {...props} />,
  )

describe('PromptPreview (T121, FR-160)', () => {
  it('states exactly which ticket fields the platform appends', () => {
    const markup = render()

    for (const field of APPENDED_FIELDS) {
      expect(markup).toContain(field)
    }
  })

  it('says the intro need not restate them, which is the point of stating them', () => {
    expect(render()).toContain('no need to restate them')
  })

  it('reports that nothing has been rendered yet rather than showing an empty prompt', () => {
    expect(render()).toContain('not rendered')
  })

  it('renders the assembled prompt exactly as the server produced it', () => {
    expect(
      render({
        preview: {
          prompt: '## WORKSPACE CONTEXT\n\nThe contract lives in packages/contracts.',
          truncated: false,
          truncatedComments: 0,
          resolvedProfileId: 'profile-1',
          resolutionReason: undefined,
        },
      }),
    ).toContain('The contract lives in packages/contracts.')
  })

  it('names the profile the sample resolved to', () => {
    expect(
      render({
        preview: {
          prompt: 'x',
          truncated: false,
          truncatedComments: 0,
          resolvedProfileId: 'profile-1',
          resolutionReason: undefined,
        },
      }),
    ).toContain('profile-1')
  })

  it('says why a sample resolved to nothing, rather than showing a blank (FR-130)', () => {
    expect(
      render({
        preview: {
          prompt: 'x',
          truncated: false,
          truncatedComments: 0,
          resolvedProfileId: undefined,
          resolutionReason: 'no_mapping_matched',
        },
      }),
    ).toContain('no_mapping_matched')
  })

  it('states how many comments the bound dropped (FR-163)', () => {
    expect(
      render({
        preview: {
          prompt: 'x',
          truncated: true,
          truncatedComments: 4,
          resolvedProfileId: 'profile-1',
          resolutionReason: undefined,
        },
      }),
    ).toContain('comments dropped, oldest first')
  })

  it('says nothing about truncation when nothing was dropped', () => {
    expect(
      render({
        preview: {
          prompt: 'x',
          truncated: false,
          truncatedComments: 0,
          resolvedProfileId: 'profile-1',
          resolutionReason: undefined,
        },
      }),
    ).not.toContain('comments dropped')
  })

  it('reports its own pending state as a readout rather than a spinner', () => {
    expect(render({ startedAt: Date.now() })).toContain('Rendering')
  })

  it('renders a refusal', () => {
    expect(
      render({ error: { code: 'NOT_FOUND', action: 'Try a ticket the filters match.' } }),
    ).toContain('Try a ticket the filters match.')
  })
})
