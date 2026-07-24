import { describe, expect, it } from 'vitest'

import {
  filterTasks,
  paginateTasks,
  sortTasksByUpdatedAt,
  truncateErrorMessage,
} from './task-list-service'
import type { TaskFilters, UnifiedTask } from './types'

const makeTask = (overrides: Partial<UnifiedTask> = {}): UnifiedTask => ({
  id: 'task-1',
  protocol: 'a2a',
  status: 'completed',
  repoFullName: 'org/repo',
  queueKey: 'org/repo',
  input: {
    repoUrl: 'https://github.com/org/repo',
    baseBranch: 'main',
    prompt: 'Fix the bug',
  },
  artifacts: [],
  promptSummary: null,
  resultSummary: null,
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T01:00:00Z',
  completedAt: '2025-01-01T01:00:00Z',
  ...overrides,
})

describe('filterTasks', () => {
  const tasks: UnifiedTask[] = [
    makeTask({ id: '1', status: 'completed', protocol: 'a2a' }),
    makeTask({ id: '2', status: 'failed', protocol: 'mcp' }),
    makeTask({ id: '3', status: 'working', protocol: 'a2a' }),
    makeTask({ id: '4', status: 'submitted', protocol: 'manual' }),
    makeTask({ id: '5', status: 'completed', protocol: 'mcp' }),
  ]

  it('returns all tasks when no filters are provided', () => {
    const result = filterTasks(tasks, {})
    expect(result).toHaveLength(5)
  })

  it('returns all tasks when filters have empty arrays', () => {
    const result = filterTasks(tasks, { status: [], protocol: [] })
    expect(result).toHaveLength(5)
  })

  it('filters by status', () => {
    const result = filterTasks(tasks, { status: ['completed'] })
    expect(result).toHaveLength(2)
    expect(result.every((t) => t.status === 'completed')).toBe(true)
  })

  it('filters by protocol', () => {
    const result = filterTasks(tasks, { protocol: ['mcp'] })
    expect(result).toHaveLength(2)
    expect(result.every((t) => t.protocol === 'mcp')).toBe(true)
  })

  it('applies AND logic across status and protocol', () => {
    const filters: TaskFilters = {
      status: ['completed'],
      protocol: ['mcp'],
    }
    const result = filterTasks(tasks, filters)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('5')
  })

  it('returns empty array when no tasks match', () => {
    const filters: TaskFilters = {
      status: ['canceled'],
      protocol: ['manual'],
    }
    const result = filterTasks(tasks, filters)
    expect(result).toHaveLength(0)
  })

  it('handles multiple statuses in filter', () => {
    const result = filterTasks(tasks, { status: ['completed', 'failed'] })
    expect(result).toHaveLength(3)
  })
})

describe('sortTasksByUpdatedAt', () => {
  it('sorts tasks in descending order by updatedAt', () => {
    const tasks: UnifiedTask[] = [
      makeTask({ id: '1', updatedAt: '2025-01-01T01:00:00Z' }),
      makeTask({ id: '2', updatedAt: '2025-01-03T01:00:00Z' }),
      makeTask({ id: '3', updatedAt: '2025-01-02T01:00:00Z' }),
    ]

    const result = sortTasksByUpdatedAt(tasks)
    expect(result.map((t) => t.id)).toEqual(['2', '3', '1'])
  })

  it('does not mutate the original array', () => {
    const tasks: UnifiedTask[] = [
      makeTask({ id: '1', updatedAt: '2025-01-01T01:00:00Z' }),
      makeTask({ id: '2', updatedAt: '2025-01-03T01:00:00Z' }),
    ]

    const original = [...tasks]
    sortTasksByUpdatedAt(tasks)
    expect(tasks).toEqual(original)
  })

  it('handles empty array', () => {
    expect(sortTasksByUpdatedAt([])).toEqual([])
  })

  it('handles single element', () => {
    const tasks = [makeTask({ id: '1' })]
    const result = sortTasksByUpdatedAt(tasks)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('1')
  })
})

describe('paginateTasks', () => {
  const tasks = Array.from({ length: 120 }, (_, i) => makeTask({ id: `task-${i}` }))

  it('returns first page with correct metadata', () => {
    const result = paginateTasks(tasks, 1, 50)
    expect(result.items).toHaveLength(50)
    expect(result.total).toBe(120)
    expect(result.page).toBe(1)
    expect(result.pageSize).toBe(50)
    expect(result.totalPages).toBe(3)
  })

  it('returns last page with remaining items', () => {
    const result = paginateTasks(tasks, 3, 50)
    expect(result.items).toHaveLength(20)
    expect(result.page).toBe(3)
  })

  it('clamps page to valid range when too high', () => {
    const result = paginateTasks(tasks, 100, 50)
    expect(result.page).toBe(3)
    expect(result.items).toHaveLength(20)
  })

  it('clamps page to 1 when zero or negative', () => {
    const result = paginateTasks(tasks, 0, 50)
    expect(result.page).toBe(1)
    expect(result.items).toHaveLength(50)
  })

  it('handles empty task list', () => {
    const result = paginateTasks([], 1, 50)
    expect(result.items).toHaveLength(0)
    expect(result.total).toBe(0)
    expect(result.page).toBe(1)
    expect(result.totalPages).toBe(1)
  })

  it('ensures pageSize is at least 1', () => {
    const result = paginateTasks(tasks, 1, 0)
    expect(result.pageSize).toBe(1)
    expect(result.items).toHaveLength(1)
  })
})

describe('truncateErrorMessage', () => {
  it('returns the original message when 200 chars or fewer', () => {
    const msg = 'Short error message'
    expect(truncateErrorMessage(msg)).toBe(msg)
  })

  it('returns the original message when exactly 200 chars', () => {
    const msg = 'a'.repeat(200)
    expect(truncateErrorMessage(msg)).toBe(msg)
  })

  it('truncates and adds indicator when over 200 chars', () => {
    const msg = 'a'.repeat(250)
    const result = truncateErrorMessage(msg)
    expect(result).toHaveLength(201) // 200 + '…'
    expect(result.endsWith('…')).toBe(true)
    expect(result.startsWith('a'.repeat(200))).toBe(true)
  })

  it('handles empty string', () => {
    expect(truncateErrorMessage('')).toBe('')
  })
})
