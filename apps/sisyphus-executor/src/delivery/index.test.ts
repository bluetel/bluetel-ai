import { describe, expect, it } from 'vitest'

import * as delivery from './index'

describe('the delivery barrel', () => {
  it('exports draft pull request creation and its refusals', () => {
    expect(typeof delivery.openDraftPullRequest).toBe('function')
    expect(typeof delivery.branchNotOnForgeError).toBe('function')
    expect(typeof delivery.unpushedCommitError).toBe('function')
    expect(typeof delivery.noPushedWorkError).toBe('function')
  })

  it('exports staleness assessment and recording', () => {
    expect(typeof delivery.assessStaleness).toBe('function')
    expect(typeof delivery.recordStaleness).toBe('function')
    expect(typeof delivery.createArtifactStalenessRecorder).toBe('function')
  })

  it('exports skill-sourced conventions and no defaults for them', () => {
    expect(typeof delivery.requireDeliveryConventions).toBe('function')
    expect(delivery.DEV_SKILL_NAME).toBe('sisyphus-dev')
    expect(Object.keys(delivery)).not.toContain('DEFAULT_BASE_BRANCH')
    expect(Object.keys(delivery)).not.toContain('DEFAULT_BRANCH_NAME')
  })

  it('exports the pull request set and its cross-reference (FR-115, FR-116)', () => {
    expect(typeof delivery.openPullRequestSet).toBe('function')
    expect(typeof delivery.crossReference).toBe('function')
  })

  it('exports a skill-sourced integration order and no default for it (FR-117)', () => {
    expect(typeof delivery.requirePromotionOrder).toBe('function')
    expect(delivery.PROMOTION_SKILL_NAME).toBe('sisyphus-integration')
    expect(Object.keys(delivery)).not.toContain('DEFAULT_PROMOTION_ORDER')
  })

  it('exports the forge implementation, its taxonomy and its retry policy (FR-077)', () => {
    expect(typeof delivery.createHttpForge).toBe('function')
    expect(typeof delivery.ForgeError).toBe('function')
    expect(typeof delivery.isRetryableForgeError).toBe('function')
    expect(typeof delivery.parseRepositorySlug).toBe('function')
    expect(delivery.DEFAULT_FORGE_RETRY_POLICY.maxAttempts).toBe(3)
  })

  it('offers nothing that would change a repository', () => {
    // FR-079 keeps the rebase decision with the repository's skills. The
    // barrel offers no way to take it: there is no exported action, only a
    // reader whose runner refuses every mutating subcommand.
    //
    // Names that merely *mention* a mutation are allowed through — an error
    // factory reporting an unpushed branch and the constant recording the
    // deferral both have to say the word. What must not exist is a callable
    // that performs one.
    const actionable = Object.keys(delivery).filter(
      (name) =>
        /rebase|merge|reset|push|checkout|commit/i.test(name) &&
        !name.endsWith('Error') &&
        name !== 'REBASE_DECISION',
    )

    expect(actionable).toEqual([])
    expect(delivery.REBASE_DECISION).toBe('deferred_to_repository_skills')
    // Nothing exported here is a git mutation, so the allow-list is the only
    // path to git and it refuses all of them.
    expect(delivery.FORBIDDEN_GIT_COMMANDS).toContain('rebase')
  })

  it('offers nothing that would transition a ticket', () => {
    expect(Object.keys(delivery).filter((name) => /ticket|transition|jira/i.test(name))).toEqual([])
  })
})
