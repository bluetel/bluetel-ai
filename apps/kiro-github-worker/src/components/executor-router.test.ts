// Feature: rocky-copilot-cli-mode, Property 2: Executor_Router engine selection

/* eslint-disable @typescript-eslint/unbound-method */
import * as fc from 'fast-check'
import type pino from 'pino'
import { describe, expect, it, vi } from 'vitest'

import type { ExecutionResult } from '../lib/types'

import { createExecutorRouter, type Engine, type ExecutorInstance } from './executor-router'
import type {
  SessionHandle,
  SessionLogContext,
  SessionLogWriterInstance,
} from './session-log-writer'

// ── Mock logger ─────────────────────────────────────────────────────

const createMockLogger = () => {
  const makeLogFn = () => vi.fn()

  const logger = {
    info: makeLogFn(),
    warn: makeLogFn(),
    error: makeLogFn(),
    debug: makeLogFn(),
    child: vi.fn(() => logger),
  }

  return logger as unknown as pino.Logger
}

// ── Mock executors ──────────────────────────────────────────────────

/**
 * Creates a trio of mock executors (kiro, copilot, and claude) that track
 * which one was called and with what arguments.
 */
const createMockExecutors = () => {
  const kiroCalls: Array<{ workingDir: string; prompt: string }> = []
  const copilotCalls: Array<{ workingDir: string; prompt: string }> = []
  const claudeCalls: Array<{ workingDir: string; prompt: string }> = []

  const kiroResult: ExecutionResult = {
    success: true,
    hasChanges: true,
    stdout: 'kiro output',
    stderr: '',
    exitCode: 0,
  }

  const copilotResult: ExecutionResult = {
    success: true,
    hasChanges: true,
    stdout: 'copilot output',
    stderr: '',
    exitCode: 0,
  }

  const claudeResult: ExecutionResult = {
    success: true,
    hasChanges: true,
    stdout: 'claude output',
    stderr: '',
    exitCode: 0,
  }

  const kiroExecutor: ExecutorInstance = {
    execute: vi.fn((workingDir: string, prompt: string) => {
      kiroCalls.push({ workingDir, prompt })
      return Promise.resolve(kiroResult)
    }),
  }

  const copilotExecutor: ExecutorInstance = {
    execute: vi.fn((workingDir: string, prompt: string) => {
      copilotCalls.push({ workingDir, prompt })
      return Promise.resolve(copilotResult)
    }),
  }

  const claudeExecutor: ExecutorInstance = {
    execute: vi.fn((workingDir: string, prompt: string) => {
      claudeCalls.push({ workingDir, prompt })
      return Promise.resolve(claudeResult)
    }),
  }

  return {
    kiroExecutor,
    copilotExecutor,
    claudeExecutor,
    kiroCalls,
    copilotCalls,
    claudeCalls,
    kiroResult,
    copilotResult,
    claudeResult,
  }
}

// ── No-op session log writer ────────────────────────────────────────

const createNoOpSessionLogWriter = (): SessionLogWriterInstance => ({
  createSession: vi.fn(() => ({
    writePrompt: vi.fn(),
    writeSetupScript: vi.fn(),
    writeStdout: vi.fn(),
    writeStderr: vi.fn(),
    finalize: vi.fn(() => Promise.resolve()),
    filePath: '',
  })),
  writeSessionLog: vi.fn(() => Promise.resolve()),
  ensureDirectory: vi.fn(() => Promise.resolve()),
})

// ── Arbitraries ─────────────────────────────────────────────────────

/** Arbitrary for Engine values. */
const engineArb: fc.Arbitrary<Engine> = fc.constantFrom('kiro' as const, 'copilot' as const)

/** Arbitrary for working directory paths. */
const workingDirArb = fc
  .string({
    unit: fc.constantFrom('a', 'b', 'c', '/', '-', '_', '1', '2', '3'),
    minLength: 1,
    maxLength: 60,
  })
  .map((s) => `/tmp/${s}`)

/** Arbitrary for prompt strings. */
const promptArb = fc.string({ minLength: 1, maxLength: 200 })

/** Arbitrary for optional per-task engine override (Engine | undefined). */
const optionalEngineArb: fc.Arbitrary<Engine | undefined> = fc.option(engineArb, { nil: undefined })

// ── Property 2: Executor_Router engine selection ────────────────────
// **Validates: Requirements 3.2, 3.3, 4.1**

