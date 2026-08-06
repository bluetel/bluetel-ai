import { describe, expect, it } from 'vitest'

import type { AdHocLaunchResult } from './launch-outcome'
import { describeLaunch, describeLaunchError } from './launch-outcome'

const result = (overrides: Partial<AdHocLaunchResult> = {}): AdHocLaunchResult =>
  ({
    workflow: { id: 'workflow' },
    entries: [{ id: 'entry' }],
    queuePosition: 3,
    savedProfile: undefined,
    materialisedWorkspace: false,
    ...overrides,
  }) as unknown as AdHocLaunchResult

describe('describeLaunch', () => {
  it('says queued, with the position, so waiting is distinguishable from stuck (FR-040)', () => {
    expect(describeLaunch(result()).readout).toBe('queued 3')
  })

  it('says plainly that nothing has been provisioned yet (FR-035)', () => {
    expect(describeLaunch(result()).detail).toContain('Nothing has been provisioned yet')
  })

  it('counts the repositories the run will check out, singular and plural', () => {
    expect(describeLaunch(result()).detail).toContain('1 repository')
    expect(
      describeLaunch(result({ entries: [{}, {}] as unknown as AdHocLaunchResult['entries'] }))
        .detail,
    ).toContain('2 repositories')
  })

  it('says nothing about a workspace when an existing one was chosen', () => {
    expect(describeLaunch(result()).detail).not.toContain('private workspace')
  })

  it('explains the private workspace a hand-entered repository produced', () => {
    const notice = describeLaunch(result({ materialisedWorkspace: true }))

    expect(notice.detail).toContain('private workspace')
    expect(notice.detail).toContain('disabled')
  })

  it('names a saved profile and says it is disabled, so that reads as FR-124 not as a bug', () => {
    const notice = describeLaunch(
      result({
        savedProfile: {
          executionProfileId: 'profile',
          executionProfileVersionId: 'version',
          name: 'Nightly maintenance',
        },
      }),
    )

    expect(notice.detail).toContain('Nightly maintenance')
    expect(notice.detail).toContain('disabled and granted to nobody')
  })

  it('says nothing about a profile when none was asked for', () => {
    expect(describeLaunch(result()).detail).not.toContain('Saved the configuration')
  })
})

describe('describeLaunchError', () => {
  it('says nothing was started for a refusal about the platform’s own state', () => {
    const described = describeLaunchError({ data: { code: 'CONFLICT' } })

    expect(described.code).toBe('E_LAUNCH_REFUSED')
    expect(described.action).toContain('Nothing was started')
  })

  it('sends the operator to reload when a chosen target has gone', () => {
    expect(describeLaunchError({ data: { code: 'NOT_FOUND' } }).code).toBe(
      'E_LAUNCH_TARGET_NOT_FOUND',
    )
  })

  it('says why an ad hoc launch was refused outright, and what to do instead (FR-187)', () => {
    const described = describeLaunchError({ data: { code: 'FORBIDDEN' } })

    expect(described.code).toBe('E_ADMIN_REQUIRED')
    expect(described.action).toContain('launch from a profile you hold')
  })

  it('still gives a code and an action for a refusal it has never seen', () => {
    const described = describeLaunchError(new Error('network'))

    expect(described.code).toBe('E_UNEXPECTED')
    expect(described.action.length).toBeGreaterThan(0)
  })
})
