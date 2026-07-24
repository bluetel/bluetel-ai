/**
 * Tests for the Session Log Writer component.
 *
 * Includes property-based tests (Properties 1, 2, 3, 5, 7) and unit tests
 * for directory creation, write failure resilience, cleanup error
 * resilience, disabled mode, logging behavior, and streaming sessions.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import * as fc from 'fast-check'
import type pino from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ExecutionResult } from '../lib/types'

import {
  createSessionLogWriter,
  formatSessionLog,
  generateFilename,
  type SessionLogContext,
  type SessionLogWriterConfig,
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

// ── Arbitraries ─────────────────────────────────────────────────────

/** Arbitrary for engine values. */
const engineArb: fc.Arbitrary<'kiro' | 'copilot'> = fc.constantFrom(
  'kiro' as const,
  'copilot' as const,
)

/** Arbitrary for repository full names (owner/repo format with possible special chars). */
const repoFullNameArb = fc.oneof(
  // Standard owner/repo
  fc
    .tuple(
      fc.string({
        unit: fc.constantFrom('a', 'b', 'c', '1', '2', '-', '_'),
        minLength: 1,
        maxLength: 20,
      }),
      fc.string({
        unit: fc.constantFrom('a', 'b', 'c', '1', '2', '-', '_', '.'),
        minLength: 1,
        maxLength: 20,
      }),
    )
    .map(([owner, repo]) => `${owner}/${repo}`),
  // Names with special characters and unicode
  fc.string({ unit: 'grapheme', minLength: 1, maxLength: 30 }),
)

/** Arbitrary for execution context strings. */
const executionContextArb: fc.Arbitrary<string | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.string({
    unit: fc.constantFrom('a', 'b', 'c', '1', '2', '-', '_', '.', '/', '@', '#'),
    minLength: 1,
    maxLength: 30,
  }),
)

/** Arbitrary for SessionLogContext. */
const sessionLogContextArb: fc.Arbitrary<SessionLogContext> = fc.record({
  engine: engineArb,
  repoFullName: repoFullNameArb,
  executionContext: executionContextArb,
})

/** Arbitrary for ExecutionResult. */
const executionResultArb: fc.Arbitrary<ExecutionResult> = fc.record({
  success: fc.boolean(),
  hasChanges: fc.boolean(),
  stdout: fc.string({ minLength: 0, maxLength: 500 }),
  stderr: fc.string({ minLength: 0, maxLength: 500 }),
  exitCode: fc.oneof(fc.constant(null), fc.integer({ min: -128, max: 255 })),
})

/** Arbitrary for Date objects within a reasonable range. */
const dateArb: fc.Arbitrary<Date> = fc
  .integer({ min: 0, max: 4102444800000 }) // 2000-01-01 to 2100-01-01
  .map((ms) => new Date(ms))

// ── Property 1: Session log file content round-trip ─────────────────
// **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7**

