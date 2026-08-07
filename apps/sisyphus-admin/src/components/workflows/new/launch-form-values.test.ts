import { describe, expect, it } from 'vitest'

import type { LaunchFormValues } from './launch-form-values'
import {
  EMPTY_LAUNCH_FORM,
  fieldForIssuePath,
  launchFieldAction,
  toStartAdHocInput,
} from './launch-form-values'

const WORKSPACE_VERSION_ID = '01890a5d-ac96-774b-bcce-b302099a8057'
const BUNDLE_VERSION_ID = '01890a5d-ac96-774b-bcce-b302099a8058'

const filled = (overrides: Partial<LaunchFormValues> = {}): LaunchFormValues => ({
  ...EMPTY_LAUNCH_FORM,
  workspaceSource: 'workspace',
  workspaceVersionId: WORKSPACE_VERSION_ID,
  workflowType: 'delegated',
  model: 'claude-opus-5',
  instanceType: 'm7i.large',
  purchaseMode: 'spot',
  setupBundleVersionId: BUNDLE_VERSION_ID,
  prompt: 'Do the thing.',
  ...overrides,
})

const errorsOf = (values: LaunchFormValues) => {
  const result = toStartAdHocInput(values)
  return result.ok ? {} : result.errors
}

describe('EMPTY_LAUNCH_FORM', () => {
  it('pre-selects nothing, because a default nobody chose still spends money', () => {
    expect(EMPTY_LAUNCH_FORM.model).toBe('')
    expect(EMPTY_LAUNCH_FORM.purchaseMode).toBe('')
    expect(EMPTY_LAUNCH_FORM.workflowType).toBe('')
    expect(EMPTY_LAUNCH_FORM.instanceType).toBe('')
  })

  it('opens on the workspace answer, which is the one with a list behind it', () => {
    expect(EMPTY_LAUNCH_FORM.workspaceSource).toBe('workspace')
  })
})

