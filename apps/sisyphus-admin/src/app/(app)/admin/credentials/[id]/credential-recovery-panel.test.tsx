import { describe, expect, it } from 'vitest'

import { CredentialRecoveryPanel } from './credential-recovery-panel'

/**
 * The panel holds a polling query and three mutations, so it cannot be rendered without a tRPC
 * provider and a query client — and with no testing library available there is nothing here to
 * drive it with. The same position `credential-login-panel.test.tsx` and `credentials-panel.test.tsx`
 * are in, for the same reason: everything that can be *decided* lives in `recovery-actions.ts`,
 * pure and tested against, and what is left here is wiring.
 *
 * What is asserted against the source is the small number of things a well-meaning later change
 * would break without noticing.
 */
describe('CredentialRecoveryPanel', () => {
  it('is a component the page can mount', () => {
    expect(typeof CredentialRecoveryPanel).toBe('function')
  })

  it('takes the seat id and nothing else, so it resolves no route and reads no session', () => {
    expect(CredentialRecoveryPanel).toHaveLength(1)
  })

  it('offers all four recovery controls (T121)', () => {
    const source = CredentialRecoveryPanel.toString()

    expect(source).toContain('setEnabled')
    expect(source).toContain('forceRelease')
    // Re-login is a link rather than a mutation: a login is a session with an instance at the other
    // end, and it has its own page where a terminal can be drawn.
    expect(source).toContain('/login')
    expect(source).toContain('remove')
  })

  it('renders a refusal rather than deciding one for itself (FR-005)', () => {
    // Every mutation's `onError` goes to the same place, and that place renders the server's own
    // words. FR-005's refusal names how many times the seat was leased and offers disabling
    // instead; a panel that summarised it would drop the half that tells an administrator what to
    // do, and a panel that predicted it would be a second implementation of the requirement.
    const source = CredentialRecoveryPanel.toString()

    expect(source).toContain('describeTrpcError')
    expect(source).toContain('onError: refuse')
  })

  it('has no way to read or render credential material (FR-070)', () => {
    // The seat's `secretId` is rendered and is not an exception: it is a Secrets Manager name, and
    // showing it is how an administrator finds the secret without guessing the naming scheme.
    const source = CredentialRecoveryPanel.toString()

    for (const forbidden of [
      '.material',
      'secretValue',
      'createObjectURL',
      'navigator.clipboard',
    ]) {
      expect(source).not.toContain(forbidden)
    }
  })

  it('states what a force-release costs before the button rather than behind a dialog', () => {
    // A confirmation dialog is dismissed by muscle memory. The sentence that matters is not "are
    // you sure" but "this ends a run that is currently working".
    const source = CredentialRecoveryPanel.toString()

    expect(source).toContain('FORCE_RELEASE_WARNING')
    for (const forbidden of ['window.confirm', 'confirm(']) {
      expect(source).not.toContain(forbidden)
    }
  })
})
