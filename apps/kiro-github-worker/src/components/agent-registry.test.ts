import type pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'

// ── Mock node:child_process via vi.hoisted ──────────────────────────

const { execFileMock } = vi.hoisted(() => {
  const execFileMock =
    vi.fn<
      (
        cmd: string,
        args: string[],
        options: Record<string, unknown>,
      ) => Promise<{ stdout: string; stderr: string }>
    >()
  return { execFileMock }
})

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

vi.mock('node:util', async (importOriginal) => {
  const original = await importOriginal()
  return {
    ...(original as Record<string, unknown>),
    promisify: () => execFileMock,
  }
})

import { createAgentRegistry, parseAgentOutput } from './agent-registry'

// ── Mock logger ─────────────────────────────────────────────────────

const createMockLogger = () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => logger),
  }
  return logger as unknown as pino.Logger
}

// ── parseAgentOutput tests ──────────────────────────────────────────

describe('parseAgentOutput', () => {
  it('parses standard multi-agent output', () => {
    const output = [
      '* kiro_default            (Built-in)    Default agent',
      '  kiro_help               (Built-in)    Help agent',
      '  spec-orchestrator       (Global)      Orchestrates specs',
      '  workspace-agent         (Workspace)   Local agent',
    ].join('\n')

    const agents = parseAgentOutput(output)

    expect(agents).toHaveLength(4)
    expect(agents[0]).toEqual({
      name: 'kiro_default',
      scope: 'builtin',
      description: 'Default agent',
      isDefault: true,
    })
    expect(agents[1]).toEqual({
      name: 'kiro_help',
      scope: 'builtin',
      description: 'Help agent',
      isDefault: false,
    })
    expect(agents[2]).toEqual({
      name: 'spec-orchestrator',
      scope: 'global',
      description: 'Orchestrates specs',
      isDefault: false,
    })
    expect(agents[3]).toEqual({
      name: 'workspace-agent',
      scope: 'workspace',
      description: 'Local agent',
      isDefault: false,
    })
  })

  it('parses single agent output', () => {
    const output = '* kiro_default            (Built-in)    Default agent\n'
    const agents = parseAgentOutput(output)

    expect(agents).toHaveLength(1)
    expect(agents[0].name).toBe('kiro_default')
    expect(agents[0].isDefault).toBe(true)
  })

  it('returns empty array for empty output', () => {
    expect(parseAgentOutput('')).toEqual([])
    expect(parseAgentOutput('\n\n')).toEqual([])
  })

  it('handles multi-line descriptions with continuation', () => {
    const output = [
      '* kiro_default            (Built-in)    Default agent',
      '  spec-orchestrator       (Global)      Orchestrates spec-driven development',
      '                                         It selects the workflow type and delegates',
      '                                         to the appropriate sub-agent.',
    ].join('\n')

    const agents = parseAgentOutput(output)

    expect(agents).toHaveLength(2)
    expect(agents[1].description).toBe(
      'Orchestrates spec-driven development It selects the workflow type and delegates to the appropriate sub-agent.',
    )
  })

  it('detects default agent by * prefix', () => {
    const output = [
      '  kiro_help               (Built-in)    Help agent',
      '* spec-orchestrator       (Global)      Orchestrates specs',
    ].join('\n')

    const agents = parseAgentOutput(output)
    expect(agents[0].isDefault).toBe(false)
    expect(agents[1].isDefault).toBe(true)
  })

  it('falls back to kiro_default when no * prefix', () => {
    const output = [
      '  kiro_default            (Built-in)    Default agent',
      '  kiro_help               (Built-in)    Help agent',
    ].join('\n')

    const agents = parseAgentOutput(output)
    expect(agents[0].isDefault).toBe(true)
    expect(agents[1].isDefault).toBe(false)
  })

  it('falls back to first agent when no * and no kiro_default', () => {
    const output = [
      '  custom-agent            (Global)      Custom',
      '  other-agent             (Global)      Other',
    ].join('\n')

    const agents = parseAgentOutput(output)
    expect(agents[0].isDefault).toBe(true)
    expect(agents[1].isDefault).toBe(false)
  })

  it('normalizes scope values', () => {
    const output = [
      '* a                       (Built-in)    X',
      '  b                       (Global)      Y',
      '  c                       (Workspace)   Z',
    ].join('\n')

    const agents = parseAgentOutput(output)
    expect(agents[0].scope).toBe('builtin')
    expect(agents[1].scope).toBe('global')
    expect(agents[2].scope).toBe('workspace')
  })
})