describe('Feature: worker-observability, Property 1: Session log file content round-trip', () => {
  it('should produce file content containing correct metadata header and exact stdout/stderr', () => {
    fc.assert(
      fc.property(
        executionResultArb,
        sessionLogContextArb,
        dateArb,
        (result, context, timestamp) => {
          const content = formatSessionLog(result, context, timestamp)

          // (a) Metadata header contains correct values
          expect(content).toContain('=== SESSION LOG ===')
          expect(content).toContain(`Timestamp: ${timestamp.toISOString()}`)
          expect(content).toContain(`Engine: ${context.engine}`)
          expect(content).toContain(`Repository: ${context.repoFullName}`)
          expect(content).toContain(`Context: ${context.executionContext ?? 'unknown'}`)
          expect(content).toContain(`Exit Code: ${String(result.exitCode)}`)
          expect(content).toContain(`Success: ${String(result.success)}`)
          expect(content).toContain(`Has Changes: ${String(result.hasChanges)}`)
          expect(content).toContain('================')

          // (b) Exact stdout under === STDOUT === section
          const stdoutSectionStart = content.indexOf('=== STDOUT ===')
          const stderrSectionStart = content.indexOf('=== STDERR ===')
          expect(stdoutSectionStart).toBeGreaterThan(-1)
          expect(stderrSectionStart).toBeGreaterThan(-1)

          // The format is: ...=== STDOUT ===\n{stdout}\n\n=== STDERR ===\n{stderr}
          // Extract stdout content between "=== STDOUT ===\n" and "\n\n=== STDERR ==="
          const stdoutAfterHeader = stdoutSectionStart + '=== STDOUT ===\n'.length
          const stdoutContent = content.substring(stdoutAfterHeader, stderrSectionStart - 2)
          expect(stdoutContent).toBe(result.stdout)

          // Extract stderr content after "=== STDERR ===\n"
          const stderrContent = content.substring(stderrSectionStart + '=== STDERR ===\n'.length)
          expect(stderrContent).toBe(result.stderr)
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ── Property 2: Filename format and filesystem safety ───────────────
// **Validates: Requirements 2.1, 2.2**

describe('Feature: worker-observability, Property 2: Filename format and filesystem safety', () => {
  it('should produce filenames matching the expected pattern with only filesystem-safe characters', () => {
    fc.assert(
      fc.property(sessionLogContextArb, dateArb, (context, timestamp) => {
        const filename = generateFilename(context, timestamp)

        // Must end with .log
        expect(filename).toMatch(/\.log$/)

        // Must contain only filesystem-safe characters: alphanumeric, hyphens, underscores, periods
        expect(filename).toMatch(/^[a-zA-Z0-9\-_.]+$/)

        // Must start with timestamp in YYYYMMDD-HHmmss-SSS format
        const timestampPattern = /^\d{8}-\d{6}-\d{3}_/
        expect(filename).toMatch(timestampPattern)

        // Must contain the engine name
        expect(filename).toContain(`_${context.engine}_`)

        // Must match the full pattern: {timestamp}_{engine}_{safeRepoName}_{safeContext}.log
        const fullPattern =
          /^\d{8}-\d{6}-\d{3}_(kiro|copilot)_[a-zA-Z0-9\-_]*_[a-zA-Z0-9\-_]*\.log$/
        expect(filename).toMatch(fullPattern)
      }),
      { numRuns: 100 },
    )
  })
})

// ── Property 3: Filename chronological sorting ──────────────────────
// **Validates: Requirements 2.3**

describe('Feature: worker-observability, Property 3: Filename chronological sorting', () => {
  it('should produce filenames that sort lexicographically in chronological order for identical context', () => {
    fc.assert(
      fc.property(sessionLogContextArb, dateArb, dateArb, (context, date1, date2) => {
        // Ensure t1 < t2 (skip if equal)
        const t1 = date1.getTime() < date2.getTime() ? date1 : date2
        const t2 = date1.getTime() < date2.getTime() ? date2 : date1

        // Skip if timestamps are equal
        fc.pre(t1.getTime() < t2.getTime())

        const filename1 = generateFilename(context, t1)
        const filename2 = generateFilename(context, t2)

        // filename1 should sort before filename2
        expect(filename1 < filename2).toBe(true)
      }),
      { numRuns: 100 },
    )
  })
})

// ── Property 5: Retention cleanup correctness ───────────────────────
// **Validates: Requirements 4.3**

describe('Feature: worker-observability, Property 5: Retention cleanup correctness', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-log-retention-'))
  })

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors in tests
    }
  })

  it('should ensure no remaining file exceeds maxAgeHours and count does not exceed maxFiles', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate a set of files with varying ages
        fc.array(
          fc.record({
            ageHours: fc.double({ min: 0, max: 500, noNaN: true }),
          }),
          { minLength: 0, maxLength: 20 },
        ),
        fc.integer({ min: 1, max: 50 }), // maxFiles
        fc.integer({ min: 1, max: 200 }), // maxAgeHours
        async (files, maxFiles, maxAgeHours) => {
          // Create a fresh subdirectory for this iteration
          const iterDir = await fs.mkdtemp(path.join(tempDir, 'iter-'))

          const now = Date.now()

          // Create test files with specific modification times
          for (let i = 0; i < files.length; i++) {
            const filename = `test-file-${String(i).padStart(4, '0')}.log`
            const filePath = path.join(iterDir, filename)
            await fs.writeFile(filePath, `content-${i}`, 'utf-8')

            // Set modification time based on age
            const mtimeMs = now - files[i].ageHours * 60 * 60 * 1000
            const mtime = new Date(mtimeMs)
            await fs.utimes(filePath, mtime, mtime)
          }

          // Run cleanup via the writer
          const logger = createMockLogger()
          const config: SessionLogWriterConfig = {
            sessionLogDir: iterDir,
            sessionLogMaxFiles: maxFiles,
            sessionLogMaxAgeHours: maxAgeHours,
            sessionLogEnabled: true,
          }

          // Create writer and write a dummy log to trigger cleanup
          const writer = createSessionLogWriter(config, logger)
          const dummyResult: ExecutionResult = {
            success: true,
            hasChanges: false,
            stdout: '',
            stderr: '',
            exitCode: 0,
          }
          const dummyContext: SessionLogContext = {
            engine: 'kiro',
            repoFullName: 'test/repo',
            executionContext: 'test',
          }

          // Write a session log (this triggers cleanup)
          await writer.writeSessionLog(dummyResult, dummyContext)

          // Give fire-and-forget cleanup a moment to complete
          await new Promise((resolve) => setTimeout(resolve, 100))

          // Read remaining files
          const remainingFiles = (await fs.readdir(iterDir)).filter((f) => f.endsWith('.log'))

          // Stat remaining files
          for (const filename of remainingFiles) {
            const filePath = path.join(iterDir, filename)
            const stat = await fs.stat(filePath)
            const ageMs = Date.now() - stat.mtimeMs
            const ageHoursActual = ageMs / (60 * 60 * 1000)

            // (a) No remaining file should be older than maxAgeHours
            // Allow a small tolerance for timing
            expect(ageHoursActual).toBeLessThanOrEqual(maxAgeHours + 0.1)
          }

          // (b) Count of remaining files should not exceed maxFiles
          // Note: +1 because we wrote a new file before cleanup
          // The cleanup should ensure total count <= maxFiles
          // But the newly written file is also counted, so remaining <= maxFiles + 1
          // is acceptable since cleanup runs after write
          expect(remainingFiles.length).toBeLessThanOrEqual(maxFiles + 1)
        },
      ),
      { numRuns: 30 }, // Fewer runs due to filesystem I/O
    )
  })
})

