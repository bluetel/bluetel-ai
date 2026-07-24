import type { PaginatedResult, TaskFilters, UnifiedTask } from './types'

const TRUNCATION_LIMIT = 200
const TRUNCATION_INDICATOR = '…'

/**
 * Filters tasks using AND logic across status and protocol dimensions.
 * When a filter dimension is undefined or empty, all values for that dimension pass.
 */
export const filterTasks = (tasks: UnifiedTask[], filters: TaskFilters): UnifiedTask[] =>
  tasks.filter((task) => {
    const statusMatch =
      !filters.status || filters.status.length === 0 ? true : filters.status.includes(task.status)

    const protocolMatch =
      !filters.protocol || filters.protocol.length === 0
        ? true
        : filters.protocol.includes(task.protocol)

    return statusMatch && protocolMatch
  })

/**
 * Sorts tasks by updatedAt in descending order (most recent first).
 * Returns a new array without mutating the input.
 */
export const sortTasksByUpdatedAt = (tasks: UnifiedTask[]): UnifiedTask[] =>
  [...tasks].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())

/**
 * Paginates a list of tasks.
 * Page is 1-indexed. Returns a PaginatedResult with metadata.
 */
export const paginateTasks = (
  tasks: UnifiedTask[],
  page: number,
  pageSize: number,
): PaginatedResult<UnifiedTask> => {
  const total = tasks.length
  const effectivePageSize = Math.max(1, pageSize)
  const totalPages = Math.max(1, Math.ceil(total / effectivePageSize))
  const effectivePage = Math.max(1, Math.min(page, totalPages))

  const startIndex = (effectivePage - 1) * effectivePageSize
  const items = tasks.slice(startIndex, startIndex + effectivePageSize)

  return {
    items,
    total,
    page: effectivePage,
    pageSize: effectivePageSize,
    totalPages,
  }
}

/**
 * Truncates an error message to 200 characters with a truncation indicator
 * if the original exceeds the limit.
 */
export const truncateErrorMessage = (message: string): string => {
  if (message.length <= TRUNCATION_LIMIT) {
    return message
  }
  return message.slice(0, TRUNCATION_LIMIT) + TRUNCATION_INDICATOR
}
