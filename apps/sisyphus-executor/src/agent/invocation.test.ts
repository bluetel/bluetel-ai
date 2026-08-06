import { describe, expect, it } from 'vitest'

import type { AgentStartOptions } from './adapter'
import { buildClaudeArgs, buildClaudeEnv, claudeProcessSpec, CLAUDE_COMMAND } from './invocation'

const START: AgentStartOptions = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  cwd: '/workspace',
  model: 'claude-sonnet-4-5',
  prompt: 'do the thing',
}

const pairAfter = (args: readonly string[], flag: string): string | undefined => {
  const index = args.indexOf(flag)

  return index === -1 ? undefined : args[index + 1]
}

describe('buildClaudeArgs', () => {
  it('carries the three flags the CLI refuses to start without', () => {
    const args = buildClaudeArgs(START)

    expect(args).toContain('--print')
    expect(pairAfter(args, '--input-format')).toBe('stream-json')
    expect(pairAfter(args, '--output-format')).toBe('stream-json')
    expect(args).toContain('--verbose')
  })

  it('asks for user-message replay, which is the acknowledgement channel', () => {
    expect(buildClaudeArgs(START)).toContain('--replay-user-messages')
  })

  it('passes the platform-assigned session id rather than parsing one back out', () => {
    expect(pairAfter(buildClaudeArgs(START), '--session-id')).toBe(START.sessionId)
  })

  it('runs without permission prompts, because nobody is there to answer one', () => {
    expect(pairAfter(buildClaudeArgs(START), '--permission-mode')).toBe('bypassPermissions')
  })

  it('omits --max-turns when no cap was set', () => {
    expect(buildClaudeArgs(START)).not.toContain('--max-turns')
  })

  it('passes a turn cap through as the agent-side second line', () => {
    expect(pairAfter(buildClaudeArgs({ ...START, turnCap: 25 }), '--max-turns')).toBe('25')
  })

  it('omits --resume on a cold start', () => {
    expect(buildClaudeArgs(START)).not.toContain('--resume')
  })

  it('resumes under the snapshot session id, not the run own id (FR-150)', () => {
    const args = buildClaudeArgs({ ...START, resumeSessionId: 'predecessor-session' })

    expect(pairAfter(args, '--resume')).toBe('predecessor-session')
    // The successor keeps its own identity for addressing and future snapshots.
    expect(pairAfter(args, '--session-id')).toBe(START.sessionId)
  })
})

describe('buildClaudeEnv', () => {
  it('relocates the config tree inside the pinned root when asked (FR-051)', () => {
    expect(buildClaudeEnv({ ...START, configDir: '/workspace/.agent-config' })).toEqual({
      CLAUDE_CONFIG_DIR: '/workspace/.agent-config',
    })
  })

  it('sets nothing when no config directory was supplied', () => {
    expect(buildClaudeEnv(START)).toEqual({})
  })
})

describe('claudeProcessSpec', () => {
  it('spawns the CLI the setup bundle installed', () => {
    const spec = claudeProcessSpec({ ...START, configDir: '/workspace/.agent-config' })

    expect(spec.command).toBe(CLAUDE_COMMAND)
    expect(spec.args).toEqual(buildClaudeArgs(START))
    expect(spec.env['CLAUDE_CONFIG_DIR']).toBe('/workspace/.agent-config')
  })
})
