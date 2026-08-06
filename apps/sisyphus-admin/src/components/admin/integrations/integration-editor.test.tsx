import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { IntegrationEditor } from './integration-editor'
import type { IntegrationDraft } from './integration-form-values'
import { EMPTY_INTEGRATION } from './integration-form-values'

const noop = () => undefined
const NOW = new Date('2026-08-05T10:00:00Z')

const draft: IntegrationDraft = {
  ...EMPTY_INTEGRATION,
  name: 'Payments board',
  baseUrl: 'https://boards.invalid',
  cronExpression: '0/15 * * * *',
  timezone: 'Europe/London',
  promptIntro: 'Work from this board ships as one pull request.',
}

const render = (props: Partial<Parameters<typeof IntegrationEditor>[0]> = {}) =>
  renderToStaticMarkup(
    <IntegrationEditor
      draft={draft}
      errors={{}}
      profiles={[{ value: 'profile-1', label: 'Payments' }]}
      owners={[{ value: 'user-1', label: 'someone@sisyphus.test' }]}
      onChange={noop}
      onSubmit={noop}
      onCancel={noop}
      now={NOW}
      {...props}
    />,
  )

describe('IntegrationEditor (T121, FR-096, FR-130, FR-133, FR-154, FR-158)', () => {
  it('says an integration carries no repository, model or caps of its own', () => {
    expect(render()).toContain('Those come from the execution profile')
  })

  it('includes the write-only credential control', () => {
    expect(render()).toContain('Credential secret reference')
  })

  it('never renders a credential value, even when editing', () => {
    const markup = render({ editing: true })

    // The only `arn:` in the markup is the placeholder. The control itself is empty, because
    // `draftFromIntegration` never puts a value there and nothing else could.
    expect(markup).toContain('type="password"')
    expect(markup.split('type="password"')[1]).toMatch(/^[^>]*value=""/)
  })

  it('marks the default owner as required to enable (FR-133)', () => {
    expect(render()).toContain('Default owner — required to enable')
  })

  it('marks the prompt intro as required to enable (FR-158)', () => {
    expect(render()).toContain('Prompt intro — required to enable')
  })

  it('puts the ceilings with the schedule, because they are one decision', () => {
    const markup = render()

    expect(markup.indexOf('Workflows per tick')).toBeGreaterThan(markup.indexOf('next 5 runs'))
  })

  it('shows the readback and the fire times before anything can be saved (FR-154)', () => {
    const markup = render()

    expect(markup).toContain('reads as')
    expect(markup).toContain('next 5 runs')
  })

  it('says a ticket matching no mapping is skipped rather than guessed at (FR-130)', () => {
    expect(render()).toContain('never started under a guessed profile')
  })

  it('offers the profiles a mapping may resolve to', () => {
    expect(
      render({
        draft: {
          ...draft,
          mappings: [{ position: '0', criteria: '', executionProfileId: '', isDefault: true }],
        },
      }),
    ).toContain('Payments')
  })

  it('warns that a filter it cannot read fails the tick rather than being ignored', () => {
    expect(render()).toContain('would widen the')
  })

  it('reads as an edit when editing', () => {
    expect(render({ editing: true })).toContain('edit integration')
  })

  it('reports its own pending state as a readout rather than a spinner', () => {
    expect(render({ startedAt: Date.now() })).toContain('Saving')
  })

  it('renders field-level refusals under the controls they belong to', () => {
    expect(
      render({ errors: { promptIntro: { code: 'too_small', action: 'Describe the work.' } } }),
    ).toContain('Describe the work.')
  })

  it('says a new integration is created disabled and what enabling checks', () => {
    expect(render()).toContain('created disabled')
  })
})
