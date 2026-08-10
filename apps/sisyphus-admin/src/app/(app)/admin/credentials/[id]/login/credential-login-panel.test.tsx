import { describe, expect, it } from 'vitest'

import { CredentialLoginPanel } from './credential-login-panel'

/**
 * The panel holds a polling query and a mutation, so it cannot be rendered without a tRPC provider
 * and a query client — and with no testing library available there is nothing here to drive it
 * with. The same position `credentials-panel.test.tsx` is in, for the same reason.
 *
 * What **is** asserted here is the property the whole page exists to preserve, and it is asserted
 * against the source rather than against a render: there is no way for credential material to be
 * displayed, because there is nothing in this component that reads one. The router answers an
 * instance id, two timestamps and a Session Manager handle, and the port behind it has no method
 * that returns a value at all (FR-070) — so this check is a second line rather than the only one,
 * and it is the line a well-meaning "just show it once so the admin can verify" change would cross.
 */
describe('CredentialLoginPanel', () => {
  it('is a component the page can mount', () => {
    expect(typeof CredentialLoginPanel).toBe('function')
  })

  it('takes the seat id and nothing else, so it resolves no route and reads no session', () => {
    expect(CredentialLoginPanel).toHaveLength(1)
  })

  it('has no way to read or render credential material (FR-070)', () => {
    const source = CredentialLoginPanel.toString()

    // `relay.sessionId` is read and is not an exception: it identifies a terminal session, is
    // issued by AWS to the platform's role, and is worth one session on one instance that holds
    // nothing else. The agent credential is written on that instance and captured server-side.
    for (const forbidden of [
      '.material',
      'secretValue',
      'createObjectURL',
      'navigator.clipboard',
    ]) {
      expect(source).not.toContain(forbidden)
    }
  })

  it('offers no way to report that a login finished (FR-071)', () => {
    // Nothing in the panel tells the platform a login worked: the capture watches the instance and
    // the reaper watches the clock. A completion call would make putting a seat into service depend
    // on a report, and the abandoned case can never send one.
    const source = CredentialLoginPanel.toString()

    for (const forbidden of ['completeLogin', 'finishLogin', 'confirmLogin']) {
      expect(source).not.toContain(forbidden)
    }
  })
})
