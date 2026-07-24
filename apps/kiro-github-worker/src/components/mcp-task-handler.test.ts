// Feature: rocky-mcp-mode — Property tests for MCP_Task_Handler

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as fc from 'fast-check'
import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  AuthResult,
  ExecutionResult,
  MCPTask,
  MCPTaskInput,
  MCPTaskStore,
  RepoClonerMCP,
  WorkerConfig,
} from '../lib/mcp-types'
import { buildA2APrompt } from '../lib/prompt-builder'

import {
  createMCPTaskHandler,
  extractRepoFullName,
  isValidationError,
  parseTaskInput,
} from './mcp-task-handler'
import { createMCPTaskStore } from './mcp-task-store'
import type { SessionLogWriterInstance } from './session-log-writer'
import type { SummarizerInstance } from './summarizer'

// ── Helpers ─────────────────────────────────────────────────────────

const silentLogger = pino({ level: 'silent' })

/** No-op session log writer for tests. */
const mockSessionLogWriter: SessionLogWriterInstance = {
  createSession: () => ({
    writePrompt: () => {},
    writeSetupScript: () => {},
    writeStdout: () => {},
    writeStderr: () => {},
    finalize: async () => {},
    filePath: '',
  }),
  writeSessionLog: async () => {},
  ensureDirectory: async () => {},
}

/** No-op summarizer for tests. */
const mockSummarizer: SummarizerInstance = {
  generateSummary: () => Promise.resolve(null),
}

// ── Arbitraries ─────────────────────────────────────────────────────

/** Characters allowed in GitHub owner/repo names. */
const ghNameCharArb = fc.constantFrom(
  'a',
  'b',
  'c',
  'd',
  'e',
  'f',
  'g',
  'h',
  'i',
  'j',
  'k',
  'l',
  'm',
  'n',
  'o',
  'p',
  'q',
  'r',
  's',
  't',
  'A',
  'B',
  'C',
  'X',
  'Y',
  'Z',
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '-',
  '_',
  '.',
)

/** Arbitrary that generates realistic GitHub owner names. */
const ownerArb = fc.string({ unit: ghNameCharArb, minLength: 1, maxLength: 20 })

/** Arbitrary that generates realistic GitHub repo names. */
const repoNameArb = fc.string({ unit: ghNameCharArb, minLength: 1, maxLength: 20 })

/** Characters allowed in git branch ref names. */
const gitRefCharArb = fc.constantFrom(
  'a',
  'b',
  'c',
  'd',
  'e',
  'f',
  'g',
  'h',
  'i',
  'j',
  'k',
  'l',
  'm',
  'n',
  'o',
  'p',
  'q',
  'r',
  's',
  't',
  'A',
  'B',
  'C',
  'X',
  'Y',
  'Z',
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '-',
  '_',
  '/',
  '.',
)

/** Arbitrary that generates valid branch names. */
const branchArb = fc.string({ unit: gitRefCharArb, minLength: 1, maxLength: 30 })

/** Arbitrary that generates non-empty prompt strings. */
const promptArb = fc.string({ minLength: 1, maxLength: 200 })

/** Arbitrary that generates non-empty install script strings. */
const installScriptArb = fc.string({ minLength: 1, maxLength: 200 })

/** Arbitrary for optional .git suffix. */
const gitSuffixArb = fc.constantFrom('', '.git')

/** Arbitrary that generates valid MCP tool arguments (without installScript). */
const validArgsArb = fc.record({
  repoUrl: fc
    .tuple(ownerArb, repoNameArb)
    .map(([owner, repo]) => `https://github.com/${owner}/${repo}`),
  baseBranch: branchArb,
  prompt: promptArb,
})

/** Arbitrary that generates valid MCP tool arguments (with installScript). */
const validArgsWithInstallArb = fc.record({
  repoUrl: fc
    .tuple(ownerArb, repoNameArb)
    .map(([owner, repo]) => `https://github.com/${owner}/${repo}`),
  baseBranch: branchArb,
  installScript: installScriptArb,
  prompt: promptArb,
})

// ── Property 1: Task input validation ──
// **Validates: Requirements 2.3, 2.4, 2.5, 2.7**

