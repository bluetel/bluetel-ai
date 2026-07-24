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
import { createClaudeExecutor } from './claude-executor'
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
  claudeCliPath: '/usr/local/bin/claude',
  anthropicApiKey: 'sk-ant-test-key-abc123',
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
    stdout = 'claude output',
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

  // Mock spawn for the claude CLI call
  spawnMock.mockImplementation(() => createMockChildProcess({ stdout, stderr, exitCode: 0 }))
}

// ── Tests ───────────────────────────────────────────────────────────

describe('Claude_Executor', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    execFileMock.mockReset()
    spawnMock.mockReset()
  })

  describe('successful execution', () => {
    it('returns ExecutionResult with success: true and captured stdout/stderr', async () => {
      const { logger } = createMockLogger()
      const executor = createClaudeExecutor(defaultConfig, logger)

      setupSuccessfulExecution({
        stdout: 'Claude completed task',
        stderr: 'some warnings',
        preExecSha: 'aaa111',
        postExecSha: 'bbb222',
      })

      const result: ExecutionResult = await executor.execute('/tmp/work', 'Fix the bug')

      expect(result.success).toBe(true)
      expect(result.stdout).toBe('Claude completed task')
      expect(result.stderr).toBe('some warnings')
      expect(result.exitCode).toBe(0)
    })

    it('sets hasChanges to true when remote SHA advances', async () => {
      const { logger } = createMockLogger()
      const executor = createClaudeExecutor(defaultConfig, logger)

      setupSuccessfulExecution({
        preExecSha: 'sha-before',
        postExecSha: 'sha-after',
      })

      const result = await executor.execute('/tmp/work', 'Add feature')

      expect(result.hasChanges).toBe(true)
    })

    it('sets hasChanges to false when remote SHA does not change', async () => {
      const { logger } = createMockLogger()
      const executor = createClaudeExecutor(defaultConfig, logger)

      setupSuccessfulExecution({
        preExecSha: 'same-sha',
        postExecSha: 'same-sha',
      })

      const result = await executor.execute('/tmp/work', 'Lint only')

      expect(result.hasChanges).toBe(false)
    })

    it('invokes spawn with the claude CLI path, -p flag, prompt, and bypass permissions', async () => {
      const { logger } = createMockLogger()
      const executor = createClaudeExecutor(defaultConfig, logger)

      setupSuccessfulExecution()

      await executor.execute('/tmp/work', 'Implement the feature')

      expect(spawnMock).toHaveBeenCalledWith(
        defaultConfig.claudeCliPath,
        [
          '-p',
          'Implement the feature',
          '--permission-mode',
          'bypassPermissions',
          '--output-format',
          'text',
        ],
        expect.objectContaining({
          cwd: '/tmp/work',
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      )
    })
  })

  describe('timeout handling', () => {
    it('returns success: false with timeout message when process is killed by timeout', async () => {
      const { logger } = createMockLogger()
      const config = { ...defaultConfig, timeoutMs: 50 }
      const executor = createClaudeExecutor(config, logger)

      // Set up git commands
      execFileMock.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
          return Promise.resolve({ stdout: 'main\n', stderr: '' })
        }
        if (cmd === 'git' && args[0] === 'rev-parse' && args[1]?.startsWith('origin/')) {
          return Promise.resolve({ stdout: 'abc123\n', stderr: '' })
        }
        return Promise.resolve({ stdout: '', stderr: '' })
      })

      // Mock spawn to create a child that never completes (simulating timeout)
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

        // Simulate: after the timeout fires and kills the process group,
        // the child emits 'close' with null exit code (killed by signal)
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
      const executor = createClaudeExecutor(defaultConfig, logger)

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
          stderr: 'claude error: something went wrong',
        }),
      )

      const result = await executor.execute('/tmp/work', 'Do something')

      expect(result.success).toBe(false)
      expect(result.hasChanges).toBe(false)
      expect(result.exitCode).toBe(42)
      expect(result.stdout).toBe('partial output')
      expect(result.stderr).toBe('claude error: something went wrong')
    })
  })

  describe('environment variables', () => {
    it('sets ANTHROPIC_API_KEY and CI in child process environment when anthropicApiKey is configured', async () => {
      const { logger } = createMockLogger()
      const executor = createClaudeExecutor(defaultConfig, logger)

      setupSuccessfulExecution()

      await executor.execute('/tmp/work', 'Do something')

      const spawnCall = spawnMock.mock.calls[0]
      expect(spawnCall).toBeDefined()

      const options = spawnCall[2] as { env: Record<string, string> }
      expect(options.env.ANTHROPIC_API_KEY).toBe('sk-ant-test-key-abc123')
      expect(options.env.CI).toBe('true')
    })

    it('does NOT set ANTHROPIC_API_KEY in child process environment when anthropicApiKey is undefined', async () => {
      const { logger } = createMockLogger()
      const configWithoutKey = {
        claudeCliPath: defaultConfig.claudeCliPath,
        anthropicApiKey: undefined,
        timeoutMs: defaultConfig.timeoutMs,
      }
      const executor = createClaudeExecutor(configWithoutKey, logger)

      setupSuccessfulExecution()

      await executor.execute('/tmp/work', 'Do something')

      const spawnCall = spawnMock.mock.calls[0]
      expect(spawnCall).toBeDefined()

      const options = spawnCall[2] as { env: Record<string, string> }
      expect(options.env).not.toHaveProperty('ANTHROPIC_API_KEY')
      expect(options.env.CI).toBe('true')
    })

    it('sets cwd to the provided working directory', async () => {
      const { logger } = createMockLogger()
      const executor = createClaudeExecutor(defaultConfig, logger)

      setupSuccessfulExecution()

      await executor.execute('/my/custom/workdir', 'Do something')

      const spawnCall = spawnMock.mock.calls[0]
      expect(spawnCall).toBeDefined()

      const options = spawnCall[2] as { cwd: string }
      expect(options.cwd).toBe('/my/custom/workdir')
    })
  })

  describe('process group killing', () => {
    it('spawns with detached: true to create a new process group', async () => {
      const { logger } = createMockLogger()
      const executor = createClaudeExecutor(defaultConfig, logger)

      setupSuccessfulExecution()

      await executor.execute('/tmp/work', 'Do something')

      const spawnCall = spawnMock.mock.calls[0]
      const options = spawnCall[2] as { detached: boolean }
      expect(options.detached).toBe(true)
    })

    it('kills the entire process group on timeout using negative PID', async () => {
      const { logger } = createMockLogger()
      const config = { ...defaultConfig, timeoutMs: 50 }
      const executor = createClaudeExecutor(config, logger)

      execFileMock.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
          return Promise.resolve({ stdout: 'main\n', stderr: '' })
        }
        if (cmd === 'git' && args[0] === 'rev-parse' && args[1]?.startsWith('origin/')) {
          return Promise.resolve({ stdout: 'abc123\n', stderr: '' })
        }
        return Promise.resolve({ stdout: '', stderr: '' })
      })

      const processKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)

      spawnMock.mockImplementation(() => {
        const child = new EventEmitter() as EventEmitter & {
          pid: number
          stdout: EventEmitter
          stderr: EventEmitter
          kill: ReturnType<typeof vi.fn>
        }
        child.pid = 54321
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.kill = vi.fn()

        // After timeout kills the group, the child emits close
        setTimeout(() => {
          child.emit('close', null)
        }, 100)

        return child
      })

      await executor.execute('/tmp/work', 'Do something')

      // Should have called process.kill with negative PID (process group kill)
      expect(processKillSpy).toHaveBeenCalledWith(-54321, 'SIGKILL')

      processKillSpy.mockRestore()
    })
  })

  describe('spawn error handling', () => {
    it('rejects gracefully when spawn emits an error event', async () => {
      const { logger } = createMockLogger()
      const executor = createClaudeExecutor(defaultConfig, logger)

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
        createMockChildProcess({ emitError: new Error('ENOENT: command not found') }),
      )

      const result = await executor.execute('/tmp/work', 'Do something')

      expect(result.success).toBe(false)
      expect(result.stderr).toContain('ENOENT')
      expect(result.exitCode).toBeNull()
    })
  })

  describe('session handle piping', () => {
    const createMockSessionHandle = (): SessionHandle => ({
      writePrompt: vi.fn(),
      writeSetupScript: vi.fn(),
      writeStdout: vi.fn(),
      writeStderr: vi.fn(),
      finalize: vi.fn(() => Promise.resolve()),
      filePath: '/tmp/test-session.log',
    })

    it('calls writeStdout on the session handle with stdout chunks', async () => {
      const { logger } = createMockLogger()
      const executor = createClaudeExecutor(defaultConfig, logger)
      const handle = createMockSessionHandle()

      setupSuccessfulExecution({ stdout: 'hello from claude' })

      await executor.execute('/tmp/work', 'Do something', { sessionHandle: handle })

      expect(handle.writeStdout).toHaveBeenCalledWith('hello from claude')
    })

    it('calls writeStderr on the session handle with stderr chunks', async () => {
      const { logger } = createMockLogger()
      const executor = createClaudeExecutor(defaultConfig, logger)
      const handle = createMockSessionHandle()

      setupSuccessfulExecution({ stderr: 'warning from claude' })

      await executor.execute('/tmp/work', 'Do something', { sessionHandle: handle })

      expect(handle.writeStderr).toHaveBeenCalledWith('warning from claude')
    })

    it('works normally without a session handle (undefined)', async () => {
      const { logger } = createMockLogger()
      const executor = createClaudeExecutor(defaultConfig, logger)

      setupSuccessfulExecution({ stdout: 'output', preExecSha: 'a', postExecSha: 'b' })

      const result = await executor.execute('/tmp/work', 'Do something')

      expect(result.success).toBe(true)
      expect(result.stdout).toBe('output')
    })
  })

  describe('child logger context', () => {
    it('creates a child logger with step: "claude-execute" and workingDir', async () => {
      const { logger } = createMockLogger()
      const executor = createClaudeExecutor(defaultConfig, logger)

      setupSuccessfulExecution()

      await executor.execute('/tmp/my-work', 'Do something')

      expect(logger.child).toHaveBeenCalledWith({
        step: 'claude-execute',
        workingDir: '/tmp/my-work',
      })
    })
  })
})
