import { describe, expect, it } from 'vitest'

import {
  CONNECTOR_NOT_CONFIGURED_REASON,
  createRefusingConnectorRegistry,
  createRefusingPromptLayering,
  PROMPT_LAYERING_NOT_CONFIGURED,
} from './integration-connectors'

describe('createRefusingConnectorRegistry (FR-097, FR-192)', () => {
  it('produces no connector, so nothing can be validated against a board it cannot reach', async () => {
    expect(
      await createRefusingConnectorRegistry().connectorFor({
        type: 'jira',
        config: {},
        credentialSecretArn: 'arn:fixture',
        baseUrl: 'https://boards.invalid',
      }),
    ).toBeUndefined()
  })

  it('carries a reason an admin can act on rather than a bare failure', () => {
    expect(CONNECTOR_NOT_CONFIGURED_REASON).toContain('no connector registered')
  })
})

describe('createRefusingPromptLayering (FR-160, FR-163)', () => {
  it('refuses rather than rendering a preview to a lower standard than the stored prompt', () => {
    expect(() =>
      createRefusingPromptLayering().assemble({
        preamble: null,
        intro: 'Board intro.',
        parts: {
          title: 'A ticket',
          url: 'https://boards.invalid/browse/FIX-1',
          body: null,
          comments: [],
          truncatedComments: 0,
        },
      }),
    ).toThrow(PROMPT_LAYERING_NOT_CONFIGURED)
  })

  it('says what to supply', () => {
    expect(PROMPT_LAYERING_NOT_CONFIGURED).toContain('control plane assembler')
  })
})
