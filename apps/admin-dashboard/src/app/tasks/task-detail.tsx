'use client'

import { usePolling } from '@admin-dashboard/hooks'
import { formatLogContent } from '@admin-dashboard/lib/ansi-to-html'
import { apiFetch } from '@admin-dashboard/lib/api-fetch'
import type { TaskStatus, UnifiedTask } from '@admin-dashboard/lib/types'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'

const DEFAULT_POLL_INTERVAL = 5000

interface LogEntry {
  filename: string
  sizeBytes: number
  createdAt: string
}

interface LogsResponse {
  items: LogEntry[]
  total: number
}

export const TaskDetail = ({ id }: { id: string }) => {
  const router = useRouter()
  const [isCanceling, setIsCanceling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)

  const fetcher = useCallback(async (): Promise<UnifiedTask> => {
    const res = await apiFetch(`/api/tasks/${id}`)
    if (res.status === 404) {
      throw new Error('Task not found')
    }
    if (!res.ok) {
      throw new Error(`Failed to fetch task: ${res.status}`)
    }
    return res.json() as Promise<UnifiedTask>
  }, [id])

  const { data: task, error } = usePolling<UnifiedTask>({
    fetcher,
    intervalMs: DEFAULT_POLL_INTERVAL,
  })

  const handleCancel = async () => {
    setIsCanceling(true)
    setCancelError(null)
    try {
      const res = await apiFetch(`/api/tasks/${id}/cancel`, { method: 'POST' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({ error: 'Cancel request failed' }))) as {
          error?: string
        }
        setCancelError(body.error ?? 'Cancel request failed')
      }
    } catch {
      setCancelError('Network error while canceling task')
    } finally {
      setIsCanceling(false)
    }
  }

  const isCancelable = task != null && (task.status === 'submitted' || task.status === 'working')

  if (error) {
    return (
      <main style={{ padding: '1.5rem', fontFamily: 'system-ui, sans-serif' }}>
        <button
          onClick={() => router.back()}
          style={{
            color: '#0070f3',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            fontSize: 'inherit',
          }}
        >
          ← Back to Tasks
        </button>
        <div
          style={{
            marginTop: '2rem',
            padding: '1.5rem',
            backgroundColor: '#fee',
            border: '1px solid #fcc',
            borderRadius: '4px',
            color: '#c00',
          }}
        >
          {error.message === 'Task not found'
            ? `Task with ID "${id}" was not found.`
            : `Error loading task: ${error.message}`}
        </div>
      </main>
    )
  }

  if (!task) {
    return (
      <main style={{ padding: '1.5rem', fontFamily: 'system-ui, sans-serif' }}>
        <button
          onClick={() => router.back()}
          style={{
            color: '#0070f3',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            fontSize: 'inherit',
          }}
        >
          ← Back to Tasks
        </button>
        <p style={{ marginTop: '2rem', color: '#666' }}>Loading task…</p>
      </main>
    )
  }

  return (
    <main style={{ padding: '1.5rem', fontFamily: 'system-ui, sans-serif' }}>
      <button
        onClick={() => router.back()}
        style={{
          color: '#0070f3',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 0,
          fontSize: 'inherit',
        }}
      >
        ← Back to Tasks
      </button>

      <h1 style={{ marginTop: '1rem', marginBottom: '0.5rem' }}>Task Detail</h1>

      {/* Cancel button */}
      {isCancelable && (
        <div style={{ marginBottom: '1rem' }}>
          <button
            onClick={() => void handleCancel()}
            disabled={isCanceling}
            style={{
              padding: '0.5rem 1.25rem',
              backgroundColor: isCanceling ? '#999' : '#dc2626',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              fontSize: '0.9rem',
              cursor: isCanceling ? 'not-allowed' : 'pointer',
            }}
          >
            {isCanceling ? 'Canceling…' : 'Cancel Task'}
          </button>
        </div>
      )}

      {cancelError && (
        <div
          style={{
            marginBottom: '1rem',
            padding: '0.75rem',
            backgroundColor: '#fee',
            border: '1px solid #fcc',
            borderRadius: '4px',
            color: '#c00',
            fontSize: '0.85rem',
          }}
        >
          {cancelError}
        </div>
      )}

      {/* Task details section */}
      <section style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.1rem', marginBottom: '0.75rem' }}>Details</h2>
        <table style={{ borderCollapse: 'collapse', fontSize: '0.9rem' }}>
          <tbody>
            <DetailRow label="ID" value={task.id} />
            <DetailRow label="Protocol" value={task.protocol.toUpperCase()} />
            <DetailRow
              label="Status"
              value={<span style={getStatusStyle(task.status)}>{task.status}</span>}
            />
            <DetailRow label="Repository" value={task.repoFullName} />
            <DetailRow label="Queue Key" value={task.queueKey} />
          </tbody>
        </table>
      </section>

      {/* Error details section */}
      {task.error && (
        <section style={{ marginBottom: '1.5rem' }}>
          <h2 style={{ fontSize: '1.1rem', marginBottom: '0.75rem', color: '#c00' }}>Error</h2>
          <table style={{ borderCollapse: 'collapse', fontSize: '0.9rem' }}>
            <tbody>
              <DetailRow label="Step" value={task.error.step} />
              <DetailRow label="Message" value={task.error.message} />
            </tbody>
          </table>
        </section>
      )}

      {/* Summaries section */}
      <section style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.1rem', marginBottom: '0.75rem' }}>Summaries</h2>
        <SummaryField label="Prompt Summary" value={task.promptSummary} status={task.status} />
        <SummaryField label="Result Summary" value={task.resultSummary} status={task.status} />
      </section>

      {/* Task input section */}
      <section style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.1rem', marginBottom: '0.75rem' }}>Input</h2>
        <table style={{ borderCollapse: 'collapse', fontSize: '0.9rem' }}>
          <tbody>
            <DetailRow label="Repository URL" value={task.input.repoUrl} />
            <DetailRow label="Base Branch" value={task.input.baseBranch} />
            {task.input.engine && <DetailRow label="Engine" value={task.input.engine} />}
            {task.input.agent && <DetailRow label="Custom Agent" value={task.input.agent} />}
          </tbody>
        </table>

        <div style={{ marginTop: '0.75rem' }}>
          <strong style={{ fontSize: '0.85rem', color: '#555' }}>Prompt:</strong>
          <pre
            style={{
              marginTop: '0.25rem',
              padding: '0.75rem',
              backgroundColor: '#f5f5f5',
              border: '1px solid #ddd',
              borderRadius: '4px',
              fontSize: '0.8rem',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              overflow: 'auto',
              maxHeight: '300px',
            }}
          >
            {task.input.prompt}
          </pre>
        </div>

        {task.input.installScript && (
          <div style={{ marginTop: '0.75rem' }}>
            <strong style={{ fontSize: '0.85rem', color: '#555' }}>Install Script:</strong>
            <pre
              style={{
                marginTop: '0.25rem',
                padding: '0.75rem',
                backgroundColor: '#f5f5f5',
                border: '1px solid #ddd',
                borderRadius: '4px',
                fontSize: '0.8rem',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                overflow: 'auto',
                maxHeight: '200px',
              }}
            >
              {task.input.installScript}
            </pre>
          </div>
        )}
      </section>

      {/* Timeline section */}
      <section style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.1rem', marginBottom: '0.75rem' }}>Timeline</h2>
        <table style={{ borderCollapse: 'collapse', fontSize: '0.9rem' }}>
          <tbody>
            <DetailRow label="Created" value={formatTimestamp(task.createdAt)} />
            <DetailRow label="Updated" value={formatTimestamp(task.updatedAt)} />
            <DetailRow
              label="Completed"
              value={
                task.completedAt ? (
                  formatTimestamp(task.completedAt)
                ) : (
                  <span style={{ color: '#0070f3', fontStyle: 'italic' }}>In progress</span>
                )
              }
            />
          </tbody>
        </table>
      </section>

      {/* Session Logs section */}
      <TaskLogs taskId={id} />
    </main>
  )
}

