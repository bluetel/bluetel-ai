// Feature: rocky-a2a-mode — Property tests for A2A_Task_Handler

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as fc from 'fast-check'
import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  A2ATask,
  A2ATaskInput,
  A2ATaskMessage,
  A2ATaskStore,
  AuthResult,
  ExecutionResult,
  RepoClonerA2A,
  WorkerConfig,
} from '../lib/a2a-types'
import { buildA2APrompt } from '../lib/prompt-builder'

import {
  createA2ATaskHandler,
  extractRepoFullName,
  isValidationError,
  parseTaskInput,
} from './a2a-task-handler'
import { createA2ATaskStore } from './a2a-task-store'
import type { SessionLogWriterInstance } from './session-log-writer'
import type { SummarizerInstance } from './summarizer'

// ── Helpers ─────────────────────────────────────────────────────────

const silentLogger = pino({ level: 'silent' })

/** No-op summarizer for tests. */
const mockSummarizer: SummarizerInstance = {
  generateSummary: () => Promise.resolve(null),
}

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

/** Wrap an A2ATaskInput as an A2ATaskMessage (JSON-encoded text part). */
const toMessage = (input: A2ATaskInput): A2ATaskMessage => ({
  role: 'user',
  parts: [{ type: 'text', text: JSON.stringify(input) }],
})

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

/** Arbitrary that generates valid A2ATaskInput objects (without installScript). */
const validInputArb: fc.Arbitrary<A2ATaskInput> = fc.record({
  repoUrl: fc
    .tuple(ownerArb, repoNameArb)
    .map(([owner, repo]) => `https://github.com/${owner}/${repo}`),
  baseBranch: branchArb,
  prompt: promptArb,
})

/** Arbitrary that generates valid A2ATaskInput objects (with installScript). */
const validInputWithInstallArb: fc.Arbitrary<A2ATaskInput> = fc.record({
  repoUrl: fc
    .tuple(ownerArb, repoNameArb)
    .map(([owner, repo]) => `https://github.com/${owner}/${repo}`),
  baseBranch: branchArb,
  installScript: installScriptArb,
  prompt: promptArb,
})

// ── Property 2: Task input validation ──
// **Validates: Requirements 2.2, 2.3, 2.6**

describe('Property 2: Task input validation', () => {
  it('accepts valid inputs with all required fields', () => {
    fc.assert(
      fc.property(validInputArb, (input) => {
        const result = parseTaskInput(toMessage(input))
        expect(isValidationError(result)).toBe(false)
      }),
      { numRuns: 100 },
    )
  })

  it('accepts valid inputs that include an installScript', () => {
    fc.assert(
      fc.property(validInputWithInstallArb, (input) => {
        const result = parseTaskInput(toMessage(input))
        expect(isValidationError(result)).toBe(false)
      }),
      { numRuns: 100 },
    )
  })

  it('rejects inputs with invalid repoUrl and reports field-specific error', () => {
    // Generate strings that do NOT match the GitHub URL pattern
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
        const input = { repoUrl: badUrl, baseBranch: branch, prompt }
        const result = parseTaskInput(toMessage(input))
        expect(isValidationError(result)).toBe(true)
        if (isValidationError(result)) {
          expect(result.field).toBe('repoUrl')
        }
      }),
      { numRuns: 100 },
    )
  })

  it('rejects inputs with invalid baseBranch and reports field-specific error', () => {
    // Characters not allowed in git refs
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
          const input = {
            repoUrl: `https://github.com/${owner}/${repo}`,
            baseBranch: badBranch,
            prompt,
          }
          const result = parseTaskInput(toMessage(input))
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
        const input = {
          repoUrl: `https://github.com/${owner}/${repo}`,
          baseBranch: branch,
          prompt: '',
        }
        const result = parseTaskInput(toMessage(input))
        expect(isValidationError(result)).toBe(true)
        if (isValidationError(result)) {
          expect(result.field).toBe('prompt')
        }
      }),
      { numRuns: 100 },
    )
  })
})

// ── Property 3: Task input parsing round-trip ──
// **Validates: Requirements 2.1**

