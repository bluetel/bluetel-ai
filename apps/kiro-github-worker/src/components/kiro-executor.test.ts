/* eslint-disable @typescript-eslint/unbound-method */
import { EventEmitter } from 'node:events'

import type pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ExecutionResult } from '../lib/types'

// ── Mock node:child_process via vi.hoisted ──────────────────────────

const { execFileMock, spawnMock } = vi.hoisted(() => {
  const execFileMock =
    vi.fn<
      (
        cmd: string,
        args: string[],
        options: Record<string, unknown>,
      ) => Promise<{ stdout: string; stderr: string }>
    >()
  const spawnMock = vi.fn()
  return { execFileMock, spawnMock }
})

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: spawnMock,
}))

vi.mock('node:util', async (importOriginal) => {
  const original = await importOriginal()
  return {
    ...(original as Record<string, unknown>),
    promisify: () => execFileMock,
  }
})

// Now import the module under test — it will get our mocked spawn/execFile
import { createKiroExecutor } from './kiro-executor'
import type { SessionHandle } from './session-log-writer'

// ── Mock logger ─────────────────────────────────────────────────────

const createMockLogger = () => {
  const logEntries: Array<{ level: string; args: unknown[] }> = []

  const makeLogFn = (level: string) =>
    vi.fn((...args: unknown[]) => {
      logEntries.push({ level, args })
    })

  const logger = {
    info: makeLogFn('info'),
    warn: makeLogFn('warn'),
    error: makeLogFn('error'),
    debug: makeLogFn('debug'),
    child: vi.fn(() => logger),
  }

  return { logger: logger as unknown as pino.Logger, logEntries }
}

// ── Test config ─────────────────────────────────────────────────────

const defaultConfig = {
  kiroCliPath: '/usr/local/bin/kiro-cli',
  kiroApiKey: 'test-kiro-api-key-abc123',
  timeoutMs: 600_000,
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Creates a mock child process (EventEmitter with stdout/stderr streams).
 * Emits 'close' with the given exit code after a microtask.
 */
const createMockChildProcess = (opts?: {
  exitCode?: number | null
  stdout?: string
  stderr?: string
  emitError?: Error
}) => {
  const { exitCode = 0, stdout = '', stderr = '', emitError } = opts ?? {}

  const child = new EventEmitter() as EventEmitter & {
    pid: number
    stdout: EventEmitter
    stderr: EventEmitter
    kill: ReturnType<typeof vi.fn>
  }
  child.pid = 12345
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()

  // Schedule output and close events
  queueMicrotask(() => {
    if (emitError) {
      child.emit('error', emitError)
      return
    }
    if (stdout) {
      child.stdout.emit('data', Buffer.from(stdout))
    }
    if (stderr) {
      child.stderr.emit('data', Buffer.from(stderr))
    }
    child.emit('close', exitCode)
  })

  return child
}

/**
 * Sets up execFileMock to handle git commands (getCurrentBranch,
 * getRemoteHeadSha, fetch, post-fetch SHA) and spawnMock for the CLI call.
 */
const setupSuccessfulExecution = (opts?: {
  stdout?: string
  stderr?: string
  preExecSha?: string
  postExecSha?: string
  branchName?: string
}) => {
  const {
    stdout = 'kiro output',
    stderr = '',
    preExecSha = 'abc123pre',
    postExecSha = 'def456post',
    branchName = 'feature/test-branch',
  } = opts ?? {}

  execFileMock.mockImplementation((cmd: string, args: string[]) => {
    // git rev-parse --abbrev-ref HEAD → branch name
    if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
      return Promise.resolve({ stdout: `${branchName}\n`, stderr: '' })
    }
    // git rev-parse origin/{branch} → SHA (pre-exec or post-exec)
    if (cmd === 'git' && args[0] === 'rev-parse' && args[1].startsWith('origin/')) {
      const revParseCallCount = execFileMock.mock.calls.filter(
        (c) => c[0] === 'git' && c[1][0] === 'rev-parse' && c[1][1].startsWith('origin/'),
      ).length
      const sha = revParseCallCount <= 1 ? preExecSha : postExecSha
      return Promise.resolve({ stdout: `${sha}\n`, stderr: '' })
    }
    // git fetch origin
    if (cmd === 'git' && args[0] === 'fetch') {
      return Promise.resolve({ stdout: '', stderr: '' })
    }
    return Promise.resolve({ stdout: '', stderr: '' })
  })

  // Mock spawn for the kiro CLI call
  spawnMock.mockImplementation(() => createMockChildProcess({ stdout, stderr, exitCode: 0 }))
}

