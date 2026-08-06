import { describe, expect, it } from 'vitest'

import { CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL, isClaudeModel } from './claude-model'

describe('CLAUDE_MODELS', () => {
  it('is the research.md R15 allowlist, in order', () => {
    expect([...CLAUDE_MODELS]).toStrictEqual([
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-haiku-4-5',
      'claude-fable-5',
    ])
  })

  it('carries no date suffixes — ids are used exactly as written (R15)', () => {
    for (const model of CLAUDE_MODELS) {
      expect(model).not.toMatch(/-\d{8}$/)
      expect(model).toMatch(/^claude-[a-z]+-\d+(-\d+)?$/)
    }
  })

  it('defaults to the model R15 names as the default', () => {
    expect(DEFAULT_CLAUDE_MODEL).toBe('claude-opus-5')
    expect(CLAUDE_MODELS).toContain(DEFAULT_CLAUDE_MODEL)
  })

  it('rejects a dated id, which is the failure mode the allowlist exists to prevent', () => {
    expect(isClaudeModel('claude-opus-5')).toBe(true)
    expect(isClaudeModel('claude-opus-5-20260101')).toBe(false)
    expect(isClaudeModel('gpt-4')).toBe(false)
  })
})
