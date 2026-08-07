import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { findDesignLiterals } from '@sisyphus-admin/styles/literal-audit'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { CredentialField } from './credential-field'
import { EDIT_CREDENTIAL_NOTICE } from './integration-form-values'

/* cspell:ignore lpignore */

const noop = () => undefined

const render = (props: Partial<Parameters<typeof CredentialField>[0]> = {}) =>
  renderToStaticMarkup(<CredentialField value="" onChange={noop} {...props} />)

describe('CredentialField (T121, FR-098)', () => {
  it('is a password control, so nothing treats it as ordinary text', () => {
    expect(render()).toContain('type="password"')
  })

  it('tells the browser and password managers not to keep it', () => {
    const markup = render()

    expect(markup).toContain('autoComplete="off"')
    expect(markup).toContain('data-lpignore="true"')
    expect(markup).toContain('data-1p-ignore="true"')
  })

  it('renders exactly the value it was handed, and nothing from a server', () => {
    expect(render({ value: 'arn:aws:secretsmanager:eu-west-2:1:secret:board' })).toContain(
      'value="arn:aws:secretsmanager:eu-west-2:1:secret:board"',
    )
  })

  it('renders empty when empty, which is what an edit starts from', () => {
    expect(render()).toContain('value=""')
  })

  it('explains why it must be re-entered when editing', () => {
    expect(render({ editing: true })).toContain(EDIT_CREDENTIAL_NOTICE.slice(0, 40))
  })

  it('says where the secret itself lives when creating', () => {
    expect(render()).toContain('stays in the secret store')
  })

  it('renders a refusal under the control', () => {
    expect(
      render({ error: { code: 'E_REQUIRED', action: 'Enter the secret reference.' } }),
    ).toContain('Enter the secret reference.')
  })

  it('marks itself invalid for assistive technology when refused', () => {
    expect(render({ error: { code: 'E_REQUIRED', action: 'Enter it.' } })).toContain(
      'aria-invalid="true"',
    )
  })
})

/**
 * SC-015 applied to this directory. A literal colour, size or radius added to any component here
 * fails at build time rather than at design review.
 */
describe('the integration screen carries no design literals (SC-015)', () => {
  const directory = fileURLToPath(new URL('.', import.meta.url))
  const sources = readdirSync(directory).filter((name) => !name.includes('.test.'))

  it('has components to audit', () => {
    expect(sources.length).toBeGreaterThan(0)
  })

  it.each(sources)('%s carries no literal colour, size or radius', (name) => {
    expect(findDesignLiterals(readFileSync(`${directory}${name}`, 'utf8'))).toStrictEqual([])
  })
})
