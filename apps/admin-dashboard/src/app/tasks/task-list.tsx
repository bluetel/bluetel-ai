'use client'

import { usePolling } from '@admin-dashboard/hooks'
import { apiFetch } from '@admin-dashboard/lib/api-fetch'
import {
  filterTasks,
  paginateTasks,
  sortTasksByUpdatedAt,
  truncateErrorMessage,
} from '@admin-dashboard/lib/task-list-service'
import type {
  PaginatedResult,
  TaskFilters,
  TaskStatus,
  UnifiedTask,
} from '@admin-dashboard/lib/types'
import Link from 'next/link'
import { useCallback, useState } from 'react'

const STATUSES: TaskStatus[] = ['submitted', 'working', 'completed', 'failed', 'canceled']
const PROTOCOLS: Array<'a2a' | 'mcp' | 'manual' | 'webhook'> = ['a2a', 'mcp', 'manual', 'webhook']
const PAGE_SIZE = 50
const DEFAULT_POLL_INTERVAL = 5000

interface TasksApiResponse {
  items: UnifiedTask[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

export const TaskList = () => {
  const [page, setPage] = useState(1)
  const [filters, setFilters] = useState<TaskFilters>({})
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set())

  const fetcher = useCallback(async (): Promise<TasksApiResponse> => {
    const params = new URLSearchParams({
      page: '1',
      pageSize: '1000',
    })
    const res = await apiFetch(`/api/tasks?${params.toString()}`)
    if (!res.ok) {
      throw new Error(`Failed to fetch tasks: ${res.status}`)
    }
    const data = (await res.json()) as { items: UnifiedTask[] }
    const filtered = filterTasks(data.items, filters)
    const sorted = sortTasksByUpdatedAt(filtered)
    const paginated = paginateTasks(sorted, page, PAGE_SIZE)
    return paginated
  }, [filters, page])

  const { data, error, lastRefreshedAt, isPolling, isPaused, pause, resume, refresh } =
    usePolling<TasksApiResponse>({
      fetcher,
      intervalMs: DEFAULT_POLL_INTERVAL,
    })

  const toggleStatusFilter = (status: TaskStatus) => {
    setPage(1)
    setFilters((prev) => {
      const current = prev.status ?? []
      const next = current.includes(status)
        ? current.filter((s) => s !== status)
        : [...current, status]
      return { ...prev, status: next.length > 0 ? next : undefined }
    })
  }

  const toggleProtocolFilter = (protocol: 'a2a' | 'mcp' | 'manual' | 'webhook') => {
    setPage(1)
    setFilters((prev) => {
      const current = prev.protocol ?? []
      const next = current.includes(protocol)
        ? current.filter((p) => p !== protocol)
        : [...current, protocol]
      return { ...prev, protocol: next.length > 0 ? next : undefined }
    })
  }

  const toggleErrorExpanded = (taskId: string) => {
    setExpandedErrors((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) {
        next.delete(taskId)
      } else {
        next.add(taskId)
      }
      return next
    })
  }

  const paginatedResult: PaginatedResult<UnifiedTask> = data ?? {
    items: [],
    total: 0,
    page: 1,
    pageSize: PAGE_SIZE,
    totalPages: 1,
  }

  return (
    <main style={{ padding: '1.5rem', fontFamily: 'system-ui, sans-serif' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1rem',
        }}
      >
        <h1 style={{ margin: 0 }}>Tasks</h1>
        <Link
          href="/tasks/new"
          style={{
            padding: '0.5rem 1rem',
            backgroundColor: '#0070f3',
            color: '#fff',
            textDecoration: 'none',
            borderRadius: '4px',
            fontSize: '0.875rem',
          }}
        >
          New Task
        </Link>
      </div>

      {/* Polling controls */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          marginBottom: '1rem',
          fontSize: '0.8rem',
          color: '#666',
        }}
      >
        <button onClick={refresh} style={{ fontSize: '0.8rem', cursor: 'pointer' }}>
          Refresh
        </button>
        {isPolling ? (
          <button onClick={pause} style={{ fontSize: '0.8rem', cursor: 'pointer' }}>
            Pause
          </button>
        ) : (
          <button onClick={resume} style={{ fontSize: '0.8rem', cursor: 'pointer' }}>
            Resume
          </button>
        )}
        {isPaused && <span style={{ color: '#e67e22' }}>⏸ Auto-refresh paused</span>}
        {lastRefreshedAt && <span>Last refreshed: {lastRefreshedAt.toLocaleTimeString()}</span>}
      </div>

      {/* Error banner */}
      {error && (
        <div
          style={{
            padding: '0.75rem',
            backgroundColor: '#fee',
            border: '1px solid #fcc',
            borderRadius: '4px',
            marginBottom: '1rem',
            color: '#c00',
          }}
        >
          Error fetching tasks: {error.message}
        </div>
      )}

