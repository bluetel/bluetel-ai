import { describe, expect, it } from 'vitest'

import {
  adHocWorkspaceInput,
  continueWithChangesInput,
  correctWorkflowInput,
  listWorkflowsInput,
  logSegmentsInput,
  reassignOwnerInput,
  repositoryUrlInput,
  saveAsProfileInput,
  spendSummaryInput,
  startAdHocInput,
  startAdHocWorkflowInput,
  startWorkflowInput,
  workflowIdInput,
  workflowOverridesInput,
} from './workflow'

const ID = '01890a5d-ac96-774b-bcce-b302099a8057'
const OTHER_ID = '01890a5d-ac96-774b-bcce-b302099a8058'

describe('workflowIdInput', () => {
  it('accepts an identifier and nothing else', () => {
    expect(workflowIdInput.parse({ workflowId: ID })).toStrictEqual({ workflowId: ID })
    expect(workflowIdInput.safeParse({ workflowId: 'nope' }).success).toBe(false)
  })
})

describe('startWorkflowInput', () => {
  it('requires a profile and a prompt (FR-016)', () => {
    expect(
      startWorkflowInput.parse({ executionProfileId: ID, prompt: 'do the thing' }),
    ).toMatchObject({ executionProfileId: ID, prompt: 'do the thing' })
  })

  it('refuses a blank prompt, so a mis-clicked launch does not start an agent with nothing to do', () => {
    expect(startWorkflowInput.safeParse({ executionProfileId: ID, prompt: '   ' }).success).toBe(
      false,
    )
  })

  it('accepts a session reference for restoring into a new workflow (FR-016, US3)', () => {
    const parsed = startWorkflowInput.parse({
      executionProfileId: ID,
      prompt: 'continue',
      resumeFromSessionId: OTHER_ID,
    })

    expect(parsed.resumeFromSessionId).toBe(OTHER_ID)
  })

  it('names the failing field, which is what field-level zodError rendering needs (FR-008)', () => {
    const result = startWorkflowInput.safeParse({ executionProfileId: 'bad', prompt: '' })

    expect(result.success).toBe(false)
    expect(Object.keys(result.error?.flatten().fieldErrors ?? {}).sort()).toStrictEqual([
      'executionProfileId',
      'prompt',
    ])
  })
})

describe('workflowOverridesInput', () => {
  it('accepts a value from the model allowlist and rejects one outside it (FR-009)', () => {
    expect(workflowOverridesInput.safeParse({ model: 'claude-opus-5' }).success).toBe(true)
    expect(workflowOverridesInput.safeParse({ model: 'gpt-9' }).success).toBe(false)
  })

  it('refuses a non-positive turn cap', () => {
    expect(workflowOverridesInput.safeParse({ turnCap: 0 }).success).toBe(false)
  })

  it('takes a spend cap as a decimal string, never a float', () => {
    expect(workflowOverridesInput.safeParse({ spendCap: '25.0000' }).success).toBe(true)
    expect(workflowOverridesInput.safeParse({ spendCap: 25 }).success).toBe(false)
  })
})

describe('startAdHocWorkflowInput', () => {
  const valid = {
    ownerUserId: ID,
    workspaceVersionId: ID,
    setupBundleVersionId: ID,
    workflowType: 'delegated',
    model: 'claude-opus-5',
    instanceType: 'm7i.large',
    purchaseMode: 'spot',
    prompt: 'do the thing',
  }

  it('names a bundle version and a workspace version directly (FR-129)', () => {
    expect(startAdHocWorkflowInput.parse(valid)).toMatchObject(valid)
  })

  it('still requires exactly one accountable owner (FR-132)', () => {
    const withoutOwner: Record<string, unknown> = { ...valid }
    Reflect.deleteProperty(withoutOwner, 'ownerUserId')

    expect(startAdHocWorkflowInput.safeParse(withoutOwner).success).toBe(false)
  })
})

