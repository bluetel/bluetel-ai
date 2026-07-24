// Feature: kiro-github-worker, Property 18: Setup script execution respects presence and exit code

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Octokit } from '@octokit/rest'
import * as fc from 'fast-check'
import pino from 'pino'
import { describe, expect, it } from 'vitest'

import { runSetupScript } from './setup-script-runner'

// ── Helpers ─────────────────────────────────────────────────────────

/** Silent logger for tests. */
const logger = pino({ level: 'silent' })

/** Creates a mock Octokit that captures postError calls. */
const createMockOctokit = (): { octokit: Octokit; getCapturedBodies: () => string[] } => {
  const capturedBodies: string[] = []

  const octokit = {
    issues: {
      createComment: (params: {
        owner: string
        repo: string
        issue_number: number
        body: string
      }) => {
        capturedBodies.push(params.body)
        return Promise.resolve({ data: { id: 1 } })
      },
    },
  } as unknown as Octokit

  return { octokit, getCapturedBodies: () => capturedBodies }
}

/**
 * Creates a fresh temporary directory and returns it along with a cleanup function.
 * Each fast-check iteration gets its own isolated directory.
 */
const createTmpDir = (): { dir: string; cleanup: () => void } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-script-test-'))
  return {
    dir,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Arbitrary for positive issue numbers. */
const issueNumberArb = fc.integer({ min: 1, max: 999999 })

/** Arbitrary that generates realistic GitHub repo full names (owner/repo). */
const repoNameArb = fc
  .tuple(
    fc.string({
      unit: fc.constantFrom('a', 'b', 'c', 'x', 'y', 'z', '1', '2', '3', '-', '_'),
      minLength: 1,
      maxLength: 10,
    }),
    fc.string({
      unit: fc.constantFrom('a', 'b', 'c', 'x', 'y', 'z', '1', '2', '3', '-', '_'),
      minLength: 1,
      maxLength: 10,
    }),
  )
  .map(([owner, repo]) => `${owner}/${repo}`)

/**
 * Arbitrary for non-zero exit codes (1–125).
 * Exit codes above 125 have special meaning in shells, so we stay in the safe range.
 */
const nonZeroExitCodeArb = fc.integer({ min: 1, max: 125 })

/**
 * Arbitrary for short printable alphanumeric strings suitable for script output.
 * We keep it simple to avoid shell escaping issues.
 */
const scriptOutputArb = fc.string({
  unit: fc.constantFrom(
    ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-.'.split(''),
  ),
  minLength: 0,
  maxLength: 60,
})

/**
 * Escapes a string for safe use as a single-quoted shell argument.
 */
const escapeShellArg = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'"

// ── Property 18: Setup script execution respects presence and exit code ──
// **Validates: Requirements 19.1, 19.2, 19.3, 19.4**

describe('Property 18: Setup script execution respects presence and exit code', () => {
  it('returns { executed: false } when rocky.sh is NOT present', async () => {
    await fc.assert(
      fc.asyncProperty(repoNameArb, issueNumberArb, async (repo, issueNumber) => {
        const { dir, cleanup } = createTmpDir()
        try {
          const { octokit } = createMockOctokit()

          const result = await runSetupScript(
            dir,
            repo,
            issueNumber,
            { setupScriptTimeoutMs: 10_000 },
            octokit,
            logger,
          )

          expect(result).toEqual({
            executed: false,
            exitCode: null,
            stdout: '',
            stderr: '',
          })
        } finally {
          cleanup()
        }
      }),
      { numRuns: 50 },
    )
  })

  it('returns { executed: true, exitCode: 0 } with captured stdout/stderr when rocky.sh exits 0', async () => {
    await fc.assert(
      fc.asyncProperty(
        repoNameArb,
        issueNumberArb,
        scriptOutputArb,
        scriptOutputArb,
        async (repo, issueNumber, stdoutContent, stderrContent) => {
          const { dir, cleanup } = createTmpDir()
          try {
            const { octokit } = createMockOctokit()

            const scriptContent = [
              '#!/usr/bin/env bash',
              `printf '%s' ${escapeShellArg(stdoutContent)}`,
              `printf '%s' ${escapeShellArg(stderrContent)} >&2`,
              'exit 0',
            ].join('\n')

            fs.writeFileSync(path.join(dir, 'rocky.sh'), scriptContent, { mode: 0o755 })

            const result = await runSetupScript(
              dir,
              repo,
              issueNumber,
              { setupScriptTimeoutMs: 10_000 },
              octokit,
              logger,
            )

            expect(result.executed).toBe(true)
            expect(result.exitCode).toBe(0)
            expect(result.stdout).toBe(stdoutContent)
            expect(result.stderr).toBe(stderrContent)
          } finally {
            cleanup()
          }
        },
      ),
      { numRuns: 30 },
    )
  }, 30_000)

  it('throws an error when rocky.sh exits with a non-zero code', async () => {
    await fc.assert(
      fc.asyncProperty(
        repoNameArb,
        issueNumberArb,
        nonZeroExitCodeArb,
        scriptOutputArb,
        async (repo, issueNumber, exitCode, stderrContent) => {
          const { dir, cleanup } = createTmpDir()
          try {
            const { octokit, getCapturedBodies } = createMockOctokit()

            const scriptContent = [
              '#!/usr/bin/env bash',
              `printf '%s' ${escapeShellArg(stderrContent)} >&2`,
              `exit ${String(exitCode)}`,
            ].join('\n')

            fs.writeFileSync(path.join(dir, 'rocky.sh'), scriptContent, { mode: 0o755 })

            await expect(
              runSetupScript(
                dir,
                repo,
                issueNumber,
                { setupScriptTimeoutMs: 10_000 },
                octokit,
                logger,
              ),
            ).rejects.toThrow(/Setup script exited with code/)

            // Verify error was reported to Issue_Commenter
            const bodies = getCapturedBodies()
            expect(bodies.length).toBeGreaterThanOrEqual(1)
          } finally {
            cleanup()
          }
        },
      ),
      { numRuns: 30 },
    )
  }, 30_000)

  it('throws an error when rocky.sh exceeds the timeout', async () => {
    const { dir, cleanup } = createTmpDir()
    try {
      const { octokit, getCapturedBodies } = createMockOctokit()

      // Write a rocky.sh that loops forever (more reliable than sleep for short timeouts)
      const scriptContent = ['#!/usr/bin/env bash', 'while true; do sleep 0.1; done'].join('\n')

      fs.writeFileSync(path.join(dir, 'rocky.sh'), scriptContent, { mode: 0o755 })

      await expect(
        runSetupScript(dir, 'owner/repo', 1, { setupScriptTimeoutMs: 300 }, octokit, logger),
      ).rejects.toThrow(/timed out/)

      // Verify timeout error was reported to Issue_Commenter
      const bodies = getCapturedBodies()
      expect(bodies.length).toBeGreaterThanOrEqual(1)
      expect(bodies[0]).toContain('timed out')
    } finally {
      cleanup()
    }
  }, 15_000)
})
