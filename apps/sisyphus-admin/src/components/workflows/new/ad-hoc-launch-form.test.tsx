import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { AdHocLaunchForm } from './ad-hoc-launch-form'
import type { LaunchFormValues } from './launch-form-values'
import { EMPTY_LAUNCH_FORM } from './launch-form-values'

const noop = () => undefined

const workspaces = [{ value: 'version-a', label: 'Payments — 2 repos' }]
const bundles = [{ value: 'bundle-version-a', label: 'Payments toolchain — v3' }]

const render = (
  props: Partial<Parameters<typeof AdHocLaunchForm>[0]> = {},
  values: Partial<LaunchFormValues> = {},
) =>
  renderToStaticMarkup(
    <AdHocLaunchForm
      values={{ ...EMPTY_LAUNCH_FORM, ...values }}
      errors={{}}
      onChange={noop}
      onSubmit={noop}
      workspaces={workspaces}
      bundles={bundles}
      {...props}
    />,
  )

describe('AdHocLaunchForm', () => {
  it('asks its three questions in the order they are answered', () => {
    const markup = render()

    expect(markup.indexOf('what it checks out')).toBeLessThan(markup.indexOf('what it runs on'))
    expect(markup.indexOf('what it runs on')).toBeLessThan(markup.indexOf('what to do'))
  })

  it('counts what is available to choose in the header chips', () => {
    const markup = render()

    expect(markup).toContain('workspaces 1')
    expect(markup).toContain('bundles 1')
  })

  it('says why this path is admin-only rather than leaving it to be inferred (FR-187)', () => {
    expect(render()).toContain('unnamed profile')
  })

  describe('saving the configuration as a profile (FR-129)', () => {
    it('makes the naming the decision, with no second control to disagree with it', () => {
      const markup = render()

      expect(markup).toContain('Save this configuration as a profile')
      expect(markup).toContain('name it to save it, or leave blank')
      expect(markup).not.toContain('type="checkbox"')
    })

    it('says the profile arrives disabled, so that reads as FR-124 rather than as a bug', () => {
      expect(render()).toContain('disabled and granted to nobody')
    })
  })

  describe('the one primary button', () => {
    it('is the launch, and there is exactly one of it', () => {
      const markup = render()

      expect(markup).toContain('Launch run')
      expect(markup.match(/bg-signal /g)).toHaveLength(1)
    })

    it('is idle rather than disabled — the refusals are per field, not a dead button', () => {
      expect(render()).toContain('data-state="idle"')
    })

    it('becomes a live readout in flight, and shows no spinner (FR-029)', () => {
      const markup = render({ startedAt: 1000 })

      expect(markup).toContain('Launching 0:00')
      expect(markup).toContain('aria-busy="true"')
      expect(markup).not.toMatch(/spinner|animate-spin/)
    })

    it('locks the fields while a launch is in flight', () => {
      expect(render({ startedAt: 1000 })).toContain('disabled')
    })
  })

  it('renders a whole-request refusal with its code and next action (FR-031)', () => {
    const markup = render({
      error: { code: 'E_LAUNCH_REFUSED', action: 'Nothing was started.' },
    })

    expect(markup).toContain('E_LAUNCH_REFUSED')
    expect(markup).toContain('Nothing was started.')
  })

  it('reports what the last launch did, politely rather than as an alert (FR-040)', () => {
    const markup = render({
      notice: { readout: 'queued 3', detail: 'Nothing has been provisioned yet.' },
    })

    expect(markup).toContain('queued 3')
    expect(markup).toContain('role="status"')
  })

  it('reports nothing before the first launch', () => {
    expect(render()).not.toContain('role="status"')
  })

  it('carries no literal colour, size or radius (SC-015)', () => {
    expect(render()).not.toMatch(/#[0-9a-fA-F]{3,8}|\d+(?:px|rem)/)
  })
})
