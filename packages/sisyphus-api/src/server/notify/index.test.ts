import { describe, expect, it } from 'vitest'

import * as barrel from './index'

/**
 * The barrel is the directory's public surface, so what it does — and does not — export is a
 * contract in its own right.
 */
describe('the notify barrel', () => {
  it('exports the two maps and the emit wrapper', () => {
    expect(typeof barrel.notificationEventForOutcome).toBe('function')
    expect(typeof barrel.notificationEventForVerdict).toBe('function')
    expect(typeof barrel.emitWorkflowEvent).toBe('function')
  })

  it('exports no fake, so a resolver is never one import away from a fixture', () => {
    // `./test-support.ts` is kept out of here for the same reason `../workflow/test-support.ts`
    // and `../admin/test-database.ts` are kept out of theirs.
    expect(Object.keys(barrel)).not.toContain('createRecordingEmitter')
    expect(Object.keys(barrel)).not.toContain('createFailingEmitter')
  })

  it('exports nothing that could deliver a message', () => {
    // The port takes a workflow id and an event name. A messenger, a recipient resolver or a
    // delivery record reachable from here would be this package holding an opinion about who
    // hears about a run, which is the control plane's.
    for (const name of Object.keys(barrel)) {
      expect(name).not.toMatch(/slack|deliver|recipient/i)
    }
  })
})