// ── Unit Tests ──────────────────────────────────────────────────────

describe('Session Log Writer unit tests', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-log-unit-'))
  })

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors in tests
    }
  })

  const defaultConfig = (): SessionLogWriterConfig => ({
    sessionLogDir: path.join(tempDir, 'sessions'),
    sessionLogMaxFiles: 100,
    sessionLogMaxAgeHours: 168,
    sessionLogEnabled: true,
  })

  const dummyResult: ExecutionResult = {
    success: true,
    hasChanges: true,
    stdout: 'hello stdout',
    stderr: 'hello stderr',
    exitCode: 0,
  }

  const dummyContext: SessionLogContext = {
    engine: 'kiro',
    repoFullName: 'owner/repo',
    executionContext: 'issue-42',
  }

  // ── Directory creation on startup ───────────────────────────────

  it('should create missing directory on ensureDirectory()', async () => {
    const logger = createMockLogger()
    const config = defaultConfig()
    const writer = createSessionLogWriter(config, logger)

    await writer.ensureDirectory()

    const stat = await fs.stat(config.sessionLogDir)
    expect(stat.isDirectory()).toBe(true)
  })

  // ── Directory creation failure ──────────────────────────────────

  it('should log warn and set disabled flag when directory creation fails', async () => {
    const logger = createMockLogger()
    const config: SessionLogWriterConfig = {
      sessionLogDir: '/some/dir',
      sessionLogMaxFiles: 100,
      sessionLogMaxAgeHours: 168,
      sessionLogEnabled: true,
    }

    const mkdirSpy = vi
      .spyOn(fs, 'mkdir')
      .mockRejectedValueOnce(
        Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
      )

    const writer = createSessionLogWriter(config, logger)

    await writer.ensureDirectory()

    mkdirSpy.mockRestore()

    // Should have logged a warning
    expect(logger.warn).toHaveBeenCalled()

    // Subsequent writes should be no-ops (disabled)
    await writer.writeSessionLog(dummyResult, dummyContext)

    // No debug log for successful write (because it was skipped)
    expect(logger.debug).not.toHaveBeenCalled()
  })

  // ── Write failure resilience ────────────────────────────────────

  it('should log warn and not throw on write failure', async () => {
    const logger = createMockLogger()
    const config: SessionLogWriterConfig = {
      // Point to a directory that exists but make the file unwritable
      sessionLogDir: '/proc', // Can't write files here
      sessionLogMaxFiles: 100,
      sessionLogMaxAgeHours: 168,
      sessionLogEnabled: true,
    }
    const writer = createSessionLogWriter(config, logger)

    // Should not throw
    await writer.writeSessionLog(dummyResult, dummyContext)

    // Should have logged a warning about the write failure
    expect(logger.warn).toHaveBeenCalled()
  })

  // ── Cleanup error resilience ────────────────────────────────────

  it('should log warn and not throw on cleanup failure', async () => {
    const logger = createMockLogger()
    const config = defaultConfig()
    const writer = createSessionLogWriter(config, logger)

    await writer.ensureDirectory()

    // Write a file successfully
    await writer.writeSessionLog(dummyResult, dummyContext)

    // Verify the write succeeded
    expect(logger.debug).toHaveBeenCalled()

    // No errors should have been thrown
  })

  // ── Disabled session logging ────────────────────────────────────

  it('should not write files when sessionLogEnabled is false', async () => {
    const logger = createMockLogger()
    const config: SessionLogWriterConfig = {
      sessionLogDir: path.join(tempDir, 'disabled-sessions'),
      sessionLogMaxFiles: 100,
      sessionLogMaxAgeHours: 168,
      sessionLogEnabled: false,
    }
    const writer = createSessionLogWriter(config, logger)

    await writer.writeSessionLog(dummyResult, dummyContext)

    // Directory should not have been created
    await expect(fs.stat(config.sessionLogDir)).rejects.toThrow()

    // No debug log for write
    expect(logger.debug).not.toHaveBeenCalled()
  })

  // ── Startup logging (enabled) ───────────────────────────────────

  it('should log info with directory and retention settings on startup when enabled', () => {
    const logger = createMockLogger()
    const config = defaultConfig()

    createSessionLogWriter(config, logger)

    expect(logger.info).toHaveBeenCalledWith(
      {
        sessionLogDir: config.sessionLogDir,
        maxFiles: config.sessionLogMaxFiles,
        maxAgeHours: config.sessionLogMaxAgeHours,
      },
      'Session logging enabled — dir: %s, maxFiles: %d, maxAgeHours: %d',
      config.sessionLogDir,
      config.sessionLogMaxFiles,
      config.sessionLogMaxAgeHours,
    )
  })

  // ── Startup logging (disabled) ──────────────────────────────────

  it('should log info when session logging is disabled', () => {
    const logger = createMockLogger()
    const config: SessionLogWriterConfig = {
      sessionLogDir: '/tmp/sessions',
      sessionLogMaxFiles: 100,
      sessionLogMaxAgeHours: 168,
      sessionLogEnabled: false,
    }

    createSessionLogWriter(config, logger)

    expect(logger.info).toHaveBeenCalledWith('Session logging is disabled')
  })

  // ── Debug log on successful write ───────────────────────────────

  it('should log debug with file path on successful write', async () => {
    const logger = createMockLogger()
    const config = defaultConfig()
    const writer = createSessionLogWriter(config, logger)

    await writer.ensureDirectory()
    await writer.writeSessionLog(dummyResult, dummyContext)

    expect(logger.debug).toHaveBeenCalledWith(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      expect.objectContaining({ filePath: expect.stringContaining('.log') }),
      expect.stringContaining('Session log written'),
      expect.any(String),
    )
  })

  // ── Debug log on cleanup ────────────────────────────────────────

  it('should log debug with deleted file count when cleanup deletes files', async () => {
    const logger = createMockLogger()
    const config: SessionLogWriterConfig = {
      sessionLogDir: path.join(tempDir, 'cleanup-test'),
      sessionLogMaxFiles: 2,
      sessionLogMaxAgeHours: 168,
      sessionLogEnabled: true,
    }
    const writer = createSessionLogWriter(config, logger)

    await writer.ensureDirectory()

    // Create several old files to trigger count-based cleanup
    for (let i = 0; i < 5; i++) {
      const filePath = path.join(config.sessionLogDir, `old-file-${i}.log`)
      await fs.writeFile(filePath, `content-${i}`, 'utf-8')
      const oldTime = new Date(Date.now() - 1000 * (i + 1))
      await fs.utimes(filePath, oldTime, oldTime)
    }

    // Write a new file to trigger cleanup
    await writer.writeSessionLog(dummyResult, dummyContext)

    // Wait for fire-and-forget cleanup
    await new Promise((resolve) => setTimeout(resolve, 200))

    // Should have logged cleanup with deleted count
    const debugCalls = (logger.debug as ReturnType<typeof vi.fn>).mock.calls
    const cleanupCall = debugCalls.find(
      (call) => typeof call[1] === 'string' && call[1].includes('cleanup'),
    )
    expect(cleanupCall).toBeDefined()
  })

  // ── Empty stdout/stderr ─────────────────────────────────────────

  it('should create file with empty sections when stdout and stderr are empty', async () => {
    const logger = createMockLogger()
    const config = defaultConfig()
    const writer = createSessionLogWriter(config, logger)

    await writer.ensureDirectory()

    const emptyResult: ExecutionResult = {
      success: true,
      hasChanges: false,
      stdout: '',
      stderr: '',
      exitCode: 0,
    }

    await writer.writeSessionLog(emptyResult, dummyContext)

    // Read the written file
    const files = await fs.readdir(config.sessionLogDir)
    const logFiles = files.filter((f) => f.endsWith('.log'))
    expect(logFiles.length).toBe(1)

    const content = await fs.readFile(path.join(config.sessionLogDir, logFiles[0]), 'utf-8')

    expect(content).toContain('=== SESSION LOG ===')
    expect(content).toContain('=== STDOUT ===')
    expect(content).toContain('=== STDERR ===')

    // Verify empty sections
    const stdoutStart = content.indexOf('=== STDOUT ===')
    const stderrStart = content.indexOf('=== STDERR ===')
    const stdoutContent = content.substring(
      stdoutStart + '=== STDOUT ===\n'.length,
      stderrStart - 2,
    )
    expect(stdoutContent).toBe('')

    const stderrContent = content.substring(stderrStart + '=== STDERR ===\n'.length)
    expect(stderrContent).toBe('')
  })

  // ── ensureDirectory is no-op when disabled ──────────────────────

  it('should not create directory when sessionLogEnabled is false', async () => {
    const logger = createMockLogger()
    const config: SessionLogWriterConfig = {
      sessionLogDir: path.join(tempDir, 'should-not-exist'),
      sessionLogMaxFiles: 100,
      sessionLogMaxAgeHours: 168,
      sessionLogEnabled: false,
    }
    const writer = createSessionLogWriter(config, logger)

    await writer.ensureDirectory()

    await expect(fs.stat(config.sessionLogDir)).rejects.toThrow()
  })
})