describe('Feature: rocky-copilot-cli-mode, Property 2: Executor_Router engine selection', () => {
  it('should delegate to the correct executor based on resolved engine (per-task override or default)', async () => {
    await fc.assert(
      fc.asyncProperty(
        engineArb,
        optionalEngineArb,
        workingDirArb,
        promptArb,
        async (defaultEngine, engineOverride, workingDir, prompt) => {
          const { kiroExecutor, copilotExecutor, claudeExecutor, kiroCalls, copilotCalls } =
            createMockExecutors()
          const logger = createMockLogger()

          const router = createExecutorRouter(
            { defaultEngine },
            {
              kiroExecutor,
              copilotExecutor,
              claudeExecutor,
              sessionLogWriter: createNoOpSessionLogWriter(),
              logger,
            },
          )

          const options = engineOverride != null ? { engine: engineOverride } : undefined
          await router.execute(workingDir, prompt, options)

          // The resolved engine is the per-task override when provided,
          // or the default engine when no override is specified.
          const resolvedEngine = engineOverride ?? defaultEngine

          if (resolvedEngine === 'kiro') {
            // Kiro executor should have been called exactly once
            expect(kiroCalls).toHaveLength(1)
            expect(kiroCalls[0].workingDir).toBe(workingDir)
            expect(kiroCalls[0].prompt).toBe(prompt)
            // Copilot executor should NOT have been called
            expect(copilotCalls).toHaveLength(0)
          } else {
            // Copilot executor should have been called exactly once
            expect(copilotCalls).toHaveLength(1)
            expect(copilotCalls[0].workingDir).toBe(workingDir)
            expect(copilotCalls[0].prompt).toBe(prompt)
            // Kiro executor should NOT have been called
            expect(kiroCalls).toHaveLength(0)
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('should use the default engine when no per-task override is specified (Req 3.2, 4.1)', async () => {
    await fc.assert(
      fc.asyncProperty(
        engineArb,
        workingDirArb,
        promptArb,
        async (defaultEngine, workingDir, prompt) => {
          const { kiroExecutor, copilotExecutor, claudeExecutor, kiroCalls, copilotCalls } =
            createMockExecutors()
          const logger = createMockLogger()

          const router = createExecutorRouter(
            { defaultEngine },
            {
              kiroExecutor,
              copilotExecutor,
              claudeExecutor,
              sessionLogWriter: createNoOpSessionLogWriter(),
              logger,
            },
          )

          // No options → uses default engine
          await router.execute(workingDir, prompt)

          if (defaultEngine === 'kiro') {
            expect(kiroCalls).toHaveLength(1)
            expect(copilotCalls).toHaveLength(0)
          } else {
            expect(copilotCalls).toHaveLength(1)
            expect(kiroCalls).toHaveLength(0)
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('should use the per-task override when specified, regardless of default engine (Req 3.3)', async () => {
    await fc.assert(
      fc.asyncProperty(
        engineArb,
        engineArb,
        workingDirArb,
        promptArb,
        async (defaultEngine, overrideEngine, workingDir, prompt) => {
          const { kiroExecutor, copilotExecutor, claudeExecutor, kiroCalls, copilotCalls } =
            createMockExecutors()
          const logger = createMockLogger()

          const router = createExecutorRouter(
            { defaultEngine },
            {
              kiroExecutor,
              copilotExecutor,
              claudeExecutor,
              sessionLogWriter: createNoOpSessionLogWriter(),
              logger,
            },
          )

          await router.execute(workingDir, prompt, { engine: overrideEngine })

          // Override takes precedence over default
          if (overrideEngine === 'kiro') {
            expect(kiroCalls).toHaveLength(1)
            expect(copilotCalls).toHaveLength(0)
          } else {
            expect(copilotCalls).toHaveLength(1)
            expect(kiroCalls).toHaveLength(0)
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ── Property 4: Prompt passthrough through Executor_Router ──────────
// **Validates: Requirements 5.6, 6.5, 8.1, 8.2**

describe('Feature: rocky-copilot-cli-mode, Property 4: Prompt passthrough', () => {
  /**
   * Arbitrary for non-empty prompt strings including special characters,
   * unicode, whitespace, and control characters.
   */
  const richPromptArb = fc.oneof(
    // General unicode strings (includes emoji, CJK, diacritics, etc.)
    fc.string({ unit: 'grapheme', minLength: 1, maxLength: 500 }),
    // ASCII strings with special characters
    fc.string({
      unit: fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyz0123456789 \t\n\r!@#$%^&*()_+-=[]{}|;:\'",.<>?/`~\\'.split(
          '',
        ),
      ),
      minLength: 1,
      maxLength: 300,
    }),
    // Strings with leading/trailing whitespace
    fc
      .tuple(fc.constantFrom('  ', '\t', '\n', ' \n '), fc.string({ minLength: 1 }))
      .map(([ws, s]) => `${ws}${s}${ws}`),
  )

  it('should pass the prompt to the selected executor without any modification', async () => {
    await fc.assert(
      fc.asyncProperty(
        engineArb,
        optionalEngineArb,
        workingDirArb,
        richPromptArb,
        async (defaultEngine, engineOverride, workingDir, prompt) => {
          const { kiroExecutor, copilotExecutor, claudeExecutor, kiroCalls, copilotCalls } =
            createMockExecutors()
          const logger = createMockLogger()

          const router = createExecutorRouter(
            { defaultEngine },
            {
              kiroExecutor,
              copilotExecutor,
              claudeExecutor,
              sessionLogWriter: createNoOpSessionLogWriter(),
              logger,
            },
          )

          const options = engineOverride != null ? { engine: engineOverride } : undefined
          await router.execute(workingDir, prompt, options)

          const resolvedEngine = engineOverride ?? defaultEngine
          const calls = resolvedEngine === 'kiro' ? kiroCalls : copilotCalls

          // The executor must have been called exactly once
          expect(calls).toHaveLength(1)

          // The prompt received by the executor must be byte-identical
          // to the prompt passed to the router — no append, prepend, or
          // modification of any kind.
          expect(calls[0].prompt).toBe(prompt)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('should preserve prompts with special characters and unicode through kiro executor', async () => {
    await fc.assert(
      fc.asyncProperty(workingDirArb, richPromptArb, async (workingDir, prompt) => {
        const { kiroExecutor, copilotExecutor, claudeExecutor, kiroCalls } = createMockExecutors()
        const logger = createMockLogger()

        const router = createExecutorRouter(
          { defaultEngine: 'kiro' },
          {
            kiroExecutor,
            copilotExecutor,
            claudeExecutor,
            sessionLogWriter: createNoOpSessionLogWriter(),
            logger,
          },
        )

        await router.execute(workingDir, prompt)

        expect(kiroCalls).toHaveLength(1)
        expect(kiroCalls[0].prompt).toBe(prompt)
      }),
      { numRuns: 100 },
    )
  })

  it('should preserve prompts with special characters and unicode through copilot executor', async () => {
    await fc.assert(
      fc.asyncProperty(workingDirArb, richPromptArb, async (workingDir, prompt) => {
        const { kiroExecutor, copilotExecutor, claudeExecutor, copilotCalls } =
          createMockExecutors()
        const logger = createMockLogger()

        const router = createExecutorRouter(
          { defaultEngine: 'copilot' },
          {
            kiroExecutor,
            copilotExecutor,
            claudeExecutor,
            sessionLogWriter: createNoOpSessionLogWriter(),
            logger,
          },
        )

        await router.execute(workingDir, prompt)

        expect(copilotCalls).toHaveLength(1)
        expect(copilotCalls[0].prompt).toBe(prompt)
      }),
      { numRuns: 100 },
    )
  })
})

// ── Unit tests for Executor_Router ──────────────────────────────────
// **Validates: Requirements 3.4, 3.6, 9.1**

describe('Executor_Router unit tests', () => {
  describe('copilot not configured (Req 3.4)', () => {
    it('should return error result when copilot engine is requested via override but copilotExecutor is null', async () => {
      const { kiroExecutor, kiroCalls } = createMockExecutors()
      const logger = createMockLogger()

      const router = createExecutorRouter(
        { defaultEngine: 'kiro' },
        {
          kiroExecutor,
          copilotExecutor: null,
          claudeExecutor: null,
          sessionLogWriter: createNoOpSessionLogWriter(),
          logger,
        },
      )

      const result = await router.execute('/tmp/repo', 'fix the bug', { engine: 'copilot' })

      expect(result).toEqual({
        success: false,
        hasChanges: false,
        stdout: '',
        stderr: 'Copilot engine is not available — COPILOT_CLI_PATH is not configured',
        exitCode: null,
      })
      // Kiro executor should NOT have been called
      expect(kiroCalls).toHaveLength(0)
    })

    it('should return error result when copilot is the default engine but copilotExecutor is null', async () => {
      const { kiroExecutor, kiroCalls } = createMockExecutors()
      const logger = createMockLogger()

      const router = createExecutorRouter(
        { defaultEngine: 'copilot' },
        {
          kiroExecutor,
          copilotExecutor: null,
          claudeExecutor: null,
          sessionLogWriter: createNoOpSessionLogWriter(),
          logger,
        },
      )

      const result = await router.execute('/tmp/repo', 'add tests')

      expect(result).toEqual({
        success: false,
        hasChanges: false,
        stdout: '',
        stderr: 'Copilot engine is not available — COPILOT_CLI_PATH is not configured',
        exitCode: null,
      })
      // Kiro executor should NOT have been called
      expect(kiroCalls).toHaveLength(0)
    })
  })

  describe('logs selected engine (Req 3.6, 9.1)', () => {
    it('should log the selected engine at info level when using kiro', async () => {
      const { kiroExecutor, copilotExecutor, claudeExecutor } = createMockExecutors()
      const logger = createMockLogger()

      const router = createExecutorRouter(
        { defaultEngine: 'kiro' },
        {
          kiroExecutor,
          copilotExecutor,
          claudeExecutor,
          sessionLogWriter: createNoOpSessionLogWriter(),
          logger,
        },
      )

      await router.execute('/tmp/repo', 'implement feature')

      expect(logger.info).toHaveBeenCalledWith({ engine: 'kiro' }, 'Selected engine: %s', 'kiro')
    })

    it('should log the selected engine at info level when using copilot', async () => {
      const { kiroExecutor, copilotExecutor, claudeExecutor } = createMockExecutors()
      const logger = createMockLogger()

      const router = createExecutorRouter(
        { defaultEngine: 'copilot' },
        {
          kiroExecutor,
          copilotExecutor,
          claudeExecutor,
          sessionLogWriter: createNoOpSessionLogWriter(),
          logger,
        },
      )

      await router.execute('/tmp/repo', 'implement feature')

      expect(logger.info).toHaveBeenCalledWith(
        { engine: 'copilot' },
        'Selected engine: %s',
        'copilot',
      )
    })

    it('should log the overridden engine when a per-task override is provided', async () => {
      const { kiroExecutor, copilotExecutor, claudeExecutor } = createMockExecutors()
      const logger = createMockLogger()

      const router = createExecutorRouter(
        { defaultEngine: 'kiro' },
        {
          kiroExecutor,
          copilotExecutor,
          claudeExecutor,
          sessionLogWriter: createNoOpSessionLogWriter(),
          logger,
        },
      )

      await router.execute('/tmp/repo', 'refactor code', { engine: 'copilot' })

      expect(logger.info).toHaveBeenCalledWith(
        { engine: 'copilot' },
        'Selected engine: %s',
        'copilot',
      )
    })

    it('should not log engine when copilot is requested but not configured', async () => {
      const { kiroExecutor } = createMockExecutors()
      const logger = createMockLogger()

      const router = createExecutorRouter(
        { defaultEngine: 'kiro' },
        {
          kiroExecutor,
          copilotExecutor: null,
          claudeExecutor: null,
          sessionLogWriter: createNoOpSessionLogWriter(),
          logger,
        },
      )

      await router.execute('/tmp/repo', 'fix bug', { engine: 'copilot' })

      // The router returns early with an error before logging
      expect(logger.info).not.toHaveBeenCalled()
    })
  })
})

// ── Mock session log writer ─────────────────────────────────────────

const createMockSessionLogWriter = () => {
  const createSessionCalls: Array<{ context: SessionLogContext }> = []
  const finalizeCalls: Array<{ result: ExecutionResult }> = []

  const mockHandle: SessionHandle = {
    writePrompt: vi.fn(),
    writeSetupScript: vi.fn(),
    writeStdout: vi.fn(),
    writeStderr: vi.fn(),
    finalize: vi.fn((result: ExecutionResult) => {
      finalizeCalls.push({ result })
      return Promise.resolve()
    }),
    filePath: '/tmp/session.log',
  }

  const writer: SessionLogWriterInstance = {
    createSession: vi.fn((context: SessionLogContext) => {
      createSessionCalls.push({ context })
      return mockHandle
    }),
    writeSessionLog: vi.fn(() => Promise.resolve()),
    ensureDirectory: vi.fn(() => Promise.resolve()),
  }

  return { writer, mockHandle, createSessionCalls, finalizeCalls }
}

// ── Arbitraries for Property 6 ──────────────────────────────────────

/** Arbitrary for ExecutionResult values. */
const executionResultArb: fc.Arbitrary<ExecutionResult> = fc.record({
  success: fc.boolean(),
  hasChanges: fc.boolean(),
  stdout: fc.string({ maxLength: 500 }),
  stderr: fc.string({ maxLength: 500 }),
  exitCode: fc.option(fc.integer({ min: -128, max: 255 }), { nil: null }),
})

/** Arbitrary for SessionLogContext values. */
const sessionLogContextArb: fc.Arbitrary<SessionLogContext> = fc.record({
  engine: fc.constantFrom('kiro' as const, 'copilot' as const),
  repoFullName: fc.string({ minLength: 1, maxLength: 100 }),
  executionContext: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
})

// ── Property 6: ExecutionResult passthrough ─────────────────────────
// **Validates: Requirements 5.3, 5.4**

describe('Feature: worker-observability, Property 6: ExecutionResult passthrough', () => {
  it('should return the exact ExecutionResult from the executor regardless of session log write outcome', async () => {
    await fc.assert(
      fc.asyncProperty(
        engineArb,
        executionResultArb,
        sessionLogContextArb,
        fc.boolean(), // whether session handle finalize should throw
        async (defaultEngine, expectedResult, context, finalizeShouldThrow) => {
          const logger = createMockLogger()

          // Create an executor that returns the expected result
          const executor: ExecutorInstance = {
            execute: vi.fn(() => Promise.resolve(expectedResult)),
          }

          // Create a session log writer whose handle either succeeds or throws on finalize
          const writer: SessionLogWriterInstance = {
            createSession: vi.fn(() => ({
              writePrompt: vi.fn(),
              writeSetupScript: vi.fn(),
              writeStdout: vi.fn(),
              writeStderr: vi.fn(),
              finalize: finalizeShouldThrow
                ? vi.fn(() => Promise.reject(new Error('Simulated finalize failure')))
                : vi.fn(() => Promise.resolve()),
              filePath: '/tmp/session.log',
            })),
            writeSessionLog: vi.fn(() => Promise.resolve()),
            ensureDirectory: vi.fn(() => Promise.resolve()),
          }

          const router = createExecutorRouter(
            { defaultEngine },
            {
              kiroExecutor:
                defaultEngine === 'kiro' ? executor : createMockExecutors().kiroExecutor,
              copilotExecutor:
                defaultEngine === 'copilot' ? executor : createMockExecutors().copilotExecutor,
              claudeExecutor: createMockExecutors().claudeExecutor,
              sessionLogWriter: writer,
              logger,
            },
          )

          const result = await router.execute('/tmp/repo', 'test prompt', { context })

          // The returned result must be deep-equal to the executor's result
          expect(result).toEqual(expectedResult)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('should return the exact ExecutionResult when no context is provided', async () => {
    await fc.assert(
      fc.asyncProperty(engineArb, executionResultArb, async (defaultEngine, expectedResult) => {
        const logger = createMockLogger()

        const executor: ExecutorInstance = {
          execute: vi.fn(() => Promise.resolve(expectedResult)),
        }

        const router = createExecutorRouter(
          { defaultEngine },
          {
            kiroExecutor: defaultEngine === 'kiro' ? executor : createMockExecutors().kiroExecutor,
            copilotExecutor:
              defaultEngine === 'copilot' ? executor : createMockExecutors().copilotExecutor,
            claudeExecutor: createMockExecutors().claudeExecutor,
            sessionLogWriter: createNoOpSessionLogWriter(),
            logger,
          },
        )

        const result = await router.execute('/tmp/repo', 'test prompt')

        expect(result).toEqual(expectedResult)
      }),
      { numRuns: 100 },
    )
  })
})

// ── Unit tests for session log writer integration ───────────────────
// **Validates: Requirements 5.1, 5.3, 5.4**

describe('Executor_Router session log writer integration', () => {
  describe('router creates session handle and passes to executor (Req 5.1)', () => {
    it('should call createSession with context and pass handle to executor when writer and context are provided', async () => {
      const { kiroExecutor, kiroResult } = createMockExecutors()
      const logger = createMockLogger()
      const { writer, createSessionCalls, finalizeCalls } = createMockSessionLogWriter()

      const router = createExecutorRouter(
        { defaultEngine: 'kiro' },
        {
          kiroExecutor,
          copilotExecutor: null,
          claudeExecutor: null,
          sessionLogWriter: writer,
          logger,
        },
      )

      const context: SessionLogContext = {
        engine: 'kiro',
        repoFullName: 'owner/repo',
        executionContext: 'issue-42',
      }

      await router.execute('/tmp/repo', 'implement feature', { context })

      // createSession should have been called with the context (engine overridden by router)
      expect(createSessionCalls).toHaveLength(1)
      expect(createSessionCalls[0].context).toEqual({
        engine: 'kiro',
        repoFullName: 'owner/repo',
        executionContext: 'issue-42',
      })

      // The executor should have been called with the session handle
      expect(kiroExecutor.execute).toHaveBeenCalledWith('/tmp/repo', 'implement feature', {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        sessionHandle: expect.objectContaining({ filePath: '/tmp/session.log' }),
      })

      // finalize should have been called with the result
      expect(finalizeCalls).toHaveLength(1)
      expect(finalizeCalls[0].result).toEqual(kiroResult)
    })

    it('should override the engine field in context with the resolved engine', async () => {
      const { kiroExecutor, copilotExecutor, claudeExecutor } = createMockExecutors()
      const logger = createMockLogger()
      const { writer, createSessionCalls } = createMockSessionLogWriter()

      const router = createExecutorRouter(
        { defaultEngine: 'kiro' },
        { kiroExecutor, copilotExecutor, claudeExecutor, sessionLogWriter: writer, logger },
      )

      // Caller passes engine: 'kiro' in context, but override selects copilot
      const context: SessionLogContext = {
        engine: 'kiro',
        repoFullName: 'owner/repo',
        executionContext: 'issue-42',
      }

      await router.execute('/tmp/repo', 'implement feature', {
        engine: 'copilot',
        context,
      })

      expect(createSessionCalls).toHaveLength(1)
      // The router should override engine to 'copilot' (the resolved engine)
      expect(createSessionCalls[0].context.engine).toBe('copilot')
    })

    it('should not call createSession when context is not provided', async () => {
      const { kiroExecutor } = createMockExecutors()
      const logger = createMockLogger()
      const { writer, createSessionCalls } = createMockSessionLogWriter()

      const router = createExecutorRouter(
        { defaultEngine: 'kiro' },
        {
          kiroExecutor,
          copilotExecutor: null,
          claudeExecutor: null,
          sessionLogWriter: writer,
          logger,
        },
      )

      await router.execute('/tmp/repo', 'implement feature')

      expect(createSessionCalls).toHaveLength(0)
    })

    it('should call handle.finalize(result) after execution completes', async () => {
      const { kiroExecutor, kiroResult } = createMockExecutors()
      const logger = createMockLogger()
      const { writer, finalizeCalls } = createMockSessionLogWriter()

      const router = createExecutorRouter(
        { defaultEngine: 'kiro' },
        {
          kiroExecutor,
          copilotExecutor: null,
          claudeExecutor: null,
          sessionLogWriter: writer,
          logger,
        },
      )

      const context: SessionLogContext = {
        engine: 'kiro',
        repoFullName: 'owner/repo',
        executionContext: 'issue-42',
      }

      await router.execute('/tmp/repo', 'implement feature', { context })

      expect(finalizeCalls).toHaveLength(1)
      expect(finalizeCalls[0].result).toEqual(kiroResult)
    })

    it('should return the result unchanged even if finalize throws', async () => {
      const { kiroExecutor, kiroResult } = createMockExecutors()
      const logger = createMockLogger()

      const failingHandle: SessionHandle = {
        writePrompt: vi.fn(),
        writeSetupScript: vi.fn(),
        writeStdout: vi.fn(),
        writeStderr: vi.fn(),
        finalize: vi.fn(() => Promise.reject(new Error('Disk full'))),
        filePath: '/tmp/session.log',
      }

      const failingWriter: SessionLogWriterInstance = {
        createSession: vi.fn(() => failingHandle),
        writeSessionLog: vi.fn(() => Promise.resolve()),
        ensureDirectory: vi.fn(() => Promise.resolve()),
      }

      const router = createExecutorRouter(
        { defaultEngine: 'kiro' },
        {
          kiroExecutor,
          copilotExecutor: null,
          claudeExecutor: null,
          sessionLogWriter: failingWriter,
          logger,
        },
      )

      const context: SessionLogContext = {
        engine: 'kiro',
        repoFullName: 'owner/repo',
        executionContext: 'issue-42',
      }

      const result = await router.execute('/tmp/repo', 'implement feature', { context })

      // Result should be returned unchanged despite the finalize failure
      expect(result).toEqual(kiroResult)
      // Warning should have been logged
      expect(logger.warn).toHaveBeenCalledWith(
        { error: 'Disk full' },
        'Session log finalize failed: %s',
        'Disk full',
      )
    })

    it('should return the result unchanged even if createSession throws', async () => {
      const { kiroExecutor, kiroResult } = createMockExecutors()
      const logger = createMockLogger()

      const throwingWriter: SessionLogWriterInstance = {
        createSession: vi.fn(() => {
          throw new Error('Cannot open file')
        }),
        writeSessionLog: vi.fn(() => Promise.resolve()),
        ensureDirectory: vi.fn(() => Promise.resolve()),
      }

      const router = createExecutorRouter(
        { defaultEngine: 'kiro' },
        {
          kiroExecutor,
          copilotExecutor: null,
          claudeExecutor: null,
          sessionLogWriter: throwingWriter,
          logger,
        },
      )

      const context: SessionLogContext = {
        engine: 'kiro',
        repoFullName: 'owner/repo',
        executionContext: 'issue-42',
      }

      const result = await router.execute('/tmp/repo', 'implement feature', { context })

      // Result should be returned unchanged despite the createSession failure
      expect(result).toEqual(kiroResult)
      // Warning should have been logged
      expect(logger.warn).toHaveBeenCalledWith(
        { error: 'Cannot open file' },
        'Failed to create session handle: %s',
        'Cannot open file',
      )
    })
  })

  describe('router works with no-op writer when no context is provided', () => {
    it('should not call createSession when no context is passed', async () => {
      const { kiroExecutor, kiroResult } = createMockExecutors()
      const logger = createMockLogger()
      const noOpWriter = createNoOpSessionLogWriter()

      const router = createExecutorRouter(
        { defaultEngine: 'kiro' },
        {
          kiroExecutor,
          copilotExecutor: null,
          claudeExecutor: null,
          sessionLogWriter: noOpWriter,
          logger,
        },
      )

      const result = await router.execute('/tmp/repo', 'implement feature')

      expect(result).toEqual(kiroResult)
      expect(noOpWriter.createSession).not.toHaveBeenCalled()
    })
  })

  describe('router calls writePrompt with the prompt string (Req 9.1)', () => {
    it('should call writePrompt with the prompt string after creating session handle and before calling executor', async () => {
      const { kiroExecutor } = createMockExecutors()
      const logger = createMockLogger()
      const { writer, mockHandle } = createMockSessionLogWriter()

      const router = createExecutorRouter(
        { defaultEngine: 'kiro' },
        {
          kiroExecutor,
          copilotExecutor: null,
          claudeExecutor: null,
          sessionLogWriter: writer,
          logger,
        },
      )

      const context: SessionLogContext = {
        engine: 'kiro',
        repoFullName: 'owner/repo',
        executionContext: 'issue-42',
      }

      const prompt = 'Implement the login feature with OAuth2 support'
      await router.execute('/tmp/repo', prompt, { context })

      // writePrompt should have been called with the exact prompt
      expect(mockHandle.writePrompt).toHaveBeenCalledWith(prompt)
      expect(mockHandle.writePrompt).toHaveBeenCalledTimes(1)

      // Verify ordering: writePrompt called before executor
      const writePromptOrder = (mockHandle.writePrompt as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0]
      const executorOrder = (kiroExecutor.execute as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0]
      expect(writePromptOrder).toBeLessThan(executorOrder)
    })

    it('should not call writePrompt when no context is provided', async () => {
      const { kiroExecutor } = createMockExecutors()
      const logger = createMockLogger()
      const { writer, mockHandle } = createMockSessionLogWriter()

      const router = createExecutorRouter(
        { defaultEngine: 'kiro' },
        {
          kiroExecutor,
          copilotExecutor: null,
          claudeExecutor: null,
          sessionLogWriter: writer,
          logger,
        },
      )

      await router.execute('/tmp/repo', 'implement feature')

      // No session handle created, so writePrompt should not be called
      expect(mockHandle.writePrompt).not.toHaveBeenCalled()
    })
  })
})

// ── Agent selection tests ───────────────────────────────────────────
// **Validates: Requirements R4.1, R4.2, R4.6**

describe('Executor_Router agent selection', () => {
  it('should forward agent option to kiro executor', async () => {
    const { kiroExecutor, copilotExecutor, claudeExecutor } = createMockExecutors()
    const logger = createMockLogger()

    const router = createExecutorRouter(
      { defaultEngine: 'kiro' },
      {
        kiroExecutor,
        copilotExecutor,
        claudeExecutor,
        sessionLogWriter: createNoOpSessionLogWriter(),
        logger,
      },
    )

    await router.execute('/tmp/repo', 'test prompt', { agent: 'spec-orchestrator' })

    expect(kiroExecutor.execute).toHaveBeenCalledWith(
      '/tmp/repo',
      'test prompt',
      expect.objectContaining({ agent: 'spec-orchestrator' }),
    )
  })

  it('should not include agent in executor options when agent is undefined', async () => {
    const { kiroExecutor, copilotExecutor, claudeExecutor } = createMockExecutors()
    const logger = createMockLogger()

    const router = createExecutorRouter(
      { defaultEngine: 'kiro' },
      {
        kiroExecutor,
        copilotExecutor,
        claudeExecutor,
        sessionLogWriter: createNoOpSessionLogWriter(),
        logger,
      },
    )

    await router.execute('/tmp/repo', 'test prompt')

    expect(kiroExecutor.execute).toHaveBeenCalledWith(
      '/tmp/repo',
      'test prompt',
      expect.objectContaining({ agent: undefined }),
    )
  })

  it('should ignore agent when engine is copilot and log debug message', async () => {
    const { kiroExecutor, copilotExecutor, claudeExecutor } = createMockExecutors()
    const logger = createMockLogger()

    const router = createExecutorRouter(
      { defaultEngine: 'copilot' },
      {
        kiroExecutor,
        copilotExecutor,
        claudeExecutor,
        sessionLogWriter: createNoOpSessionLogWriter(),
        logger,
      },
    )

    await router.execute('/tmp/repo', 'test prompt', { agent: 'spec-orchestrator' })

    expect(copilotExecutor.execute).toHaveBeenCalledWith(
      '/tmp/repo',
      'test prompt',
      expect.objectContaining({ agent: undefined }),
    )
    expect(logger.debug).toHaveBeenCalledWith(
      { engine: 'copilot' },
      'Agent selection ignored: only supported for kiro engine',
    )
  })
})

// ── Claude engine routing tests ─────────────────────────────────────

describe('Executor_Router claude engine', () => {
  it('should delegate to the claude executor when claude is the default engine', async () => {
    const { kiroExecutor, copilotExecutor, claudeExecutor, claudeCalls, kiroCalls } =
      createMockExecutors()
    const logger = createMockLogger()

    const router = createExecutorRouter(
      { defaultEngine: 'claude' },
      {
        kiroExecutor,
        copilotExecutor,
        claudeExecutor,
        sessionLogWriter: createNoOpSessionLogWriter(),
        logger,
      },
    )

    await router.execute('/tmp/repo', 'implement feature')

    expect(claudeCalls).toHaveLength(1)
    expect(kiroCalls).toHaveLength(0)
    expect(logger.info).toHaveBeenCalledWith({ engine: 'claude' }, 'Selected engine: %s', 'claude')
  })

  it('should delegate to the claude executor when claude is requested via override', async () => {
    const { kiroExecutor, copilotExecutor, claudeExecutor, claudeCalls } = createMockExecutors()
    const logger = createMockLogger()

    const router = createExecutorRouter(
      { defaultEngine: 'kiro' },
      {
        kiroExecutor,
        copilotExecutor,
        claudeExecutor,
        sessionLogWriter: createNoOpSessionLogWriter(),
        logger,
      },
    )

    await router.execute('/tmp/repo', 'fix bug', { engine: 'claude' })

    expect(claudeCalls).toHaveLength(1)
  })

  it('should return an error result when claude is requested but claudeExecutor is null', async () => {
    const { kiroExecutor, copilotExecutor, kiroCalls } = createMockExecutors()
    const logger = createMockLogger()

    const router = createExecutorRouter(
      { defaultEngine: 'kiro' },
      {
        kiroExecutor,
        copilotExecutor,
        claudeExecutor: null,
        sessionLogWriter: createNoOpSessionLogWriter(),
        logger,
      },
    )

    const result = await router.execute('/tmp/repo', 'fix the bug', { engine: 'claude' })

    expect(result).toEqual({
      success: false,
      hasChanges: false,
      stdout: '',
      stderr: 'Claude engine is not available — CLAUDE_CLI_PATH is not configured',
      exitCode: null,
    })
    expect(kiroCalls).toHaveLength(0)
  })

  it('should ignore agent selection when engine is claude', async () => {
    const { kiroExecutor, copilotExecutor, claudeExecutor } = createMockExecutors()
    const logger = createMockLogger()

    const router = createExecutorRouter(
      { defaultEngine: 'claude' },
      {
        kiroExecutor,
        copilotExecutor,
        claudeExecutor,
        sessionLogWriter: createNoOpSessionLogWriter(),
        logger,
      },
    )

    await router.execute('/tmp/repo', 'test prompt', { agent: 'spec-orchestrator' })

    expect(claudeExecutor.execute).toHaveBeenCalledWith(
      '/tmp/repo',
      'test prompt',
      expect.objectContaining({ agent: undefined }),
    )
    expect(logger.debug).toHaveBeenCalledWith(
      { engine: 'claude' },
      'Agent selection ignored: only supported for kiro engine',
    )
  })
})