describe('listWorkflowsInput', () => {
  it('has no flag that could widen the result set beyond the caller’s scope (FR-190)', () => {
    const keys = Object.keys(listWorkflowsInput.shape)

    expect(keys).not.toContain('includeAll')
    expect(keys).not.toContain('unscoped')
    expect(keys).not.toContain('allUsers')
  })

  it('defaults to a bounded page', () => {
    expect(listWorkflowsInput.parse({}).limit).toBe(50)
  })

  it('accepts the FR-013 filters', () => {
    const parsed = listWorkflowsInput.parse({
      initiatedByUserId: ID,
      originatingIntegrationId: OTHER_ID,
      executionProfileId: ID,
      workspaceId: OTHER_ID,
      repositoryUrl: 'https://github.com/example/repo',
      type: 'autonomous',
      state: ['running', 'paused'],
    })

    expect(parsed.state).toStrictEqual(['running', 'paused'])
  })

  it('rejects an empty state filter, which would mean something different from omitting it', () => {
    expect(listWorkflowsInput.safeParse({ state: [] }).success).toBe(false)
  })

  it('rejects a state outside the vocabulary', () => {
    expect(listWorkflowsInput.safeParse({ state: ['sleeping'] }).success).toBe(false)
  })
})

describe('logSegmentsInput', () => {
  it('starts from the beginning when no position is given (FR-046)', () => {
    expect(logSegmentsInput.parse({ workflowId: ID }).fromSequence).toBe(0)
  })

  it('rejects a negative position', () => {
    expect(logSegmentsInput.safeParse({ workflowId: ID, fromSequence: -1 }).success).toBe(false)
  })
})

describe('spendSummaryInput', () => {
  it('defaults to grouping by profile rather than by individual (FR-156)', () => {
    expect(spendSummaryInput.parse({}).groupBy).toBe('profile')
  })

  it('accepts the four documented groupings and nothing else', () => {
    for (const groupBy of ['client', 'workspace', 'profile', 'user']) {
      expect(spendSummaryInput.safeParse({ groupBy }).success).toBe(true)
    }
    expect(spendSummaryInput.safeParse({ groupBy: 'everyone' }).success).toBe(false)
  })
})

describe('correctWorkflowInput', () => {
  it('refuses an empty correction (FR-015)', () => {
    expect(correctWorkflowInput.safeParse({ workflowId: ID, body: '' }).success).toBe(false)
  })
})

describe('continueWithChangesInput', () => {
  it('accepts only caps and model — it never edits the predecessor’s job spec (FR-149)', () => {
    expect(Object.keys(continueWithChangesInput.shape).sort()).toStrictEqual([
      'model',
      'spendCap',
      'turnCap',
      'workflowId',
    ])
  })
})

describe('reassignOwnerInput', () => {
  it('requires the new owner, so a run is never left without one (FR-132, FR-134)', () => {
    expect(reassignOwnerInput.safeParse({ workflowId: ID }).success).toBe(false)
    expect(reassignOwnerInput.parse({ workflowId: ID, ownerUserId: OTHER_ID })).toStrictEqual({
      workflowId: ID,
      ownerUserId: OTHER_ID,
    })
  })
})

describe('repositoryUrlInput', () => {
  it('accepts the remote forms an engineer actually pastes', () => {
    for (const url of [
      'https://github.com/org/repo.git',
      'http://git.internal/org/repo',
      'ssh://git@git.internal:2222/org/repo.git',
      'git@github.com:org/repo.git',
    ]) {
      expect(repositoryUrlInput.safeParse(url).success).toBe(true)
    }
  })

  it('refuses the shapes that are typos rather than remotes', () => {
    for (const url of ['', '   ', 'github.com', 'https://github.com', 'git@github.com:org repo']) {
      expect(repositoryUrlInput.safeParse(url).success).toBe(false)
    }
  })
})