describe('Property 3: Task input parsing round-trip', () => {
  it('encoding as JSON message and parsing back preserves all fields (without installScript)', () => {
    fc.assert(
      fc.property(validInputArb, (input) => {
        const result = parseTaskInput(toMessage(input))
        expect(isValidationError(result)).toBe(false)
        if (!isValidationError(result)) {
          expect(result.repoUrl).toBe(input.repoUrl)
          expect(result.baseBranch).toBe(input.baseBranch)
          expect(result.prompt).toBe(input.prompt)
          // installScript should be absent when not provided
          expect(result.installScript).toBeUndefined()
        }
      }),
      { numRuns: 100 },
    )
  })

  it('encoding as JSON message and parsing back preserves all fields (with installScript)', () => {
    fc.assert(
      fc.property(validInputWithInstallArb, (input) => {
        const result = parseTaskInput(toMessage(input))
        expect(isValidationError(result)).toBe(false)
        if (!isValidationError(result)) {
          expect(result.repoUrl).toBe(input.repoUrl)
          expect(result.baseBranch).toBe(input.baseBranch)
          expect(result.prompt).toBe(input.prompt)
          expect(result.installScript).toBe(input.installScript)
        }
      }),
      { numRuns: 100 },
    )
  })
})

// ── Property 4: Repo URL extraction ──
// **Validates: Requirements 2.7**

