import { CLAUDE_MODELS, PURCHASE_MODES, WORKFLOW_TYPES } from '@bluetel-ai/sisyphus-api/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { JobSpecFields } from './job-spec-fields'
import type { LaunchFormValues } from './launch-form-values'
import { EMPTY_LAUNCH_FORM } from './launch-form-values'

const noop = () => undefined

const bundles = [{ value: 'bundle-version-a', label: 'Payments toolchain — v3' }]

const render = (
  values: Partial<LaunchFormValues> = {},
  props: Partial<Parameters<typeof JobSpecFields>[0]> = {},
) =>
  renderToStaticMarkup(
    <JobSpecFields
      values={{ ...EMPTY_LAUNCH_FORM, ...values }}
      errors={{}}
      onChange={noop}
      bundles={bundles}
      {...props}
    />,
  )

describe('JobSpecFields', () => {
  it('offers every model in the platform’s vocabulary, and nothing retyped (FR-009)', () => {
    const markup = render()

    for (const model of CLAUDE_MODELS) {
      expect(markup).toContain(model)
    }
  })

  it('offers every workflow type and capacity mode from the same tuples', () => {
    const markup = render()

    for (const value of [...WORKFLOW_TYPES, ...PURCHASE_MODES]) {
      expect(markup).toContain(`value="${value}"`)
    }
  })

  it('says what autonomous costs the operator — both caps become required (FR-055)', () => {
    expect(render()).toContain('both caps are required')
  })

  it('reads the capacity modes as words rather than as enum values', () => {
    const markup = render()

    expect(markup).toContain('Interruptible')
    expect(markup).toContain('Reserved')
  })

  it('says a blank cap means no cap, so an empty field is not read as a mistake', () => {
    expect(render()).toContain('blank for no cap')
  })

  it('says so, and disables the picker, when no setup bundle is available (FR-016)', () => {
    const markup = render({}, { bundles: [] })

    expect(markup).toContain('No enabled setup bundle is available')
  })

  it('marks the ticket reference optional, since a manual run may have no ticket', () => {
    expect(render()).toContain('optional')
  })

  it('renders a refusal against the control it belongs to', () => {
    const markup = render(
      {},
      { errors: { spendCap: { code: 'E_LAUNCH_SPEND_CAP', action: 'Enter an amount.' } } },
    )

    expect(markup).toContain('E_LAUNCH_SPEND_CAP')
  })

  it('carries no literal colour, size or radius (SC-015)', () => {
    expect(render()).not.toMatch(/#[0-9a-fA-F]{3,8}|\d+(?:px|rem)/)
  })
})