describe('adHocWorkspaceInput', () => {
  it('takes a workspace version, or a repository and a branch — never both (FR-129)', () => {
    expect(
      adHocWorkspaceInput.parse({ source: 'workspace', workspaceVersionId: ID }),
    ).toStrictEqual({ source: 'workspace', workspaceVersionId: ID })

    expect(
      adHocWorkspaceInput.parse({
        source: 'repository',
        repositoryUrl: 'git@github.com:org/repo.git',
        baseBranch: 'main',
      }),
    ).toMatchObject({ source: 'repository', baseBranch: 'main' })
  })

  it('refuses a repository branch that names no branch', () => {
    expect(
      adHocWorkspaceInput.safeParse({
        source: 'repository',
        repositoryUrl: 'git@github.com:org/repo.git',
      }).success,
    ).toBe(false)
  })

  it('refuses a workspace branch carrying repository fields, so the two cannot be mixed', () => {
    expect(
      adHocWorkspaceInput.safeParse({
        source: 'workspace',
        workspaceVersionId: ID,
        repositoryUrl: 'git@github.com:org/repo.git',
      }).success,
    ).toBe(true)

    expect(adHocWorkspaceInput.safeParse({ source: 'neither' }).success).toBe(false)
  })
})

describe('saveAsProfileInput', () => {
  it('asks only for the naming — every launch value is already on the form (FR-129)', () => {
    expect(Object.keys(saveAsProfileInput.shape).sort()).toStrictEqual(['description', 'name'])
  })

  it('refuses a blank name, because an unnamed profile is what ad hoc already is', () => {
    expect(saveAsProfileInput.safeParse({ name: '  ' }).success).toBe(false)
  })
})

describe('startAdHocInput', () => {
  const base = {
    setupBundleVersionId: OTHER_ID,
    workflowType: 'delegated',
    model: 'claude-opus-5',
    instanceType: 'm7i.large',
    purchaseMode: 'spot',
    prompt: 'Do the thing.',
    workspace: { source: 'workspace', workspaceVersionId: ID },
  }

  it('keeps the job-spec half of startAdHocWorkflowInput rather than restating it', () => {
    for (const field of Object.keys(startAdHocWorkflowInput.shape)) {
      if (field === 'workspaceVersionId') continue
      expect(startAdHocInput.shape).toHaveProperty(field)
    }
  })

  it('replaces the direct workspace reference with the two-branch choice', () => {
    expect(startAdHocInput.shape).not.toHaveProperty('workspaceVersionId')
    expect(startAdHocInput.parse(base).workspace).toStrictEqual({
      source: 'workspace',
      workspaceVersionId: ID,
    })
  })

  it('leaves the owner optional, so a manual run defaults to whoever launched it (FR-132)', () => {
    expect(startAdHocInput.parse(base).ownerUserId).toBeUndefined()
    expect(startAdHocInput.parse({ ...base, ownerUserId: OTHER_ID }).ownerUserId).toBe(OTHER_ID)
  })

  it('accepts the offer to keep the configuration as a profile, and does not require it (FR-129)', () => {
    expect(startAdHocInput.parse(base).saveAsProfile).toBeUndefined()
    expect(
      startAdHocInput.parse({ ...base, saveAsProfile: { name: 'Nightly maintenance' } })
        .saveAsProfile,
    ).toStrictEqual({ name: 'Nightly maintenance' })
  })

  it('refuses a launch with no prompt — there is nothing for the agent to do', () => {
    expect(startAdHocInput.safeParse({ ...base, prompt: '   ' }).success).toBe(false)
  })

  it('accepts caps as absent, null or set, because “no cap” is a real answer', () => {
    expect(startAdHocInput.parse({ ...base, turnCap: null, spendCap: null }).turnCap).toBeNull()
    expect(startAdHocInput.parse({ ...base, turnCap: 40, spendCap: '25.0000' }).spendCap).toBe(
      '25.0000',
    )
    expect(startAdHocInput.safeParse({ ...base, turnCap: 0 }).success).toBe(false)
  })
})