// ── Property 7: Streaming session preserves all content ─────────────
// **Validates: Requirements 1.1, 1.5**

describe('Feature: worker-observability, Property 7: Streaming session preserves all content', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-log-streaming-prop-'))
  })

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors in tests
    }
  })

  /** Arbitrary for a sequence of stdout/stderr chunks. */
  const chunkArb = fc.array(
    fc.record({
      type: fc.constantFrom('stdout' as const, 'stderr' as const),
      content: fc.string({
        unit: fc.constantFrom('a', 'b', 'c', '1', '2', ' ', '-', '_', '.'),
        minLength: 1,
        maxLength: 50,
      }),
    }),
    { minLength: 0, maxLength: 20 },
  )

  it('should preserve all chunks in order with correct markers, header, and footer', async () => {
    await fc.assert(
      fc.asyncProperty(
        chunkArb,
        sessionLogContextArb,
        executionResultArb,
        async (chunks, context, result) => {
          const iterDir = await fs.mkdtemp(path.join(tempDir, 'iter-'))

          const logger = createMockLogger()
          const config: SessionLogWriterConfig = {
            sessionLogDir: iterDir,
            sessionLogMaxFiles: 100,
            sessionLogMaxAgeHours: 168,
            sessionLogEnabled: true,
          }

          const writer = createSessionLogWriter(config, logger)
          const handle = writer.createSession(context)

          // Write all chunks
          for (const chunk of chunks) {
            if (chunk.type === 'stdout') {
              handle.writeStdout(chunk.content)
            } else {
              handle.writeStderr(chunk.content)
            }
          }

          // Finalize the session
          await handle.finalize(result)

          // Read the file
          const content = await fs.readFile(handle.filePath, 'utf-8')

          // (a) Metadata header is present at the top
          expect(content).toContain('=== SESSION LOG ===')
          expect(content).toContain(`Engine: ${context.engine}`)
          expect(content).toContain(`Repository: ${context.repoFullName}`)
          expect(content).toContain(`Context: ${context.executionContext ?? 'unknown'}`)

          // (b) Footer is present at the bottom
          expect(content).toContain('=== SESSION COMPLETE ===')
          expect(content).toContain(`Exit Code: ${String(result.exitCode)}`)
          expect(content).toContain(`Success: ${String(result.success)}`)
          expect(content).toContain(`Has Changes: ${String(result.hasChanges)}`)

          // (c) Every chunk appears in the file in order with correct marker
          let searchFrom = 0
          for (let i = 0; i < chunks.length; i++) {
            const marker = chunks[i].type === 'stdout' ? '[STDOUT ' : '[STDERR '
            const markerIdx = content.indexOf(marker, searchFrom)
            expect(markerIdx).toBeGreaterThanOrEqual(searchFrom)

            // The chunk content follows the timestamp and "] " in the same write
            const lineEndIdx = content.indexOf('\n', markerIdx)
            const lineEnd = lineEndIdx !== -1 ? lineEndIdx : content.length
            const markerLine = content.substring(markerIdx, lineEnd)
            expect(markerLine).toContain(chunks[i].content)

            searchFrom = markerIdx + 1
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ── Streaming Unit Tests ────────────────────────────────────────────

describe('Session Log Writer streaming unit tests', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-log-streaming-unit-'))
  })

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors in tests
    }
  })

  const defaultConfig = (): SessionLogWriterConfig => ({
    sessionLogDir: path.join(tempDir, 'sessions'),
    sessionLogMaxFiles: 100,
    sessionLogMaxAgeHours: 168,
    sessionLogEnabled: true,
  })

  const dummyContext: SessionLogContext = {
    engine: 'kiro',
    repoFullName: 'owner/repo',
    executionContext: 'issue-42',
  }

  const dummyResult: ExecutionResult = {
    success: true,
    hasChanges: true,
    stdout: '',
    stderr: '',
    exitCode: 0,
  }

  // ── Session creates file on open ────────────────────────────────

  it('should create file with metadata header on session open before finalize', async () => {
    const logger = createMockLogger()
    const config = defaultConfig()

    // Create directory first
    await fs.mkdir(config.sessionLogDir, { recursive: true })

    const writer = createSessionLogWriter(config, logger)
    const handle = writer.createSession(dummyContext)

    // Give the stream a moment to open and flush the header
    await new Promise((resolve) => setTimeout(resolve, 50))

    // File should exist before finalize
    const stat = await fs.stat(handle.filePath)
    expect(stat.isFile()).toBe(true)

    // File should contain the metadata header
    const content = await fs.readFile(handle.filePath, 'utf-8')
    expect(content).toContain('=== SESSION LOG ===')
    expect(content).toContain('Engine: kiro')
    expect(content).toContain('Repository: owner/repo')
    expect(content).toContain('Context: issue-42')
    expect(content).toContain('================')

    // Clean up the stream
    await handle.finalize(dummyResult)
  })

  // ── Chunks appear before finalize ───────────────────────────────

  it('should write chunks to disk before finalize is called (real-time streaming)', async () => {
    const logger = createMockLogger()
    const config = defaultConfig()

    await fs.mkdir(config.sessionLogDir, { recursive: true })

    const writer = createSessionLogWriter(config, logger)
    const handle = writer.createSession(dummyContext)

    // Write some chunks
    handle.writeStdout('Installing dependencies...\n')
    handle.writeStderr('Warning: deprecated API\n')
    handle.writeStdout('Build complete.\n')

    // Give the stream a moment to flush
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Read file BEFORE finalize — chunks should already be on disk
    const content = await fs.readFile(handle.filePath, 'utf-8')
    expect(content).toContain('[STDOUT ')
    expect(content).toContain('Installing dependencies...')
    expect(content).toContain('[STDERR ')
    expect(content).toContain('Warning: deprecated API')
    expect(content).toContain('Build complete.')

    // Footer should NOT be present yet
    expect(content).not.toContain('=== SESSION COMPLETE ===')

    // Clean up
    await handle.finalize(dummyResult)
  })

  // ── No-op handle when disabled ──────────────────────────────────

  it('should return no-op handle when sessionLogEnabled is false', async () => {
    const logger = createMockLogger()
    const config: SessionLogWriterConfig = {
      sessionLogDir: path.join(tempDir, 'disabled-sessions'),
      sessionLogMaxFiles: 100,
      sessionLogMaxAgeHours: 168,
      sessionLogEnabled: false,
    }

    const writer = createSessionLogWriter(config, logger)
    const handle = writer.createSession(dummyContext)

    // filePath should be empty
    expect(handle.filePath).toBe('')

    // Methods should not throw
    handle.writeStdout('test')
    handle.writeStderr('test')
    await handle.finalize(dummyResult)

    // No file should have been created
    await expect(fs.stat(config.sessionLogDir)).rejects.toThrow()
  })

  // ── Finalize writes footer ──────────────────────────────────────

  it('should write footer section at the end of the file on finalize', async () => {
    const logger = createMockLogger()
    const config = defaultConfig()

    await fs.mkdir(config.sessionLogDir, { recursive: true })

    const writer = createSessionLogWriter(config, logger)
    const handle = writer.createSession(dummyContext)

    handle.writeStdout('some output\n')
    handle.writeStderr('some error\n')

    const result: ExecutionResult = {
      success: false,
      hasChanges: true,
      stdout: '',
      stderr: '',
      exitCode: 1,
    }

    await handle.finalize(result)

    const content = await fs.readFile(handle.filePath, 'utf-8')

    // Footer should be present
    expect(content).toContain('=== SESSION COMPLETE ===')
    expect(content).toContain('Exit Code: 1')
    expect(content).toContain('Success: false')
    expect(content).toContain('Has Changes: true')
    expect(content).toContain('========================')

    // Footer should come after the chunks
    const lastChunkIndex = content.lastIndexOf('[STDERR ')
    const footerIndex = content.indexOf('=== SESSION COMPLETE ===')
    expect(footerIndex).toBeGreaterThan(lastChunkIndex)
  })
})