describe('Property 4: Repo URL extraction', () => {
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

// ── Property 5: Prompt passthrough identity ──
// **Validates: Requirements 5.2, 6.4**

describe('Property 5: Prompt passthrough identity', () => {
  it('parseTaskInput returns the prompt exactly as provided with no modifications', () => {
    fc.assert(
      fc.property(ownerArb, repoNameArb, branchArb, promptArb, (owner, repo, branch, prompt) => {
        const input: A2ATaskInput = {
          repoUrl: `https://github.com/${owner}/${repo}`,
          baseBranch: branch,
          prompt,
        }
        const result = parseTaskInput(toMessage(input))
        expect(isValidationError(result)).toBe(false)
        if (!isValidationError(result)) {
          // Prompt must be identical — no appended instructions, no markers
          expect(result.prompt).toBe(prompt)
          expect(result.prompt).not.toContain('<!-- rocky-worker -->')
        }
      }),
      { numRuns: 100 },
    )
  })
})

// ── Property 10: Install script content round-trip ──
// **Validates: Requirements 4.1**

describe('Property 10: Install script content round-trip', () => {
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
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-test-'))
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

describe('Feature: github-api-key-clone-auth, A2A handler uses getCloneToken()', () => {
  it('calls getCloneToken() and not getToken() when executing a task', async () => {
    const mockRepoCloner: RepoClonerA2A = {
      cloneAtBranch: () =>
        Promise.resolve({
          workingDir: '/tmp/fake-working-dir',
          branch: 'main',
        }),
      cleanup: () => Promise.resolve(),
    }

    const mockExecutorRouter = {
      execute: (): Promise<ExecutionResult> =>
        Promise.resolve({
          success: true,
          exitCode: 0,
          stdout: 'done',
          stderr: '',
          hasChanges: false,
        }),
    }

    const taskStore: A2ATaskStore = createA2ATaskStore(silentLogger)

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

    const handler = createA2ATaskHandler({
      repoCloner: mockRepoCloner,
      sessionLogWriter: mockSessionLogWriter,
      executorRouter: mockExecutorRouter,
      taskStore,
      jobQueue: {},
      authResult: mockAuthResult,
      config: mockConfig,
      logger: silentLogger,
      summarizer: mockSummarizer,
    })

    const input: A2ATaskInput = {
      repoUrl: 'https://github.com/test-owner/test-repo',
      baseBranch: 'main',
      prompt: 'Fix the bug',
    }
    const repoFullName = 'test-owner/test-repo'
    const task: A2ATask = taskStore.create(input, repoFullName)

    await handler.executeTask(task)

    expect(getCloneTokenSpy).toHaveBeenCalledOnce()
    expect(getTokenSpy).not.toHaveBeenCalled()
  })
})

// ── Feature: rocky-copilot-cli-mode, Property 3: Engine field validation ──
// **Validates: Requirements 5.1, 5.4, 6.1, 6.4**

describe('Feature: rocky-copilot-cli-mode, Property 3: Engine field validation', () => {
  /** Build a valid A2ATaskMessage with a given engine value (or omit it). */
  const toMessageWithEngine = (engine: string | undefined): A2ATaskMessage => {
    const payload: Record<string, unknown> = {
      repoUrl: 'https://github.com/test-owner/test-repo',
      baseBranch: 'main',
      prompt: 'Fix the bug',
    }
    if (engine !== undefined) {
      payload['engine'] = engine
    }
    return {
      role: 'user',
      parts: [{ type: 'text', text: JSON.stringify(payload) }],
    }
  }

  it('accepts valid engine values ("kiro", "copilot", and "claude")', () => {
    const validEngineArb = fc.constantFrom('kiro', 'copilot', 'claude')

    fc.assert(
      fc.property(validEngineArb, (engine) => {
        const result = parseTaskInput(toMessageWithEngine(engine))
        expect(isValidationError(result)).toBe(false)
        if (!isValidationError(result)) {
          expect(result.engine).toBe(engine)
        }
      }),
      { numRuns: 100 },
    )
  })

  it('accepts input when engine is absent (undefined)', () => {
    fc.assert(
      fc.property(ownerArb, repoNameArb, branchArb, promptArb, (owner, repo, branch, prompt) => {
        const payload: Record<string, unknown> = {
          repoUrl: `https://github.com/${owner}/${repo}`,
          baseBranch: branch,
          prompt,
        }
        const message: A2ATaskMessage = {
          role: 'user',
          parts: [{ type: 'text', text: JSON.stringify(payload) }],
        }
        const result = parseTaskInput(message)
        expect(isValidationError(result)).toBe(false)
        if (!isValidationError(result)) {
          expect(result.engine).toBeUndefined()
        }
      }),
      { numRuns: 100 },
    )
  })

  it('rejects invalid engine values and reports the engine field', () => {
    // Generate arbitrary strings that are NOT 'kiro', 'copilot', or 'claude'
    const invalidEngineArb = fc
      .string({ minLength: 1, maxLength: 50 })
      .filter((s) => s !== 'kiro' && s !== 'copilot' && s !== 'claude')

    fc.assert(
      fc.property(invalidEngineArb, (engine) => {
        const result = parseTaskInput(toMessageWithEngine(engine))
        expect(isValidationError(result)).toBe(true)
        if (isValidationError(result)) {
          expect(result.field).toBe('engine')
        }
      }),
      { numRuns: 100 },
    )
  })
})

// ── Unit Tests: A2A engine integration ──
// **Validates: Requirements 5.2, 5.3**

describe('Feature: rocky-copilot-cli-mode, A2A engine integration', () => {
  it('passes engine field to executor router when task has engine set', async () => {
    const mockRepoCloner: RepoClonerA2A = {
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

    const taskStore: A2ATaskStore = createA2ATaskStore(silentLogger)

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

    const handler = createA2ATaskHandler({
      repoCloner: mockRepoCloner,
      sessionLogWriter: mockSessionLogWriter,
      executorRouter: mockExecutorRouter,
      taskStore,
      jobQueue: {},
      authResult: mockAuthResult,
      config: mockConfig,
      logger: silentLogger,
      summarizer: mockSummarizer,
    })

    const input: A2ATaskInput = {
      repoUrl: 'https://github.com/test-owner/test-repo',
      baseBranch: 'main',
      prompt: 'Implement the feature',
      engine: 'copilot',
    }
    const task: A2ATask = taskStore.create(input, 'test-owner/test-repo')

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
    const mockRepoCloner: RepoClonerA2A = {
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

    const taskStore: A2ATaskStore = createA2ATaskStore(silentLogger)

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

    const handler = createA2ATaskHandler({
      repoCloner: mockRepoCloner,
      sessionLogWriter: mockSessionLogWriter,
      executorRouter: mockExecutorRouter,
      taskStore,
      jobQueue: {},
      authResult: mockAuthResult,
      config: mockConfig,
      logger: silentLogger,
      summarizer: mockSummarizer,
    })

    const input: A2ATaskInput = {
      repoUrl: 'https://github.com/test-owner/test-repo',
      baseBranch: 'main',
      prompt: 'Fix the bug',
    }
    const task: A2ATask = taskStore.create(input, 'test-owner/test-repo')

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
})