describe('Feature: rocky-mcp-mode, Property 1: Task input validation', () => {
  it('accepts valid inputs with all required fields', () => {
    fc.assert(
      fc.property(validArgsArb, (args) => {
        const result = parseTaskInput(args)
        expect(isValidationError(result)).toBe(false)
      }),
      { numRuns: 100 },
    )
  })

  it('accepts valid inputs that include an installScript', () => {
    fc.assert(
      fc.property(validArgsWithInstallArb, (args) => {
        const result = parseTaskInput(args)
        expect(isValidationError(result)).toBe(false)
      }),
      { numRuns: 100 },
    )
  })

  it('rejects inputs with invalid repoUrl and reports field-specific error', () => {
    const badUrlArb = fc.oneof(
      fc.constant(''),
      fc.constant('not-a-url'),
      fc.constant('http://github.com/owner/repo'), // http instead of https
      fc.constant('https://gitlab.com/owner/repo'), // wrong host
      fc.constant('https://github.com/'), // missing owner/repo
      fc.constant('https://github.com/owner'), // missing repo
    )

    fc.assert(
      fc.property(badUrlArb, branchArb, promptArb, (badUrl, branch, prompt) => {
        const result = parseTaskInput({ repoUrl: badUrl, baseBranch: branch, prompt })
        expect(isValidationError(result)).toBe(true)
        if (isValidationError(result)) {
          expect(result.field).toBe('repoUrl')
        }
      }),
      { numRuns: 100 },
    )
  })

  it('rejects inputs with invalid baseBranch and reports field-specific error', () => {
    const badBranchArb = fc.oneof(
      fc.constant(''),
      fc.constant('branch with spaces'),
      fc.constant('branch\ttab'),
      fc.constant('branch~tilde'),
      fc.constant('branch^caret'),
      fc.constant('branch:colon'),
    )

    fc.assert(
      fc.property(
        ownerArb,
        repoNameArb,
        badBranchArb,
        promptArb,
        (owner, repo, badBranch, prompt) => {
          const result = parseTaskInput({
            repoUrl: `https://github.com/${owner}/${repo}`,
            baseBranch: badBranch,
            prompt,
          })
          expect(isValidationError(result)).toBe(true)
          if (isValidationError(result)) {
            expect(result.field).toBe('baseBranch')
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('rejects inputs with empty prompt and reports field-specific error', () => {
    fc.assert(
      fc.property(ownerArb, repoNameArb, branchArb, (owner, repo, branch) => {
        const result = parseTaskInput({
          repoUrl: `https://github.com/${owner}/${repo}`,
          baseBranch: branch,
          prompt: '',
        })
        expect(isValidationError(result)).toBe(true)
        if (isValidationError(result)) {
          expect(result.field).toBe('prompt')
        }
      }),
      { numRuns: 100 },
    )
  })
})

// ── Property 2: Task input parsing round-trip ──
// **Validates: Requirements 2.1**

describe('Feature: rocky-mcp-mode, Property 2: Task input parsing round-trip', () => {
  it('parsing tool arguments preserves all fields (without installScript)', () => {
    fc.assert(
      fc.property(validArgsArb, (args) => {
        const result = parseTaskInput(args)
        expect(isValidationError(result)).toBe(false)
        if (!isValidationError(result)) {
          expect(result.repoUrl).toBe(args.repoUrl)
          expect(result.baseBranch).toBe(args.baseBranch)
          expect(result.prompt).toBe(args.prompt)
          expect(result.installScript).toBeUndefined()
        }
      }),
      { numRuns: 100 },
    )
  })

  it('parsing tool arguments preserves all fields (with installScript)', () => {
    fc.assert(
      fc.property(validArgsWithInstallArb, (args) => {
        const result = parseTaskInput(args)
        expect(isValidationError(result)).toBe(false)
        if (!isValidationError(result)) {
          expect(result.repoUrl).toBe(args.repoUrl)
          expect(result.baseBranch).toBe(args.baseBranch)
          expect(result.prompt).toBe(args.prompt)
          expect(result.installScript).toBe(args.installScript)
        }
      }),
      { numRuns: 100 },
    )
  })
})

// ── Property 3: Repo URL extraction ──
// **Validates: Requirements 2.8**

describe('Feature: rocky-mcp-mode, Property 3: Repo URL extraction', () => {
  it('extracting repoFullName from a constructed URL produces owner/repo', () => {
    fc.assert(
      fc.property(ownerArb, repoNameArb, gitSuffixArb, (owner, repo, suffix) => {
        const url = `https://github.com/${owner}/${repo}${suffix}`
        const fullName = extractRepoFullName(url)
        expect(fullName).toBe(`${owner}/${repo}`)
      }),
      { numRuns: 100 },
    )
  })
})

// ── Property 4: Prompt passthrough identity ──
// **Validates: Requirements 7.2, 8.4**

describe('Feature: rocky-mcp-mode, Property 4: Prompt passthrough identity', () => {
  it('the prompt passed to the executor matches the original with no modifications', async () => {
    await fc.assert(
      fc.asyncProperty(
        ownerArb,
        repoNameArb,
        branchArb,
        promptArb,
        async (owner, repo, branch, prompt) => {
          // Track the prompt that the executor receives
          let capturedPrompt: string | undefined

          const mockRepoCloner: RepoClonerMCP = {
            cloneAtBranch: () =>
              Promise.resolve({
                workingDir: '/tmp/fake-working-dir',
                branch: 'main',
              }),
            cleanup: () => Promise.resolve(),
          }

          const mockKiroExecutor = {
            execute: (_workingDir: string, receivedPrompt: string): Promise<ExecutionResult> => {
              capturedPrompt = receivedPrompt
              return Promise.resolve({
                success: true,
                exitCode: 0,
                stdout: 'done',
                stderr: '',
                hasChanges: false,
              })
            },
          }

          const taskStore: MCPTaskStore = createMCPTaskStore(silentLogger)

          const mockAuthResult = {
            getToken: () => Promise.resolve('fake-token'),
            getCloneToken: () => Promise.resolve('fake-token'),
            mode: 'github-app' as const,
            octokit: {} as AuthResult['octokit'],
            botUsername: 'rocky-bot',
          } satisfies AuthResult

          const mockConfig = {
            setupScriptTimeoutMs: 30_000,
          } as WorkerConfig

          const handler = createMCPTaskHandler({
            repoCloner: mockRepoCloner,
            executorRouter: mockKiroExecutor,
            sessionLogWriter: mockSessionLogWriter,
            taskStore,
            jobQueue: {},
            authResult: mockAuthResult,
            config: mockConfig,
            logger: silentLogger,
            summarizer: mockSummarizer,
          })

          const input: MCPTaskInput = {
            repoUrl: `https://github.com/${owner}/${repo}`,
            baseBranch: branch,
            prompt,
          }
          const repoFullName = `${owner}/${repo}`
          const task: MCPTask = taskStore.create(input, repoFullName)

          // executeTask is async — await it
          await handler.executeTask(task)
          expect(capturedPrompt).toBe(buildA2APrompt(prompt))
          // Verify no rocky-worker markers or appended instructions
          expect(capturedPrompt).not.toContain('<!-- rocky-worker -->')
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ── Property 9: Install script content round-trip ──
// **Validates: Requirements 6.1**

describe('Feature: rocky-mcp-mode, Property 9: Install script content round-trip', () => {
  let tmpDir: string | undefined

  afterEach(() => {
    if (tmpDir != null) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
      tmpDir = undefined
    }
  })

  it('writing install script to rocky-install.sh and reading back produces identical content', () => {
    fc.assert(
      fc.property(installScriptArb, (script) => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'))
        const scriptPath = path.join(tmpDir, 'rocky-install.sh')

        fs.writeFileSync(scriptPath, script, { mode: 0o755 })
        const readBack = fs.readFileSync(scriptPath, 'utf-8')

        expect(readBack).toBe(script)

        // Cleanup for this iteration
        fs.rmSync(tmpDir, { recursive: true, force: true })
        tmpDir = undefined
      }),
      { numRuns: 100 },
    )
  })
})

// ── Unit Test: Callers use getCloneToken() for clone operations ──
// **Validates: Requirements 3.5**

describe('Feature: github-api-key-clone-auth, MCP handler uses getCloneToken()', () => {
  it('calls getCloneToken() and not getToken() when executing a task', async () => {
    const mockRepoCloner: RepoClonerMCP = {
      cloneAtBranch: () =>
        Promise.resolve({
          workingDir: '/tmp/fake-working-dir',
          branch: 'main',
        }),
      cleanup: () => Promise.resolve(),
    }

    const mockKiroExecutor = {
      execute: (): Promise<ExecutionResult> =>
        Promise.resolve({
          success: true,
          exitCode: 0,
          stdout: 'done',
          stderr: '',
          hasChanges: false,
        }),
    }

    const taskStore: MCPTaskStore = createMCPTaskStore(silentLogger)

    const getTokenSpy = vi.fn().mockResolvedValue('app-token')
    const getCloneTokenSpy = vi.fn().mockResolvedValue('clone-token')

    const mockAuthResult = {
      getToken: getTokenSpy,
      getCloneToken: getCloneTokenSpy,
      mode: 'github-app' as const,
      octokit: {} as AuthResult['octokit'],
      botUsername: 'rocky-bot',
    } satisfies AuthResult

    const mockConfig = {
      setupScriptTimeoutMs: 30_000,
    } as WorkerConfig

    const handler = createMCPTaskHandler({
      repoCloner: mockRepoCloner,
      executorRouter: mockKiroExecutor,
      sessionLogWriter: mockSessionLogWriter,
      taskStore,
      jobQueue: {},
      authResult: mockAuthResult,
      config: mockConfig,
      logger: silentLogger,
      summarizer: mockSummarizer,
    })

    const input: MCPTaskInput = {
      repoUrl: 'https://github.com/test-owner/test-repo',
      baseBranch: 'main',
      prompt: 'Fix the bug',
    }
    const repoFullName = 'test-owner/test-repo'
    const task: MCPTask = taskStore.create(input, repoFullName)

    await handler.executeTask(task)

    expect(getCloneTokenSpy).toHaveBeenCalledOnce()
    expect(getTokenSpy).not.toHaveBeenCalled()
  })
})

// ── Unit Tests: MCP engine integration ──
// **Validates: Requirements 6.1, 6.2, 6.3**

describe('Feature: rocky-copilot-cli-mode, MCP engine integration', () => {
  it('passes engine field to executor router when task has engine: "copilot"', async () => {
    const mockRepoCloner: RepoClonerMCP = {
      cloneAtBranch: () =>
        Promise.resolve({
          workingDir: '/tmp/fake-working-dir',
          branch: 'main',
        }),
      cleanup: () => Promise.resolve(),
    }

    const executeSpy = vi.fn().mockResolvedValue({
      success: true,
      exitCode: 0,
      stdout: 'done',
      stderr: '',
      hasChanges: false,
    } satisfies ExecutionResult)

    const mockExecutorRouter = { execute: executeSpy }

    const taskStore: MCPTaskStore = createMCPTaskStore(silentLogger)

    const mockAuthResult = {
      getToken: vi.fn().mockResolvedValue('app-token'),
      getCloneToken: vi.fn().mockResolvedValue('clone-token'),
      mode: 'github-app' as const,
      octokit: {} as AuthResult['octokit'],
      botUsername: 'rocky-bot',
    } satisfies AuthResult

    const mockConfig = {
      setupScriptTimeoutMs: 30_000,
    } as WorkerConfig

    const handler = createMCPTaskHandler({
      repoCloner: mockRepoCloner,
      executorRouter: mockExecutorRouter,
      sessionLogWriter: mockSessionLogWriter,
      taskStore,
      jobQueue: {},
      authResult: mockAuthResult,
      config: mockConfig,
      logger: silentLogger,
      summarizer: mockSummarizer,
    })

    const input: MCPTaskInput = {
      repoUrl: 'https://github.com/test-owner/test-repo',
      baseBranch: 'main',
      prompt: 'Implement the feature',
      engine: 'copilot',
    }
    const task: MCPTask = taskStore.create(input, 'test-owner/test-repo')

    await handler.executeTask(task)

    expect(executeSpy).toHaveBeenCalledTimes(2)
    // First call: setup execution (no installScript provided)
    expect(executeSpy).toHaveBeenNthCalledWith(1, '/tmp/fake-working-dir', expect.any(String), {
      engine: 'copilot',
      context: {
        engine: 'copilot',
        repoFullName: 'test-owner/test-repo',
        executionContext: `setup-task-${task.id}`,
      },
    })
    // Second call: main task execution
    expect(executeSpy).toHaveBeenNthCalledWith(
      2,
      '/tmp/fake-working-dir',
      buildA2APrompt('Implement the feature'),
      {
        engine: 'copilot',
        context: {
          engine: 'copilot',
          repoFullName: 'test-owner/test-repo',
          executionContext: `task-${task.id}`,
        },
      },
    )
  })

  it('passes engine as undefined to executor router when task has no engine field', async () => {
    const mockRepoCloner: RepoClonerMCP = {
      cloneAtBranch: () =>
        Promise.resolve({
          workingDir: '/tmp/fake-working-dir',
          branch: 'main',
        }),
      cleanup: () => Promise.resolve(),
    }

    const executeSpy = vi.fn().mockResolvedValue({
      success: true,
      exitCode: 0,
      stdout: 'done',
      stderr: '',
      hasChanges: false,
    } satisfies ExecutionResult)

    const mockExecutorRouter = { execute: executeSpy }

    const taskStore: MCPTaskStore = createMCPTaskStore(silentLogger)

    const mockAuthResult = {
      getToken: vi.fn().mockResolvedValue('app-token'),
      getCloneToken: vi.fn().mockResolvedValue('clone-token'),
      mode: 'github-app' as const,
      octokit: {} as AuthResult['octokit'],
      botUsername: 'rocky-bot',
    } satisfies AuthResult

    const mockConfig = {
      setupScriptTimeoutMs: 30_000,
      defaultEngine: 'kiro',
    } as WorkerConfig

    const handler = createMCPTaskHandler({
      repoCloner: mockRepoCloner,
      executorRouter: mockExecutorRouter,
      sessionLogWriter: mockSessionLogWriter,
      taskStore,
      jobQueue: {},
      authResult: mockAuthResult,
      config: mockConfig,
      logger: silentLogger,
      summarizer: mockSummarizer,
    })

    const input: MCPTaskInput = {
      repoUrl: 'https://github.com/test-owner/test-repo',
      baseBranch: 'main',
      prompt: 'Fix the bug',
    }
    const task: MCPTask = taskStore.create(input, 'test-owner/test-repo')

    await handler.executeTask(task)

    expect(executeSpy).toHaveBeenCalledTimes(2)
    // First call: setup execution (no installScript provided)
    expect(executeSpy).toHaveBeenNthCalledWith(1, '/tmp/fake-working-dir', expect.any(String), {
      engine: undefined,
      context: {
        engine: 'kiro',
        repoFullName: 'test-owner/test-repo',
        executionContext: `setup-task-${task.id}`,
      },
    })
    // Second call: main task execution
    expect(executeSpy).toHaveBeenNthCalledWith(
      2,
      '/tmp/fake-working-dir',
      buildA2APrompt('Fix the bug'),
      {
        engine: undefined,
        context: {
          engine: 'kiro',
          repoFullName: 'test-owner/test-repo',
          executionContext: `task-${task.id}`,
        },
      },
    )
  })

  it('parseTaskInput accepts engine parameter set to "kiro"', () => {
    const result = parseTaskInput({
      repoUrl: 'https://github.com/test-owner/test-repo',
      baseBranch: 'main',
      prompt: 'Do something',
      engine: 'kiro',
    })

    expect(isValidationError(result)).toBe(false)
    if (!isValidationError(result)) {
      expect(result.engine).toBe('kiro')
    }
  })

  it('parseTaskInput accepts engine parameter set to "copilot"', () => {
    const result = parseTaskInput({
      repoUrl: 'https://github.com/test-owner/test-repo',
      baseBranch: 'main',
      prompt: 'Do something',
      engine: 'copilot',
    })

    expect(isValidationError(result)).toBe(false)
    if (!isValidationError(result)) {
      expect(result.engine).toBe('copilot')
    }
  })

  it('parseTaskInput accepts engine parameter set to "claude"', () => {
    const result = parseTaskInput({
      repoUrl: 'https://github.com/test-owner/test-repo',
      baseBranch: 'main',
      prompt: 'Do something',
      engine: 'claude',
    })

    expect(isValidationError(result)).toBe(false)
    if (!isValidationError(result)) {
      expect(result.engine).toBe('claude')
    }
  })

  it('parseTaskInput rejects invalid engine values', () => {
    const result = parseTaskInput({
      repoUrl: 'https://github.com/test-owner/test-repo',
      baseBranch: 'main',
      prompt: 'Do something',
      engine: 'invalid-engine',
    })

    expect(isValidationError(result)).toBe(true)
    if (isValidationError(result)) {
      expect(result.field).toBe('engine')
    }
  })
})
