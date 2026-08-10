import { describe, expect, it } from 'vitest'

import * as barrel from './index'

/**
 * The barrel is the directory's public surface, so what it does — and does not — export is a
 * contract in its own right (T078).
 *
 * Two absences matter more than any of the presences. There is **no way to read credential
 * material** from anything exported here: `captureLoginMaterial` returns an outcome that names
 * identifiers, and the seam it reads through is an interface a caller supplies rather than a
 * function this directory hands out. And there is **no "complete this login" call**, because
 * nothing in the panel tells the platform a login worked — the capture watches the instance and the
 * reaper watches the clock, which is what makes the abandoned case (FR-071) an ordinary path rather
 * than a special one.
 */

describe('the login barrel', () => {
  it('exports the four steps a login has in its life', () => {
    for (const name of [
      'provisionLoginEnvironment',
      'createSsmLoginRelay',
      'captureLoginMaterial',
      'reapLoginEnvironments',
    ] as const) {
      expect(typeof barrel[name]).toBe('function')
    }
  })

  it('publishes the lifetime rather than hiding it in the module that spends it', () => {
    // The number is a policy about how long an abandoned login may bill for, and it is worth being
    // readable from outside — the panel shows a countdown against it.
    expect(barrel.DEFAULT_LOGIN_TTL_MS).toBeGreaterThan(0)
    expect(Number.isInteger(barrel.DEFAULT_LOGIN_TTL_MS)).toBe(true)
  })

  it('names the path the capture reads and the job the schedule invokes', () => {
    // Both are spelled in two places — here and in a deployment — so both are exported rather than
    // written as a literal at each site.
    expect(barrel.LOGIN_MATERIAL_PATH.startsWith('/')).toBe(true)
    expect(barrel.REAP_LOGIN_ENVIRONMENTS_JOB_NAME).toBe('reap-login-environments')
  })

  it('assembles a boot script with no envelope in it (FR-069)', () => {
    const script = barrel.loginUserData({
      agentCredentialId: 'credential-1',
      credentialName: 'seat-one',
    })

    expect(script).toContain(barrel.LOGIN_MATERIAL_PATH)
    for (const forbidden of ['workspace', 'bundle', 'scopedCredential', 'workflowId']) {
      expect(script).not.toContain(forbidden)
    }
  })

  it('exports exactly this runtime surface and nothing else', () => {
    // Types erase, so this is all of it. An equality rather than a `toContain`, so widening the
    // surface is a deliberate edit here as well as there.
    expect([...Object.keys(barrel)].sort()).toStrictEqual([
      'DEFAULT_LOGIN_TTL_MS',
      'LOGIN_INSTANCE_TYPE',
      'LOGIN_MATERIAL_PATH',
      'REAP_LOGIN_ENVIRONMENTS_JOB_NAME',
      'captureLoginMaterial',
      'createSsmLoginRelay',
      'destroyLoginEnvironment',
      'listLoginEnvironments',
      'listUnattributedLoginEnvironments',
      'loginSecretName',
      'loginUserData',
      'provisionLoginEnvironment',
      'reapLoginEnvironments',
      'reapingEnvironments',
    ])
  })

  it('offers no way to read credential material, and no completion call', () => {
    // The first would be FR-070 broken at the barrel. The second would make putting a seat into
    // service depend on a report the abandoned case can never send — which is how the failure path
    // ends up being the untested one.
    for (const name of [
      'readLoginMaterial',
      'fetchLoginMaterial',
      'loginMaterial',
      'completeLogin',
      'finishLogin',
      'confirmLogin',
    ]) {
      expect(Object.keys(barrel)).not.toContain(name)
    }
  })

  it('does not re-export the workflow-scoped credential this directory sits beside', () => {
    // Two unrelated things called a credential. `mint.ts` is 002's short-lived JWT for the machine
    // surface; nothing here is about that, and a barrel that forwarded it would invite the confusion
    // the subdirectory exists to prevent.
    for (const name of ['mintScopedCredential', 'revokeScopedCredentials', 'liveCredentialFor']) {
      expect(Object.keys(barrel)).not.toContain(name)
    }
  })
})
