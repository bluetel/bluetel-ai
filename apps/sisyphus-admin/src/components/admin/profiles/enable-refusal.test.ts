import { UNEXPECTED_ERROR } from '@sisyphus-admin/components/admin'
import { describe, expect, it } from 'vitest'

import {
  classifyEnableFailure,
  describeEnableRefusal,
  enableFailureCode,
  readEnableFailures,
} from './enable-refusal'

/** The gate's message, exactly as `profileCannotBeEnabledError` composes it. */
const gateMessage = (...lines: readonly string[]): string =>
  ['This execution profile cannot be enabled yet:', ...lines.map((line) => `- ${line}`)].join('\n')

const BUNDLE_LINE =
  'the setup bundle Payments toolchain (version 3) is disabled; enable it before enabling this profile'
const EMPTY_WORKSPACE_LINE =
  'version 4 of the workspace Payments contains no repositories, so a run launched from this profile would have nothing to check out'
const NO_VERSION_LINE =
  'this execution profile has no published version, so there is no configuration to validate'
const UNKNOWN_LINE = 'the launch template failed a check nobody has written a name for yet'

describe('classifyEnableFailure (FR-124)', () => {
  it('recognises a disabled setup bundle', () => {
    expect(classifyEnableFailure(BUNDLE_LINE)).toBe('setup_bundle')
  })

  it('recognises a workspace version with nothing in it', () => {
    expect(classifyEnableFailure(EMPTY_WORKSPACE_LINE)).toBe('workspace_version')
  })

  it('recognises a profile with nothing published', () => {
    expect(classifyEnableFailure(NO_VERSION_LINE)).toBe('profile_version')
  })

  it('falls back rather than dropping a wording the gate grows tomorrow', () => {
    expect(classifyEnableFailure('something new went wrong')).toBe('unclassified')
  })
})

describe('readEnableFailures (FR-124)', () => {
  it('keeps one entry per failing element, which is what the gate went to trouble to collect', () => {
    expect(readEnableFailures(gateMessage(BUNDLE_LINE, EMPTY_WORKSPACE_LINE))).toHaveLength(2)
  })

  it('keeps the gate’s own sentence verbatim, so the failing element stays named', () => {
    const failures = readEnableFailures(gateMessage(EMPTY_WORKSPACE_LINE))

    expect(failures[0]?.detail).toBe(EMPTY_WORKSPACE_LINE)
  })

  it('gives each element a machine code and a next action, never a bare sentence', () => {
    const failures = readEnableFailures(gateMessage(EMPTY_WORKSPACE_LINE))

    expect(failures[0]?.error.code).toBe('E_PROFILE_ENABLE_WORKSPACE_VERSION')
    expect(failures[0]?.error.action).toContain('Publish a workspace version')
  })

  it('drops the preamble, which introduces the list rather than naming a failure', () => {
    const failures = readEnableFailures(gateMessage(BUNDLE_LINE))

    expect(failures).toHaveLength(1)
    expect(failures[0]?.detail).toBe(BUNDLE_LINE)
  })

  it('reports the elements in the order the gate reported them', () => {
    const failures = readEnableFailures(gateMessage(BUNDLE_LINE, EMPTY_WORKSPACE_LINE))

    expect(failures.map((failure) => failure.element)).toEqual([
      'setup_bundle',
      'workspace_version',
    ])
  })

  it('still renders a wording the gate has not been taught yet, rather than dropping the line', () => {
    const failures = readEnableFailures(gateMessage(UNKNOWN_LINE))

    expect(failures).toEqual([
      {
        element: 'unclassified',
        detail: UNKNOWN_LINE,
        error: {
          code: 'E_PROFILE_ENABLE_UNCLASSIFIED',
          action: 'Fix what the line names, then enable again.',
        },
      },
    ])
  })
})

describe('describeEnableRefusal (FR-124, FR-031)', () => {
  it('breaks a gate refusal into one notice per element rather than flattening it', () => {
    const refusal = describeEnableRefusal({
      data: { code: 'CONFLICT' },
      message: gateMessage(BUNDLE_LINE, EMPTY_WORKSPACE_LINE),
    })

    expect(refusal.failures).toHaveLength(2)
  })

  it('says how many elements are listed, so the summary is not a restatement of the list', () => {
    const refusal = describeEnableRefusal({
      data: { code: 'CONFLICT' },
      message: gateMessage(BUNDLE_LINE, EMPTY_WORKSPACE_LINE),
    })

    expect(refusal.error.action).toContain('2 elements are listed below')
  })

  it('reads one element as singular', () => {
    const refusal = describeEnableRefusal({
      data: { code: 'CONFLICT' },
      message: gateMessage(BUNDLE_LINE),
    })

    expect(refusal.error.action).toContain('1 element is listed below')
  })

  it('says nothing changed, which is what decides whether to try again', () => {
    const refusal = describeEnableRefusal({
      data: { code: 'CONFLICT' },
      message: gateMessage(BUNDLE_LINE),
    })

    expect(refusal.error.action).toContain('Nothing changed')
  })

  it('does not invent a gate failure out of a conflict that carries no list', () => {
    const refusal = describeEnableRefusal({
      data: { code: 'CONFLICT' },
      message: 'An execution profile named Payments already exists.',
    })

    expect(refusal.failures).toEqual([])
    expect(refusal.error.code).toBe('E_PROFILE_ENABLE_REFUSED')
  })

  it('sends a vanished profile through the shared mapping rather than the gate reader', () => {
    const refusal = describeEnableRefusal({ data: { code: 'NOT_FOUND' } })

    expect(refusal.failures).toEqual([])
    expect(refusal.error.code).toBe('E_PROFILE_NOT_FOUND')
  })

  it('never produces a dead end', () => {
    expect(describeEnableRefusal('something odd').error).toStrictEqual(UNEXPECTED_ERROR)
  })
})

describe('enableFailureCode', () => {
  it('produces a searchable, quotable code per element', () => {
    expect(enableFailureCode('setup_bundle')).toBe('E_PROFILE_ENABLE_SETUP_BUNDLE')
  })
})