      {/* Filters */}
      <div style={{ marginBottom: '1rem' }}>
        <div style={{ marginBottom: '0.5rem' }}>
          <strong style={{ fontSize: '0.8rem' }}>Status:</strong>{' '}
          {STATUSES.map((status) => (
            <button
              key={status}
              onClick={() => toggleStatusFilter(status)}
              style={{
                margin: '0 0.25rem',
                padding: '0.25rem 0.5rem',
                fontSize: '0.75rem',
                borderRadius: '3px',
                border: '1px solid #ccc',
                backgroundColor: filters.status?.includes(status) ? '#0070f3' : '#fff',
                color: filters.status?.includes(status) ? '#fff' : '#333',
                cursor: 'pointer',
              }}
            >
              {status}
            </button>
          ))}
        </div>
        <div>
          <strong style={{ fontSize: '0.8rem' }}>Protocol:</strong>{' '}
          {PROTOCOLS.map((protocol) => (
            <button
              key={protocol}
              onClick={() => toggleProtocolFilter(protocol)}
              style={{
                margin: '0 0.25rem',
                padding: '0.25rem 0.5rem',
                fontSize: '0.75rem',
                borderRadius: '3px',
                border: '1px solid #ccc',
                backgroundColor: filters.protocol?.includes(protocol) ? '#0070f3' : '#fff',
                color: filters.protocol?.includes(protocol) ? '#fff' : '#333',
                cursor: 'pointer',
              }}
            >
              {protocol.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Empty state */}
      {paginatedResult.total === 0 && !error && (
        <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
          <p>No tasks have been recorded yet.</p>
        </div>
      )}

      {/* Task list table */}
      {paginatedResult.items.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #eee', textAlign: 'left' }}>
              <th style={{ padding: '0.5rem' }}>Prompt Summary</th>
              <th style={{ padding: '0.5rem' }}>Result Summary</th>
              <th style={{ padding: '0.5rem' }}>Protocol</th>
              <th style={{ padding: '0.5rem' }}>Custom Agent</th>
              <th style={{ padding: '0.5rem' }}>Status</th>
              <th style={{ padding: '0.5rem' }}>Repository</th>
              <th style={{ padding: '0.5rem' }}>Created</th>
              <th style={{ padding: '0.5rem' }}>Error</th>
            </tr>
          </thead>
          <tbody>
            {paginatedResult.items.map((task) => (
              <tr key={task.id} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '0.5rem', maxWidth: '250px' }}>
                  <a
                    href={`/tasks?id=${task.id}`}
                    style={{ color: '#0070f3', textDecoration: 'none' }}
                  >
                    {task.promptSummary ??
                      task.input.prompt.slice(0, 80) + (task.input.prompt.length > 80 ? '…' : '')}
                  </a>
                </td>
                <td
                  style={{
                    padding: '0.5rem',
                    maxWidth: '250px',
                    color: task.resultSummary ? '#333' : '#999',
                  }}
                >
                  {task.resultSummary ?? '—'}
                </td>
                <td style={{ padding: '0.5rem' }}>{task.protocol.toUpperCase()}</td>
                <td style={{ padding: '0.5rem', color: task.input.agent ? '#333' : '#999' }}>
                  {task.input.agent ?? '—'}
                </td>
                <td style={{ padding: '0.5rem' }}>
                  <span style={getStatusStyle(task.status)}>{task.status}</span>
                </td>
                <td style={{ padding: '0.5rem' }}>{task.repoFullName}</td>
                <td style={{ padding: '0.5rem' }}>{formatTimestamp(task.createdAt)}</td>
                <td style={{ padding: '0.5rem' }}>
                  {task.error && (
                    <ErrorCell
                      taskId={task.id}
                      error={task.error}
                      isExpanded={expandedErrors.has(task.id)}
                      onToggle={toggleErrorExpanded}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Pagination controls */}
      {paginatedResult.totalPages > 1 && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            gap: '1rem',
            marginTop: '1rem',
          }}
        >
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={paginatedResult.page <= 1}
            style={{ cursor: paginatedResult.page <= 1 ? 'not-allowed' : 'pointer' }}
          >
            Previous
          </button>
          <span style={{ fontSize: '0.85rem' }}>
            Page {paginatedResult.page} of {paginatedResult.totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(paginatedResult.totalPages, p + 1))}
            disabled={paginatedResult.page >= paginatedResult.totalPages}
            style={{
              cursor:
                paginatedResult.page >= paginatedResult.totalPages ? 'not-allowed' : 'pointer',
            }}
          >
            Next
          </button>
        </div>
      )}
    </main>
  )
}

const ErrorCell = ({
  taskId,
  error,
  isExpanded,
  onToggle,
}: {
  taskId: string
  error: { step: string; message: string }
  isExpanded: boolean
  onToggle: (id: string) => void
}) => {
  const truncated = truncateErrorMessage(error.message)
  const isTruncated = truncated !== error.message

  return (
    <div style={{ maxWidth: '300px' }}>
      <span style={{ fontSize: '0.75rem', color: '#c00', fontWeight: 'bold' }}>[{error.step}]</span>{' '}
      <span style={{ fontSize: '0.75rem', color: '#666' }}>
        {isExpanded ? error.message : truncated}
      </span>
      {isTruncated && (
        <button
          onClick={() => onToggle(taskId)}
          style={{
            marginLeft: '0.25rem',
            fontSize: '0.7rem',
            color: '#0070f3',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            textDecoration: 'underline',
          }}
        >
          {isExpanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

const formatTimestamp = (iso: string): string => {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

const getStatusStyle = (status: TaskStatus): React.CSSProperties => {
  const styles: Record<TaskStatus, React.CSSProperties> = {
    submitted: { color: '#666' },
    working: { color: '#0070f3' },
    completed: { color: '#0a0' },
    failed: { color: '#c00' },
    canceled: { color: '#999' },
  }
  return styles[status]
}
