'use client'

import { usePolling } from '@admin-dashboard/hooks/use-polling'
import { apiFetch } from '@admin-dashboard/lib/api-fetch'

interface QueueJob {
  id: string
  queueKey: string
  status: 'queued' | 'in-progress' | 'completed' | 'failed'
  enqueuedAt: string
  startedAt: string | null
  error: string | null
}

interface QueueEntry {
  queueKey: string
  jobs: QueueJob[]
  counts: Record<string, number>
}

interface QueueStateResponse {
  summary: {
    activeQueueKeys: number
    totalByStatus: Record<string, number>
  }
  queues: QueueEntry[]
}

const STATUS_LABELS: Record<string, string> = {
  queued: 'Queued',
  'in-progress': 'In Progress',
  completed: 'Completed',
  failed: 'Failed',
}

const fetchQueueState = async (): Promise<QueueStateResponse> => {
  const res = await apiFetch('/api/queue')
  if (!res.ok) {
    throw new Error(`Failed to fetch queue state: ${res.status}`)
  }
  return res.json() as Promise<QueueStateResponse>
}

const formatTimestamp = (iso: string): string => new Date(iso).toLocaleString()

export default function QueuePage() {
  const {
    data,
    error,
    lastRefreshedAt,
    isPolling,
    isPaused,
    consecutiveFailures,
    pause,
    resume,
    refresh,
  } = usePolling<QueueStateResponse>({
    fetcher: fetchQueueState,
    intervalMs: 5000,
  })

  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Queue State</h1>

      {/* Polling controls */}
      <div style={{ marginBottom: '1rem', display: 'flex', gap: '1rem', alignItems: 'center' }}>
        {isPaused ? (
          <button onClick={resume}>Resume Auto-Refresh</button>
        ) : (
          <button onClick={pause}>Pause Auto-Refresh</button>
        )}
        <button onClick={refresh}>Refresh Now</button>
        {lastRefreshedAt && (
          <span style={{ fontSize: '0.875rem', color: '#666' }}>
            Last refreshed: {lastRefreshedAt.toLocaleTimeString()}
          </span>
        )}
        {!isPolling && (
          <span style={{ fontSize: '0.875rem', color: '#b45309' }}>⏸ Auto-refresh paused</span>
        )}
      </div>

      {/* Connectivity warning */}
      {consecutiveFailures >= 3 && (
        <div
          style={{
            padding: '0.75rem',
            backgroundColor: '#fef2f2',
            border: '1px solid #fca5a5',
            borderRadius: '4px',
            marginBottom: '1rem',
          }}
        >
          ⚠️ Connectivity issue — displayed data may be stale.
        </div>
      )}

      {/* Error indicator */}
      {error && consecutiveFailures < 3 && (
        <div
          style={{
            padding: '0.75rem',
            backgroundColor: '#fffbeb',
            border: '1px solid #fcd34d',
            borderRadius: '4px',
            marginBottom: '1rem',
          }}
        >
          ⚠️ {error.message}
        </div>
      )}

      {/* Summary section */}
      {data && (
        <section style={{ marginBottom: '2rem' }}>
          <h2>Summary</h2>
          <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
            <div>
              <strong>Active Queue Keys:</strong> {data.summary.activeQueueKeys}
            </div>
            <div>
              <strong>Total Jobs by Status:</strong>
              <ul style={{ margin: '0.25rem 0', paddingLeft: '1.25rem' }}>
                {Object.entries(data.summary.totalByStatus).map(([status, count]) => (
                  <li key={status}>
                    {STATUS_LABELS[status] ?? status}: {count}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      )}

      {/* Queue keys with jobs */}
      {data?.queues.length === 0 && <p style={{ color: '#666' }}>No active queues.</p>}

      {data?.queues.map((queue) => (
        <section
          key={queue.queueKey}
          style={{
            marginBottom: '2rem',
            border: '1px solid #e5e7eb',
            borderRadius: '6px',
            padding: '1rem',
          }}
        >
          <h3 style={{ margin: '0 0 0.5rem 0' }}>{queue.queueKey}</h3>
          <div style={{ fontSize: '0.875rem', color: '#666', marginBottom: '0.75rem' }}>
            {Object.entries(queue.counts).map(([status, count]) => (
              <span key={status} style={{ marginRight: '1rem' }}>
                {STATUS_LABELS[status] ?? status}: {count}
              </span>
            ))}
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #e5e7eb', textAlign: 'left' }}>
                <th style={{ padding: '0.5rem' }}>Job ID</th>
                <th style={{ padding: '0.5rem' }}>Status</th>
                <th style={{ padding: '0.5rem' }}>Enqueue Time</th>
                <th style={{ padding: '0.5rem' }}>Start Time</th>
                <th style={{ padding: '0.5rem' }}>Error</th>
              </tr>
            </thead>
            <tbody>
              {queue.jobs.map((job) => (
                <tr key={job.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '0.5rem', fontFamily: 'monospace', fontSize: '0.8rem' }}>
                    {job.id}
                  </td>
                  <td style={{ padding: '0.5rem' }}>{STATUS_LABELS[job.status] ?? job.status}</td>
                  <td style={{ padding: '0.5rem' }}>{formatTimestamp(job.enqueuedAt)}</td>
                  <td style={{ padding: '0.5rem' }}>
                    {job.startedAt ? (
                      formatTimestamp(job.startedAt)
                    ) : (
                      <em style={{ color: '#9ca3af' }}>not started</em>
                    )}
                  </td>
                  <td style={{ padding: '0.5rem', color: '#dc2626' }}>{job.error ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}

      {/* Loading state */}
      {!data && !error && <p>Loading queue state...</p>}
    </main>
  )
}
