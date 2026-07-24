/**
 * Unit tests for the Openclaw_Agent_Registry.
 *
 * These tests cover the persistent registry file behavior and the
 * cleanup decision logic. The actual `openclaw agents delete` shell
 * invocation is tested via mocking `child_process.spawn`.
 */

import * as childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createOpenclawAgentRegistry } from './openclaw-agent-registry'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>()
  return {
    ...actual,
    spawn: vi.fn(),
  }
})

const silentLogger = pino({ level: 'silent' })

const makeFakeChild = (exitCode: number): childProcess.ChildProcess => {
  const child = new EventEmitter() as childProcess.ChildProcess
  ;(child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter()
  ;(child as unknown as { kill: () => void }).kill = (): void => {
    /* no-op */
  }
  setTimeout(() => child.emit('close', exitCode), 0)
  return child
}

describe('createOpenclawAgentRegistry', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rockhub-registry-test-'))
    vi.mocked(childProcess.spawn).mockReset()
  })

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  describe('register + list', () => {
    it('persists agents to <logDir>/agents.json', () => {
      const registry = createOpenclawAgentRegistry(
        { logDir: tmpDir, cliPath: '/bin/true' },
        { logger: silentLogger },
      )

      registry.register({ name: 'rockhub-test-1', mentionIdentity: 'owner/repo:issue_body:1' })
      registry.register({ name: 'rockhub-test-2', mentionIdentity: 'owner/repo:issue_body:2' })

      const onDisk = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'agents.json'), 'utf-8'),
      ) as unknown[]
      expect(onDisk).toHaveLength(2)
      expect(registry.list()).toHaveLength(2)
    })

    it('replaces existing entries with the same name (idempotent)', () => {
      const registry = createOpenclawAgentRegistry(
        { logDir: tmpDir, cliPath: '/bin/true' },
        { logger: silentLogger },
      )

      registry.register({ name: 'rockhub-test', mentionIdentity: 'owner/repo:issue_body:1' })
      registry.register({ name: 'rockhub-test', mentionIdentity: 'owner/repo:issue_body:1' })

      expect(registry.list()).toHaveLength(1)
    })

    it('persists across factory recreations (survives restart)', () => {
      const r1 = createOpenclawAgentRegistry(
        { logDir: tmpDir, cliPath: '/bin/true' },
        { logger: silentLogger },
      )
      r1.register({ name: 'a', mentionIdentity: 'x:y:1' })
      r1.register({ name: 'b', mentionIdentity: 'x:y:2' })

      const r2 = createOpenclawAgentRegistry(
        { logDir: tmpDir, cliPath: '/bin/true' },
        { logger: silentLogger },
      )
      expect(
        r2
          .list()
          .map((e) => e.name)
          .sort(),
      ).toEqual(['a', 'b'])
    })

    it('returns empty list when registry file does not exist', () => {
      const registry = createOpenclawAgentRegistry(
        { logDir: tmpDir, cliPath: '/bin/true' },
        { logger: silentLogger },
      )
      expect(registry.list()).toEqual([])
    })

    it('treats invalid JSON as empty', () => {
      fs.writeFileSync(path.join(tmpDir, 'agents.json'), 'not json', 'utf-8')
      const registry = createOpenclawAgentRegistry(
        { logDir: tmpDir, cliPath: '/bin/true' },
        { logger: silentLogger },
      )
      expect(registry.list()).toEqual([])
    })
  })

  describe('cleanup', () => {
    it('deletes agents older than maxAgeMs and keeps fresh ones', async () => {
      const oneHour = 60 * 60 * 1000
      const now = Date.now()

      // Create a real workspace dir to verify it gets removed on cleanup.
      const staleWorkspaceDir = path.join(tmpDir, 'workspaces', 'stale-agent')
      fs.mkdirSync(staleWorkspaceDir, { recursive: true })

      const seed = [
        {
          name: 'stale-agent',
          mentionIdentity: 'a:b:1',
          createdAt: new Date(now - 3 * oneHour).toISOString(),
          workspaceDir: staleWorkspaceDir,
        },
        {
          name: 'fresh-agent',
          mentionIdentity: 'a:b:2',
          createdAt: new Date(now - 30 * 60 * 1000).toISOString(),
        },
      ]
      fs.writeFileSync(path.join(tmpDir, 'agents.json'), JSON.stringify(seed), 'utf-8')

      vi.mocked(childProcess.spawn).mockImplementation(() => makeFakeChild(0))

      const registry = createOpenclawAgentRegistry(
        { logDir: tmpDir, cliPath: '/bin/true', maxAgeMs: 2 * oneHour },
        { logger: silentLogger },
      )

      const result = await registry.cleanup()
      expect(result).toEqual({ deleted: 1, failed: 0 })
      expect(registry.list().map((e) => e.name)).toEqual(['fresh-agent'])
      // Workspace dir should have been removed.
      expect(fs.existsSync(staleWorkspaceDir)).toBe(false)
    })

    it('keeps stale entries in the registry when delete fails (so they retry next tick)', async () => {
      const oneHour = 60 * 60 * 1000
      const now = Date.now()

      const staleWorkspaceDir = path.join(tmpDir, 'workspaces', 'stale-agent')
      fs.mkdirSync(staleWorkspaceDir, { recursive: true })

      const seed = [
        {
          name: 'stale-agent',
          mentionIdentity: 'a:b:1',
          createdAt: new Date(now - 3 * oneHour).toISOString(),
          workspaceDir: staleWorkspaceDir,
        },
      ]
      fs.writeFileSync(path.join(tmpDir, 'agents.json'), JSON.stringify(seed), 'utf-8')

      vi.mocked(childProcess.spawn).mockImplementation(() => makeFakeChild(1))

      const registry = createOpenclawAgentRegistry(
        { logDir: tmpDir, cliPath: '/bin/true', maxAgeMs: 2 * oneHour },
        { logger: silentLogger },
      )

      const result = await registry.cleanup()
      expect(result).toEqual({ deleted: 0, failed: 1 })
      expect(registry.list().map((e) => e.name)).toEqual(['stale-agent'])
      // Workspace dir must NOT be removed when delete failed.
      expect(fs.existsSync(staleWorkspaceDir)).toBe(true)
    })

    it('returns 0/0 when registry is empty', async () => {
      const registry = createOpenclawAgentRegistry(
        { logDir: tmpDir, cliPath: '/bin/true' },
        { logger: silentLogger },
      )
      const result = await registry.cleanup()
      expect(result).toEqual({ deleted: 0, failed: 0 })
    })
  })

  describe('start + stop', () => {
    it('runs an immediate cleanup on start', async () => {
      const oneHour = 60 * 60 * 1000
      const now = Date.now()
      const seed = [
        {
          name: 'old-agent',
          mentionIdentity: 'a:b:1',
          createdAt: new Date(now - 5 * oneHour).toISOString(),
        },
      ]
      fs.writeFileSync(path.join(tmpDir, 'agents.json'), JSON.stringify(seed), 'utf-8')

      vi.mocked(childProcess.spawn).mockImplementation(() => makeFakeChild(0))

      const registry = createOpenclawAgentRegistry(
        {
          logDir: tmpDir,
          cliPath: '/bin/true',
          maxAgeMs: 2 * oneHour,
          cleanupIntervalMs: 60_000,
        },
        { logger: silentLogger },
      )

      await registry.start()
      expect(registry.list()).toEqual([])

      registry.stop()
    })
  })
})