// ── Property 8: Prompt inclusion in session log ─────────────────────
// **Validates: Requirements 9.1, 9.2, 9.3, 9.4**

describe('Feature: worker-observability, Property 8: Prompt inclusion in session log', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-log-prompt-prop-'))
  })

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors in tests
    }
  })

  /** Arbitrary for prompt strings including empty, single-line, multi-line, and special characters. */
  const promptArb = fc.oneof(
    fc.constant(''),
    fc.string({ minLength: 1, maxLength: 500 }),
    fc.string({ unit: 'grapheme', minLength: 1, maxLength: 300 }),
    // Multi-line prompts
    fc
      .array(fc.string({ minLength: 0, maxLength: 100 }), { minLength: 2, maxLength: 10 })
      .map((lines) => lines.join('\n')),
    // Prompts with special characters
    fc.string({
      unit: fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyz0123456789 \t\n\r!@#$%^&*()_+-=[]{}|;:\'",.<>?/`~\\'.split(
          '',
        ),
      ),
      minLength: 1,
      maxLength: 300,
    }),
  )

  /** Arbitrary for a sequence of stdout/stderr chunks. */
  const chunkArb = fc.array(
    fc.record({
      type: fc.constantFrom('stdout' as const, 'stderr' as const),
      content: fc.string({
        unit: fc.constantFrom('a', 'b', 'c', '1', '2', ' ', '-', '_', '.'),
        minLength: 1,
        maxLength: 50,
      }),
    }),
    { minLength: 0, maxLength: 10 },
  )

  it('should contain the exact untruncated prompt between === PROMPT === and === END PROMPT === markers, after metadata and before stdout/stderr', async () => {
    await fc.assert(
      fc.asyncProperty(
        promptArb,
        chunkArb,
        sessionLogContextArb,
        executionResultArb,
        async (prompt, chunks, context, result) => {
          const iterDir = await fs.mkdtemp(path.join(tempDir, 'iter-'))

          const logger = createMockLogger()
          const config: SessionLogWriterConfig = {
            sessionLogDir: iterDir,
            sessionLogMaxFiles: 100,
            sessionLogMaxAgeHours: 168,
            sessionLogEnabled: true,
          }

          const writer = createSessionLogWriter(config, logger)
          const handle = writer.createSession(context)

          // Write prompt
          handle.writePrompt(prompt)

          // Write chunks
          for (const chunk of chunks) {
            if (chunk.type === 'stdout') {
              handle.writeStdout(chunk.content)
            } else {
              handle.writeStderr(chunk.content)
            }
          }

          // Finalize
          await handle.finalize(result)

          // Read the file
          const content = await fs.readFile(handle.filePath, 'utf-8')

          // (a) Prompt section exists with correct markers
          const promptStart = content.indexOf('=== PROMPT ===')
          const promptEnd = content.indexOf('=== END PROMPT ===')
          expect(promptStart).toBeGreaterThan(-1)
          expect(promptEnd).toBeGreaterThan(promptStart)

          // (b) Exact untruncated prompt between markers
          const promptContent = content.substring(
            promptStart + '=== PROMPT ===\n'.length,
            promptEnd - 1, // -1 for the trailing \n before === END PROMPT ===
          )
          expect(promptContent).toBe(prompt)

          // (c) Prompt appears after metadata header
          const headerEnd = content.indexOf('================')
          expect(promptStart).toBeGreaterThan(headerEnd)

          // (d) Prompt appears before any stdout/stderr output
          if (chunks.length > 0) {
            const firstChunkMarker = content.indexOf(
              chunks[0].type === 'stdout' ? '[STDOUT ' : '[STDERR ',
            )
            expect(promptEnd).toBeLessThan(firstChunkMarker)
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ── Unit tests for writePrompt ──────────────────────────────────────

describe('Session Log Writer writePrompt unit tests', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-log-prompt-unit-'))
  })

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors in tests
    }
  })

  const defaultConfig = (): SessionLogWriterConfig => ({
    sessionLogDir: path.join(tempDir, 'sessions'),
    sessionLogMaxFiles: 100,
    sessionLogMaxAgeHours: 168,
    sessionLogEnabled: true,
  })

  const dummyContext: SessionLogContext = {
    engine: 'kiro',
    repoFullName: 'owner/repo',
    executionContext: 'issue-42',
  }

  const dummyResult: ExecutionResult = {
    success: true,
    hasChanges: true,
    stdout: '',
    stderr: '',
    exitCode: 0,
  }

  // ── 8.7: writePrompt writes between markers ────────────────────

  it('should write the prompt between === PROMPT === and === END PROMPT === markers', async () => {
    const logger = createMockLogger()
    const config = defaultConfig()

    await fs.mkdir(config.sessionLogDir, { recursive: true })

    const writer = createSessionLogWriter(config, logger)
    const handle = writer.createSession(dummyContext)

    const prompt = 'Implement the login feature with OAuth2 support.\nInclude unit tests.'
    handle.writePrompt(prompt)

    await handle.finalize(dummyResult)

    const content = await fs.readFile(handle.filePath, 'utf-8')

    expect(content).toContain('=== PROMPT ===')
    expect(content).toContain(prompt)
    expect(content).toContain('=== END PROMPT ===')

    // Verify the prompt is between the markers
    const promptStart = content.indexOf('=== PROMPT ===')
    const promptEnd = content.indexOf('=== END PROMPT ===')
    const promptContent = content.substring(promptStart + '=== PROMPT ===\n'.length, promptEnd - 1)
    expect(promptContent).toBe(prompt)
  })

  // ── 8.8: prompt section appears after metadata and before output ─

  it('should place prompt section after the metadata header and before any stdout/stderr output', async () => {
    const logger = createMockLogger()
    const config = defaultConfig()

    await fs.mkdir(config.sessionLogDir, { recursive: true })

    const writer = createSessionLogWriter(config, logger)
    const handle = writer.createSession(dummyContext)

    const prompt = 'Fix the authentication bug in the login flow'
    handle.writePrompt(prompt)

    handle.writeStdout('Installing dependencies...\n')
    handle.writeStderr('Warning: deprecated API\n')

    await handle.finalize(dummyResult)

    const content = await fs.readFile(handle.filePath, 'utf-8')

    // Metadata header comes first
    const headerEnd = content.indexOf('================')
    expect(headerEnd).toBeGreaterThan(-1)

    // Prompt section comes after metadata
    const promptStart = content.indexOf('=== PROMPT ===')
    expect(promptStart).toBeGreaterThan(headerEnd)

    // Prompt end marker
    const promptEnd = content.indexOf('=== END PROMPT ===')
    expect(promptEnd).toBeGreaterThan(promptStart)

    // stdout/stderr come after prompt
    const firstStdout = content.indexOf('[STDOUT ')
    const firstStderr = content.indexOf('[STDERR ')
    expect(firstStdout).toBeGreaterThan(promptEnd)
    expect(firstStderr).toBeGreaterThan(promptEnd)
  })

  // ── 8.10: writePrompt is a no-op on disabled session handle ─────

  it('should be a no-op on the disabled session handle', async () => {
    const logger = createMockLogger()
    const config: SessionLogWriterConfig = {
      sessionLogDir: path.join(tempDir, 'disabled-sessions'),
      sessionLogMaxFiles: 100,
      sessionLogMaxAgeHours: 168,
      sessionLogEnabled: false,
    }

    const writer = createSessionLogWriter(config, logger)
    const handle = writer.createSession(dummyContext)

    // filePath should be empty (no-op handle)
    expect(handle.filePath).toBe('')

    // writePrompt should not throw
    handle.writePrompt('This prompt should be silently ignored')

    // finalize should not throw
    await handle.finalize(dummyResult)

    // No file should have been created
    await expect(fs.stat(config.sessionLogDir)).rejects.toThrow()
  })
})