const DetailRow = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <tr>
    <td
      style={{
        padding: '0.4rem 1rem 0.4rem 0',
        fontWeight: 'bold',
        color: '#555',
        verticalAlign: 'top',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </td>
    <td style={{ padding: '0.4rem 0', verticalAlign: 'top' }}>{value}</td>
  </tr>
)

const SUMMARY_TRUNCATE_LENGTH = 300

const SummaryField = ({
  label,
  value,
  status,
}: {
  label: string
  value: string | null
  status: TaskStatus
}) => {
  const [expanded, setExpanded] = useState(false)

  const isTruncated = useMemo(
    () => value != null && value.length > SUMMARY_TRUNCATE_LENGTH,
    [value],
  )

  const displayText = useMemo(() => {
    if (value == null) return null
    if (!expanded && isTruncated) {
      return value.slice(0, SUMMARY_TRUNCATE_LENGTH) + '…'
    }
    return value
  }, [value, expanded, isTruncated])

  let content: React.ReactNode

  if (value != null) {
    content = (
      <div>
        <span style={{ fontSize: '0.9rem' }}>{displayText}</span>
        {isTruncated && (
          <button
            onClick={() => setExpanded((prev) => !prev)}
            style={{
              marginLeft: '0.5rem',
              background: 'none',
              border: 'none',
              color: '#0070f3',
              cursor: 'pointer',
              fontSize: '0.8rem',
              padding: 0,
            }}
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>
    )
  } else if (status === 'submitted' || status === 'working') {
    content = (
      <span style={{ fontStyle: 'italic', color: '#666', fontSize: '0.9rem' }}>Generating…</span>
    )
  } else {
    content = (
      <span style={{ fontStyle: 'italic', color: '#999', fontSize: '0.9rem' }}>Unavailable</span>
    )
  }

  return (
    <div style={{ marginBottom: '0.75rem' }}>
      <strong style={{ fontSize: '0.85rem', color: '#555' }}>{label}:</strong>
      <div style={{ marginTop: '0.25rem' }}>{content}</div>
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

// ── Task Logs Component ─────────────────────────────────────────────

const TaskLogs = ({ taskId }: { taskId: string }) => {
  const [logContents, setLogContents] = useState<Record<string, string>>({})
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set())

  // Poll the logs list, filtering for this task's logs
  const logsFetcher = useCallback(async (): Promise<LogEntry[]> => {
    const res = await apiFetch('/api/logs?pageSize=200')
    if (!res.ok) return []
    const data = (await res.json()) as LogsResponse
    // Filter logs that contain this task ID in the filename
    const matched = data.items.filter((log) => log.filename.includes(taskId))
    // Sort: setup logs first, then execution logs
    matched.sort((a, b) => {
      const aIsSetup = a.filename.includes('setup-task-') ? 0 : 1
      const bIsSetup = b.filename.includes('setup-task-') ? 0 : 1
      if (aIsSetup !== bIsSetup) return aIsSetup - bIsSetup
      // Within same type, sort by creation date ascending
      return a.createdAt.localeCompare(b.createdAt)
    })
    return matched
  }, [taskId])

  const { data: taskLogs } = usePolling<LogEntry[]>({
    fetcher: logsFetcher,
    intervalMs: DEFAULT_POLL_INTERVAL,
  })

  // Fetch log content when expanded
  const toggleLog = async (filename: string) => {
    const next = new Set(expandedLogs)
    if (next.has(filename)) {
      next.delete(filename)
    } else {
      next.add(filename)
      // Fetch content if not already loaded
      if (!logContents[filename]) {
        try {
          const res = await apiFetch(`/api/logs/${encodeURIComponent(filename)}`)
          if (res.ok) {
            const text = await res.text()
            setLogContents((prev) => ({ ...prev, [filename]: text }))
          }
        } catch {
          // ignore
        }
      }
    }
    setExpandedLogs(next)
  }

  // Auto-refresh expanded log contents when task is still working
  useEffect(() => {
    if (expandedLogs.size === 0) return

    const interval = setInterval(() => {
      void (async () => {
        for (const filename of expandedLogs) {
          try {
            const res = await apiFetch(`/api/logs/${encodeURIComponent(filename)}`)
            if (res.ok) {
              const text = await res.text()
              setLogContents((prev) => ({ ...prev, [filename]: text }))
            }
          } catch {
            // ignore
          }
        }
      })()
    }, DEFAULT_POLL_INTERVAL)

    return () => clearInterval(interval)
  }, [expandedLogs])

  if (!taskLogs || taskLogs.length === 0) {
    return (
      <section style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.1rem', marginBottom: '0.75rem' }}>Session Logs</h2>
        <p style={{ color: '#888', fontSize: '0.9rem' }}>No logs for this task</p>
      </section>
    )
  }

  return (
    <section style={{ marginBottom: '1.5rem' }}>
      <h2 style={{ fontSize: '1.1rem', marginBottom: '0.75rem' }}>Session Logs</h2>
      {taskLogs.map((log) => (
        <div
          key={log.filename}
          style={{
            marginBottom: '0.75rem',
            border: '1px solid #e5e7eb',
            borderRadius: '6px',
            overflow: 'hidden',
          }}
        >
          <button
            onClick={() => void toggleLog(log.filename)}
            style={{
              width: '100%',
              padding: '0.5rem 0.75rem',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              background: '#f9fafb',
              border: 'none',
              cursor: 'pointer',
              fontSize: '0.8rem',
              textAlign: 'left',
            }}
          >
            <span style={{ fontFamily: 'monospace' }}>{log.filename}</span>
            <span style={{ color: '#666' }}>{expandedLogs.has(log.filename) ? '▼' : '▶'}</span>
          </button>
          {expandedLogs.has(log.filename) && (
            <pre
              style={{
                margin: 0,
                padding: '0.75rem',
                fontSize: '0.75rem',
                fontFamily: 'monospace',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                overflow: 'auto',
                maxHeight: '500px',
                backgroundColor: '#1e1e1e',
                color: '#d4d4d4',
              }}
              dangerouslySetInnerHTML={{
                __html: logContents[log.filename]
                  ? formatLogContent(logContents[log.filename])
                  : 'Loading...',
              }}
            />
          )}
        </div>
      ))}
    </section>
  )
}
