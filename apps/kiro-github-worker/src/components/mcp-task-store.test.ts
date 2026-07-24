/* eslint-disable @typescript-eslint/no-non-null-assertion */
// Feature: rocky-mcp-mode, Property 5: Task status round-trip

import * as fc from 'fast-check'
import pino from 'pino'
import { describe, expect, it } from 'vitest'

import type { MCPTaskInput, MCPTaskStatus } from '../lib/mcp-types'

import { createMCPTaskStore } from './mcp-task-store'

// ── Helpers ─────────────────────────────────────────────────────────

/** Silent pino logger that discards all output. */
const mockLogger = pino({ level: 'silent' })

/** All valid MCP task status values. */
const allStatuses: MCPTaskStatus[] = ['submitted', 'working', 'completed', 'failed', 'canceled']

/** Arbitrary that generates a random valid MCPTaskStatus. */
const statusArb: fc.Arbitrary<MCPTaskStatus> = fc.constantFrom(...allStatuses)

/** Arbitrary that generates realistic GitHub owner names. */
const ownerArb = fc.string({
  unit: fc.constantFrom('a', 'b', 'c', 'x', 'y', 'z', '1', '2', '3', '-'),
  minLength: 1,
  maxLength: 15,
})

/** Arbitrary that generates realistic GitHub repo names. */
const repoNamePartArb = fc.string({
  unit: fc.constantFrom('a', 'b', 'c', 'x', 'y', 'z', '1', '2', '3', '-', '_'),
  minLength: 1,
  maxLength: 15,
})

/** Arbitrary that generates realistic repoFullName values (owner/repo). */
const repoFullNameArb = fc
  .tuple(ownerArb, repoNamePartArb)
  .map(([owner, repo]) => `${owner}/${repo}`)

/** Arbitrary that generates valid branch names. */
const branchArb = fc.string({
  unit: fc.constantFrom('a', 'b', 'c', 'x', 'y', 'z', '1', '2', '3', '-', '_', '/', '.'),
  minLength: 1,
  maxLength: 30,
})

/** Arbitrary that generates non-empty prompt strings. */
const promptArb = fc.string({ minLength: 1, maxLength: 100 })

/** Arbitrary that generates valid MCPTaskInput objects. */
const taskInputArb: fc.Arbitrary<MCPTaskInput> = fc.record({
  repoUrl: fc
    .tuple(ownerArb, repoNamePartArb)
    .map(([owner, repo]) => `https://github.com/${owner}/${repo}`),
  baseBranch: branchArb,
  prompt: promptArb,
})

// ── Property 5: Task status update round-trip ──
// **Validates: Requirements 9.1, 9.2**

describe('Property 5: Task status round-trip', () => {
  it('updating a task status and retrieving it returns the updated status', () => {
    fc.assert(
      fc.property(taskInputArb, repoFullNameArb, statusArb, (input, repoFullName, newStatus) => {
        const store = createMCPTaskStore(mockLogger)

        // Create a task
        const task = store.create(input, repoFullName)
        expect(task.status).toBe('submitted')

        // Update the status
        store.updateStatus(task.id, newStatus)

        // Retrieve and verify
        const retrieved = store.get(task.id)
        expect(retrieved).toBeDefined()
        expect(retrieved!.status).toBe(newStatus)
      }),
      { numRuns: 100 },
    )
  })

  it('updatedAt is greater than or equal to createdAt after a status update', () => {
    fc.assert(
      fc.property(taskInputArb, repoFullNameArb, statusArb, (input, repoFullName, newStatus) => {
        const store = createMCPTaskStore(mockLogger)

        // Create a task
        const task = store.create(input, repoFullName)

        // Update the status
        store.updateStatus(task.id, newStatus)

        // Retrieve and verify timestamps
        const retrieved = store.get(task.id)
        expect(retrieved).toBeDefined()
        expect(retrieved!.updatedAt.getTime()).toBeGreaterThanOrEqual(
          retrieved!.createdAt.getTime(),
        )
      }),
      { numRuns: 100 },
    )
  })

  it('multiple sequential status updates all reflect the latest status', () => {
    fc.assert(
      fc.property(
        taskInputArb,
        repoFullNameArb,
        fc.array(statusArb, { minLength: 1, maxLength: 10 }),
        (input, repoFullName, statusSequence) => {
          const store = createMCPTaskStore(mockLogger)

          const task = store.create(input, repoFullName)

          // Apply all status updates
          for (const status of statusSequence) {
            store.updateStatus(task.id, status)
          }

          // Retrieve and verify the final status is the last one applied
          const retrieved = store.get(task.id)
          expect(retrieved).toBeDefined()
          expect(retrieved!.status).toBe(statusSequence[statusSequence.length - 1])
          expect(retrieved!.updatedAt.getTime()).toBeGreaterThanOrEqual(
            retrieved!.createdAt.getTime(),
          )
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ── Property 6: MCP queue key derivation format ──
// **Validates: Requirements 10.1**

describe('Property 6: MCP queue key derivation', () => {
  it('derived queue key equals {repoFullName}:mcp-{taskId} for any valid input', () => {
    fc.assert(
      fc.property(taskInputArb, repoFullNameArb, (input, repoFullName) => {
        const store = createMCPTaskStore(mockLogger)

        // Create a task
        const task = store.create(input, repoFullName)

        // Verify the queue key matches the expected pattern
        expect(task.queueKey).toBe(`${repoFullName}:mcp-${task.id}`)
      }),
      { numRuns: 100 },
    )
  })
})