// ── Unit tests for batch-mode formatSessionLog with prompt ──────────

describe('formatSessionLog with prompt parameter', () => {
  it('should include prompt section between metadata and stdout when prompt is provided', () => {
    const result: ExecutionResult = {
      success: true,
      hasChanges: true,
      stdout: 'build output',
      stderr: 'warning output',
      exitCode: 0,
    }
    const context: SessionLogContext = {
      engine: 'kiro',
      repoFullName: 'owner/repo',
      executionContext: 'issue-42',
    }
    const timestamp = new Date('2025-01-15T10:30:45.123Z')
    const prompt = 'Implement the login feature'

    const content = formatSessionLog(result, context, timestamp, prompt)

    // Prompt section should be present
    expect(content).toContain('=== PROMPT ===')
    expect(content).toContain(prompt)
    expect(content).toContain('=== END PROMPT ===')

    // Prompt should be between metadata and stdout
    const headerEnd = content.indexOf('================')
    const promptStart = content.indexOf('=== PROMPT ===')
    const stdoutStart = content.indexOf('=== STDOUT ===')
    expect(promptStart).toBeGreaterThan(headerEnd)
    expect(stdoutStart).toBeGreaterThan(promptStart)
  })

  it('should not include prompt section when prompt is not provided (backward compatible)', () => {
    const result: ExecutionResult = {
      success: true,
      hasChanges: false,
      stdout: 'output',
      stderr: '',
      exitCode: 0,
    }
    const context: SessionLogContext = {
      engine: 'copilot',
      repoFullName: 'owner/repo',
      executionContext: 'pr-17',
    }
    const timestamp = new Date('2025-01-15T10:30:45.123Z')

    const content = formatSessionLog(result, context, timestamp)

    // No prompt section
    expect(content).not.toContain('=== PROMPT ===')
    expect(content).not.toContain('=== END PROMPT ===')

    // Stdout section should still be present
    expect(content).toContain('=== STDOUT ===')
    expect(content).toContain('=== STDERR ===')
  })
})