// ── Mock session handle ─────────────────────────────────────────────

const createMockSessionHandle = (): SessionHandle => ({
  writePrompt: vi.fn(),
  writeSetupScript: vi.fn(),
  writeStdout: vi.fn(),
  writeStderr: vi.fn(),
  finalize: vi.fn(() => Promise.resolve()),
  filePath: '/tmp/test-session.log',
})

// ── Tests ───────────────────────────────────────────────────────────

describe('Kiro_Executor', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    execFileMock.mockReset()
    spawnMock.mockReset()
  })

  describe('successful execution', () => {
    it('returns ExecutionResult with success: true and captured stdout/stderr', async () => {
      const { logger } = createMockLogger()
      const executor = createKiroExecutor(defaultConfig, logger)

      setupSuccessfulExecution({
        stdout: 'Kiro completed task',
        stderr: 'some warnings',
        preExecSha: 'aaa111',
        postExecSha: 'bbb222',
      })

      const result: ExecutionResult = await executor.execute('/tmp/work', 'Fix the bug')

      expect(result.success).toBe(true)
      expect(result.stdout).toBe('Kiro completed task')
      expect(result.stderr).toBe('some warnings')
      expect(result.exitCode).toBe(0)
    })

    it('sets hasChanges to true when remote SHA advances', async () => {
      const { logger } = createMockLogger()
      const executor = createKiroExecutor(defaultConfig, logger)

      setupSuccessfulExecution({
        preExecSha: 'sha-before',
        postExecSha: 'sha-after',
      })

      const result = await executor.execute('/tmp/work', 'Add feature')

      expect(result.hasChanges).toBe(true)
    })

    it('sets hasChanges to false when remote SHA does not change', async () => {
      const { logger } = createMockLogger()
      const executor = createKiroExecutor(defaultConfig, logger)

      setupSuccessfulExecution({
        preExecSha: 'same-sha',
        postExecSha: 'same-sha',
      })

      const result = await executor.execute('/tmp/work', 'Lint only')

      expect(result.hasChanges).toBe(false)
    })

    it('invokes spawn with the kiro CLI path, chat flags, and the prompt', async () => {
      const { logger } = createMockLogger()
      const executor = createKiroExecutor(defaultConfig, logger)

      setupSuccessfulExecution()

      await executor.execute('/tmp/work', 'Implement the feature')

      expect(spawnMock).toHaveBeenCalledWith(
        defaultConfig.kiroCliPath,
        [
          'chat',
          '--no-interactive',
          '--trust-all-tools',
          '--require-mcp-startup',
          'Implement the feature',
        ],
        expect.objectContaining({
          cwd: '/tmp/work',
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      )
    })
  })

  describe('session handle piping', () => {
    it('calls writeStdout on the session handle with stdout chunks', async () => {
      const { logger } = createMockLogger()
      const executor = createKiroExecutor(defaultConfig, logger)
      const handle = createMockSessionHandle()

      setupSuccessfulExecution({ stdout: 'hello from kiro' })

      await executor.execute('/tmp/work', 'Do something', { sessionHandle: handle })

      expect(handle.writeStdout).toHaveBeenCalledWith('hello from kiro')
    })

    it('calls writeStderr on the session handle with stderr chunks', async () => {
      const { logger } = createMockLogger()
      const executor = createKiroExecutor(defaultConfig, logger)
      const handle = createMockSessionHandle()

      setupSuccessfulExecution({ stderr: 'warning from kiro' })

      await executor.execute('/tmp/work', 'Do something', { sessionHandle: handle })

      expect(handle.writeStderr).toHaveBeenCalledWith('warning from kiro')
    })

    it('calls both writeStdout and writeStderr when both streams produce output', async () => {
      const { logger } = createMockLogger()
      const executor = createKiroExecutor(defaultConfig, logger)
      const handle = createMockSessionHandle()

      setupSuccessfulExecution({ stdout: 'out data', stderr: 'err data' })

      await executor.execute('/tmp/work', 'Do something', { sessionHandle: handle })

      expect(handle.writeStdout).toHaveBeenCalledWith('out data')
      expect(handle.writeStderr).toHaveBeenCalledWith('err data')
    })

    it('works normally without a session handle (undefined)', async () => {
      const { logger } = createMockLogger()
      const executor = createKiroExecutor(defaultConfig, logger)

      setupSuccessfulExecution({ stdout: 'output', preExecSha: 'a', postExecSha: 'b' })

      const result = await executor.execute('/tmp/work', 'Do something')

      expect(result.success).toBe(true)
      expect(result.stdout).toBe('output')
    })

    it('works normally when options is provided but sessionHandle is undefined', async () => {
      const { logger } = createMockLogger()
      const executor = createKiroExecutor(defaultConfig, logger)

      setupSuccessfulExecution({ stdout: 'output', preExecSha: 'a', postExecSha: 'b' })

      const result = await executor.execute('/tmp/work', 'Do something', {
        sessionHandle: undefined,
      })

      expect(result.success).toBe(true)
      expect(result.stdout).toBe('output')
    })

    it('does not call session handle methods when no handle is provided', async () => {
      const { logger } = createMockLogger()
      const executor = createKiroExecutor(defaultConfig, logger)

      setupSuccessfulExecution({ stdout: 'output', stderr: 'errors' })

      // Execute without session handle — should not throw
      const result = await executor.execute('/tmp/work', 'Do something')

      expect(result.success).toBe(true)
    })

    it('pipes stdout to session handle even when execution fails with non-zero exit code', async () => {
      const { logger } = createMockLogger()
      const executor = createKiroExecutor(defaultConfig, logger)
      const handle = createMockSessionHandle()

      execFileMock.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
          return Promise.resolve({ stdout: 'main\n', stderr: '' })
        }
        if (cmd === 'git' && args[0] === 'rev-parse' && args[1]?.startsWith('origin/')) {
          return Promise.resolve({ stdout: 'abc123\n', stderr: '' })
        }
        return Promise.resolve({ stdout: '', stderr: '' })
      })

      spawnMock.mockImplementation(() =>
        createMockChildProcess({
          exitCode: 1,
          stdout: 'partial output',
          stderr: 'error output',
        }),
      )

      const result = await executor.execute('/tmp/work', 'Do something', {
        sessionHandle: handle,
      })

      expect(result.success).toBe(false)
      expect(handle.writeStdout).toHaveBeenCalledWith('partial output')
      expect(handle.writeStderr).toHaveBeenCalledWith('error output')
    })
  })

  describe('timeout handling', () => {
    it('returns success: false with timeout message when process is killed by timeout', async () => {
      const { logger } = createMockLogger()
      const config = { ...defaultConfig, timeoutMs: 50 }
      const executor = createKiroExecutor(config, logger)

      execFileMock.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
          return Promise.resolve({ stdout: 'main\n', stderr: '' })
        }
        if (cmd === 'git' && args[0] === 'rev-parse' && args[1]?.startsWith('origin/')) {
          return Promise.resolve({ stdout: 'abc123\n', stderr: '' })
        }
        return Promise.resolve({ stdout: '', stderr: '' })
      })

      spawnMock.mockImplementation(() => {
        const child = new EventEmitter() as EventEmitter & {
          pid: number
          stdout: EventEmitter
          stderr: EventEmitter
          kill: ReturnType<typeof vi.fn>
        }
        child.pid = 99999
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.kill = vi.fn()

        setTimeout(() => {
          child.emit('close', null)
        }, 100)

        return child
      })

      const result = await executor.execute('/tmp/work', 'Do something')

      expect(result.success).toBe(false)
      expect(result.hasChanges).toBe(false)
      expect(result.stderr).toContain('timed out')
      expect(result.stderr).toContain('50')
      expect(result.exitCode).toBeNull()
    })
  })

  describe('non-zero exit code', () => {
    it('returns success: false with exitCode and stderr', async () => {
      const { logger } = createMockLogger()
      const executor = createKiroExecutor(defaultConfig, logger)

      execFileMock.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
          return Promise.resolve({ stdout: 'main\n', stderr: '' })
        }
        if (cmd === 'git' && args[0] === 'rev-parse' && args[1]?.startsWith('origin/')) {
          return Promise.resolve({ stdout: 'abc123\n', stderr: '' })
        }
        return Promise.resolve({ stdout: '', stderr: '' })
      })

      spawnMock.mockImplementation(() =>
        createMockChildProcess({
          exitCode: 42,
          stdout: 'partial output',
          stderr: 'kiro error: something went wrong',
        }),
      )

      const result = await executor.execute('/tmp/work', 'Do something')

      expect(result.success).toBe(false)
      expect(result.hasChanges).toBe(false)
      expect(result.exitCode).toBe(42)
      expect(result.stdout).toBe('partial output')
      expect(result.stderr).toBe('kiro error: something went wrong')
    })
  })

  describe('environment variables', () => {
    it('sets KIRO_API_KEY and CI in child process environment', async () => {
      const { logger } = createMockLogger()
      const executor = createKiroExecutor(defaultConfig, logger)

      setupSuccessfulExecution()

      await executor.execute('/tmp/work', 'Do something')

      const spawnCall = spawnMock.mock.calls[0]
      expect(spawnCall).toBeDefined()

      const options = spawnCall[2] as { env: Record<string, string> }
      expect(options.env.KIRO_API_KEY).toBe('test-kiro-api-key-abc123')
      expect(options.env.CI).toBe('true')
    })
  })

  describe('child logger context', () => {
    it('creates a child logger with step: "kiro-execute" and workingDir', async () => {
      const { logger } = createMockLogger()
      const executor = createKiroExecutor(defaultConfig, logger)

      setupSuccessfulExecution()

      await executor.execute('/tmp/my-work', 'Do something')

      expect(logger.child).toHaveBeenCalledWith({
        step: 'kiro-execute',
        workingDir: '/tmp/my-work',
      })
    })
  })

  describe('agent selection', () => {
    it('includes --agent flag before chat when agent is specified', async () => {
      const { logger } = createMockLogger()
      const executor = createKiroExecutor(defaultConfig, logger)

      setupSuccessfulExecution()

      await executor.execute('/tmp/work', 'Implement feature', { agent: 'spec-orchestrator' })

      expect(spawnMock).toHaveBeenCalledWith(
        defaultConfig.kiroCliPath,
        [
          '--agent',
          'spec-orchestrator',
          'chat',
          '--no-interactive',
          '--trust-all-tools',
          '--require-mcp-startup',
          'Implement feature',
        ],
        expect.objectContaining({ cwd: '/tmp/work' }),
      )
    })

    it('does not include --agent flag when agent is undefined', async () => {
      const { logger } = createMockLogger()
      const executor = createKiroExecutor(defaultConfig, logger)

      setupSuccessfulExecution()

      await executor.execute('/tmp/work', 'Implement feature')

      expect(spawnMock).toHaveBeenCalledWith(
        defaultConfig.kiroCliPath,
        [
          'chat',
          '--no-interactive',
          '--trust-all-tools',
          '--require-mcp-startup',
          'Implement feature',
        ],
        expect.objectContaining({ cwd: '/tmp/work' }),
      )
    })

    it('does not include --agent flag when agent is empty string', async () => {
      const { logger } = createMockLogger()
      const executor = createKiroExecutor(defaultConfig, logger)

      setupSuccessfulExecution()

      await executor.execute('/tmp/work', 'Implement feature', { agent: '' })

      expect(spawnMock).toHaveBeenCalledWith(
        defaultConfig.kiroCliPath,
        [
          'chat',
          '--no-interactive',
          '--trust-all-tools',
          '--require-mcp-startup',
          'Implement feature',
        ],
        expect.objectContaining({ cwd: '/tmp/work' }),
      )
    })
  })
})