describe('toStartAdHocInput', () => {
  it('builds a request from a completed form', () => {
    const result = toStartAdHocInput(filled())

    expect(result.ok).toBe(true)
    expect(result.ok ? result.input : undefined).toMatchObject({
      workspace: { source: 'workspace', workspaceVersionId: WORKSPACE_VERSION_ID },
      setupBundleVersionId: BUNDLE_VERSION_ID,
      workflowType: 'delegated',
      model: 'claude-opus-5',
      instanceType: 'm7i.large',
      purchaseMode: 'spot',
      prompt: 'Do the thing.',
    })
  })

  it('sends the repository branch when that is the answer, and never both', () => {
    const result = toStartAdHocInput(
      filled({
        workspaceSource: 'repository',
        repositoryUrl: 'git@github.com:org/repo.git ',
        baseBranch: ' main ',
      }),
    )

    expect(result.ok ? result.input.workspace : undefined).toStrictEqual({
      source: 'repository',
      repositoryUrl: 'git@github.com:org/repo.git',
      baseBranch: 'main',
    })
  })

  it('keeps the chosen workspace out of the request when a repository was entered', () => {
    const result = toStartAdHocInput(
      filled({
        workspaceSource: 'repository',
        repositoryUrl: 'git@github.com:org/repo.git',
        baseBranch: 'main',
      }),
    )
    const workspace = result.ok ? result.input.workspace : undefined

    expect(workspace).not.toHaveProperty('workspaceVersionId')
  })

  it('reads a blank cap as no cap, not as an empty one', () => {
    const result = toStartAdHocInput(filled())

    expect(result.ok ? result.input.turnCap : undefined).toBeNull()
    expect(result.ok ? result.input.spendCap : undefined).toBeNull()
  })

  it('carries a filled cap through, with the spend cap still a decimal string', () => {
    const result = toStartAdHocInput(filled({ turnCap: '40', spendCap: '25.0000' }))

    expect(result.ok ? result.input.turnCap : undefined).toBe(40)
    expect(result.ok ? result.input.spendCap : undefined).toBe('25.0000')
  })

  it('refuses a cap that is not a number rather than quietly launching uncapped', () => {
    expect(errorsOf(filled({ turnCap: '4o' })).turnCap).toBeDefined()
  })

  it('omits a blank ticket reference rather than sending an empty string', () => {
    expect(toStartAdHocInput(filled()).ok).toBe(true)
    const result = toStartAdHocInput(filled())

    expect(result.ok ? result.input.ticketReference : 'set').toBeUndefined()
  })

  describe('saving the configuration as a profile (FR-129)', () => {
    it('saves one exactly when the name is filled in', () => {
      const without = toStartAdHocInput(filled())
      const with_ = toStartAdHocInput(filled({ saveAsProfileName: ' Nightly maintenance ' }))

      expect(without.ok ? without.input.saveAsProfile : 'set').toBeUndefined()
      expect(with_.ok ? with_.input.saveAsProfile : undefined).toStrictEqual({
        name: 'Nightly maintenance',
      })
    })

    it('treats a name of only spaces as not asking, so there is no half-saved state', () => {
      const result = toStartAdHocInput(filled({ saveAsProfileName: '    ' }))

      expect(result.ok ? result.input.saveAsProfile : 'set').toBeUndefined()
    })
  })

  describe('what it refuses, and where it points', () => {
    it('points at every empty required control at once, not one at a time', () => {
      const errors = errorsOf(EMPTY_LAUNCH_FORM)

      expect(Object.keys(errors).sort()).toStrictEqual([
        'instanceType',
        'model',
        'prompt',
        'purchaseMode',
        'setupBundleVersionId',
        'workflowType',
        'workspaceVersionId',
      ])
    })

    it('points at the repository fields when that is the branch being filled in', () => {
      const errors = errorsOf(filled({ workspaceSource: 'repository' }))

      expect(errors.repositoryUrl).toBeDefined()
      expect(errors.baseBranch).toBeDefined()
      expect(errors.workspaceVersionId).toBeUndefined()
    })

    it('refuses a remote that is a typo rather than a URL', () => {
      const errors = errorsOf(
        filled({ workspaceSource: 'repository', repositoryUrl: 'github.com', baseBranch: 'main' }),
      )

      expect(errors.repositoryUrl?.code).toBe('E_LAUNCH_REPOSITORY_URL')
    })

    it('gives every refusal a searchable code and a next action, never a dead end (FR-031)', () => {
      for (const error of Object.values(errorsOf(EMPTY_LAUNCH_FORM))) {
        expect(error.code).toMatch(/^E_LAUNCH_[A-Z_]+$/)
        expect(error.action.length).toBeGreaterThan(0)
      }
    })

    it('names the control in the code, so the code says which field to look at', () => {
      expect(errorsOf(EMPTY_LAUNCH_FORM).setupBundleVersionId?.code).toBe(
        'E_LAUNCH_SETUP_BUNDLE_VERSION_ID',
      )
    })

    it('refuses a blank prompt — a mis-clicked launch must not start an agent with nothing to do', () => {
      expect(errorsOf(filled({ prompt: '   ' })).prompt).toBeDefined()
    })
  })
})

describe('fieldForIssuePath', () => {
  it('reads the nested workspace branch back to the control it came from', () => {
    expect(fieldForIssuePath(['workspace', 'repositoryUrl'])).toBe('repositoryUrl')
    expect(fieldForIssuePath(['workspace', 'workspaceVersionId'])).toBe('workspaceVersionId')
    expect(fieldForIssuePath(['workspace'])).toBe('workspaceSource')
  })

  it('reads a top-level field as itself', () => {
    expect(fieldForIssuePath(['prompt'])).toBe('prompt')
  })

  it('answers undefined for a path that is not a control', () => {
    expect(fieldForIssuePath(['somethingElse'])).toBeUndefined()
  })
})

describe('launchFieldAction', () => {
  it('has a next action for every control', () => {
    for (const field of Object.keys(EMPTY_LAUNCH_FORM)) {
      expect(launchFieldAction(field as keyof LaunchFormValues).length).toBeGreaterThan(0)
    }
  })
})
