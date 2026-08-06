import { describe, expect, it } from 'vitest'

import type { DeliveryConventions } from './conventions'
import { DEV_SKILL_NAME, requireDeliveryConventions } from './conventions'

const complete: DeliveryConventions = {
  remote: 'origin',
  branchName: 'sisyphus/ACME-142-retry-schedule',
  baseBranch: 'develop',
  pullRequestTitle: 'ACME-142 Add a retry schedule to reporting',
}

describe('requireDeliveryConventions', () => {
  it('returns what the skill supplied, trimmed', () => {
    expect(
      requireDeliveryConventions(
        { ...complete, remote: ' upstream ', baseBranch: ' trunk ' },
        'draft pull request',
      ),
    ).toEqual({ ...complete, remote: 'upstream', baseBranch: 'trunk' })
  })

  it('invents nothing when the skill is silent', () => {
    let thrown: Error | undefined

    try {
      requireDeliveryConventions({}, 'draft pull request')
    } catch (error) {
      thrown = error as Error
    }

    expect(thrown).toBeDefined()
    // Every field is reported, and none of them is filled in with a guess.
    expect(thrown?.message).toContain('no remote')
    expect(thrown?.message).toContain('no branch name')
    expect(thrown?.message).toContain('no base branch')
    expect(thrown?.message).toContain('no pull request title')
  })

  it('names the skill and the step, per FR-058', () => {
    expect(() => requireDeliveryConventions({}, 'draft pull request')).toThrow(
      new RegExp(`${DEV_SKILL_NAME} did not give the draft pull request step`),
    )
  })

  it('never falls back to a conventional value for any single missing field', () => {
    const withoutOne: readonly Partial<DeliveryConventions>[] = [
      {
        branchName: complete.branchName,
        baseBranch: complete.baseBranch,
        pullRequestTitle: complete.pullRequestTitle,
      },
      {
        remote: complete.remote,
        baseBranch: complete.baseBranch,
        pullRequestTitle: complete.pullRequestTitle,
      },
      {
        remote: complete.remote,
        branchName: complete.branchName,
        pullRequestTitle: complete.pullRequestTitle,
      },
      { remote: complete.remote, branchName: complete.branchName, baseBranch: complete.baseBranch },
    ]

    for (const partial of withoutOne) {
      expect(() => requireDeliveryConventions(partial, 'draft pull request')).toThrow()
    }

    // Blank is missing, not "use the usual one".
    expect(() =>
      requireDeliveryConventions({ ...complete, baseBranch: '   ' }, 'draft pull request'),
    ).toThrow(/no base branch/)
  })

  it('refuses a branch proposed onto itself as self-contradictory', () => {
    expect(() =>
      requireDeliveryConventions(
        { ...complete, branchName: 'develop', baseBranch: 'develop' },
        'draft pull request',
      ),
    ).toThrow(/cannot be proposed onto itself/)
  })

  it('keeps an optional body preamble and drops a blank one', () => {
    expect(
      requireDeliveryConventions({ ...complete, bodyPreamble: 'Closes ACME-142.' }, 'delivery'),
    ).toMatchObject({ bodyPreamble: 'Closes ACME-142.' })
    expect(
      requireDeliveryConventions({ ...complete, bodyPreamble: '  ' }, 'delivery'),
    ).not.toHaveProperty('bodyPreamble')
  })
})
