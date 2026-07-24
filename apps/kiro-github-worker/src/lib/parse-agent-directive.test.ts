import { describe, expect, it } from 'vitest'

import { parseAgentDirective } from './parse-agent-directive'

describe('parseAgentDirective', () => {
  it('matches standard agent: directive', () => {
    expect(parseAgentDirective('agent: spec-orchestrator')).toBe('spec-orchestrator')
  })

  it('is case-insensitive for the key', () => {
    expect(parseAgentDirective('Agent: my-agent')).toBe('my-agent')
    expect(parseAgentDirective('AGENT: my-agent')).toBe('my-agent')
  })

  it('returns undefined when no match', () => {
    expect(parseAgentDirective('no directive here')).toBeUndefined()
    expect(parseAgentDirective('')).toBeUndefined()
  })

  it('returns first match when multiple directives present', () => {
    const text = 'some text\nagent: first-agent\nmore text\nagent: second-agent'
    expect(parseAgentDirective(text)).toBe('first-agent')
  })

  it('handles names with hyphens and underscores', () => {
    expect(parseAgentDirective('agent: my_agent-v2')).toBe('my_agent-v2')
  })

  it('handles names with dots', () => {
    expect(parseAgentDirective('agent: agent.v2')).toBe('agent.v2')
  })

  it('ignores lines where agent: is not at the start', () => {
    expect(parseAgentDirective('  use agent: foo')).toBeUndefined()
  })

  it('handles extra whitespace after colon', () => {
    expect(parseAgentDirective('agent:   spec-agent')).toBe('spec-agent')
  })
})