// ── createAgentRegistry tests ───────────────────────────────────────

describe('createAgentRegistry', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const config = { kiroCliPath: '/usr/local/bin/kiro-cli', timeoutMs: 10_000 }

  it('discovers agents on creation', async () => {
    const output = '* kiro_default            (Built-in)    Default agent\n'
    execFileMock.mockResolvedValueOnce({ stdout: output, stderr: '' })

    const logger = createMockLogger()
    const registry = createAgentRegistry(config, logger)

    // Wait for async discovery
    await vi.waitFor(() => {
      expect(registry.getAgents()).toHaveLength(1)
    })

    expect(registry.getAgents()[0].name).toBe('kiro_default')
    expect(registry.getState().discoveredAt).not.toBeNull()
  })

  it('starts with empty list before discovery completes', () => {
    execFileMock.mockReturnValue(new Promise(() => {})) // Never resolves

    const logger = createMockLogger()
    const registry = createAgentRegistry(config, logger)

    expect(registry.getAgents()).toEqual([])
    expect(registry.getState().discoveredAt).toBeNull()
  })

  it('logs warning and starts empty on CLI failure', async () => {
    const error = new Error('Command failed') as Error & { stderr: string }
    error.stderr = 'kiro-cli: not found'
    execFileMock.mockRejectedValueOnce(error)

    const logger = createMockLogger()
    const registry = createAgentRegistry(config, logger)

    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalled()
    })

    expect(registry.getAgents()).toEqual([])
  })

  it('logs warning on timeout', async () => {
    const abortError = new Error('aborted')
    abortError.name = 'AbortError'
    execFileMock.mockRejectedValueOnce(abortError)

    const logger = createMockLogger()
    const registry = createAgentRegistry(config, logger)

    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('timed out'),
        expect.anything(),
      )
    })

    expect(registry.getAgents()).toEqual([])
  })

  it('getAgent returns agent by name', async () => {
    const output = [
      '* kiro_default            (Built-in)    Default',
      '  spec-agent              (Global)      Spec',
    ].join('\n')
    execFileMock.mockResolvedValueOnce({ stdout: output, stderr: '' })

    const logger = createMockLogger()
    const registry = createAgentRegistry(config, logger)

    await vi.waitFor(() => {
      expect(registry.getAgents()).toHaveLength(2)
    })

    expect(registry.getAgent('spec-agent')?.name).toBe('spec-agent')
    expect(registry.getAgent('nonexistent')).toBeUndefined()
  })

  it('refresh replaces cached list on success', async () => {
    const output1 = '* kiro_default            (Built-in)    Default\n'
    const output2 = [
      '* kiro_default            (Built-in)    Default',
      '  new-agent               (Global)      New',
    ].join('\n')

    execFileMock.mockResolvedValueOnce({ stdout: output1, stderr: '' })

    const logger = createMockLogger()
    const registry = createAgentRegistry(config, logger)

    await vi.waitFor(() => {
      expect(registry.getAgents()).toHaveLength(1)
    })

    execFileMock.mockResolvedValueOnce({ stdout: output2, stderr: '' })
    const agents = await registry.refresh()

    expect(agents).toHaveLength(2)
    expect(registry.getAgents()).toHaveLength(2)
  })

  it('falls back to stderr when stdout is empty (non-TTY mode)', async () => {
    const output = '* kiro_default            (Built-in)    Default agent\n'
    execFileMock.mockResolvedValueOnce({ stdout: '', stderr: output })

    const logger = createMockLogger()
    const registry = createAgentRegistry(config, logger)

    await vi.waitFor(() => {
      expect(registry.getAgents()).toHaveLength(1)
    })

    expect(registry.getAgents()[0].name).toBe('kiro_default')
  })

  it('refresh preserves previous list on failure', async () => {
    const output = '* kiro_default            (Built-in)    Default\n'
    execFileMock.mockResolvedValueOnce({ stdout: output, stderr: '' })

    const logger = createMockLogger()
    const registry = createAgentRegistry(config, logger)

    await vi.waitFor(() => {
      expect(registry.getAgents()).toHaveLength(1)
    })

    execFileMock.mockRejectedValueOnce(new Error('CLI crashed'))
    const agents = await registry.refresh()

    // Should still have the old list
    expect(agents).toHaveLength(1)
    expect(registry.getAgents()).toHaveLength(1)
    expect(registry.getAgents()[0].name).toBe('kiro_default')
  })
})
