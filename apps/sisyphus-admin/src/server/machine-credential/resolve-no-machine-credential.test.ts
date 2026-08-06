import { describe, expect, it } from 'vitest'

import { resolveNoMachineCredential } from './resolve-no-machine-credential'

describe('resolveNoMachineCredential', () => {
  it('answers null however convincing the credential looks', async () => {
    await expect(resolveNoMachineCredential()).resolves.toBeNull()
  })

  it('takes no headers, because the interactive surface reads none', () => {
    expect(resolveNoMachineCredential.length).toBe(0)
  })
})
