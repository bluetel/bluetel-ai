'use client'

import Link from 'next/link'

import { usePolling } from '../hooks'
import { apiFetch } from '../lib/api-fetch'

interface SummaryResponse {
  health: 'healthy' | 'unhealthy'
  uptime: { days: number; hours: number; minutes: number }
  taskCounts: {
    total: Record<string, number>
    manual: Record<string, number>
  }
  activeQueueCount: number
}

interface HealthResponse {
  status: string
}

const POLL_INTERVAL = 5000

const fetchSummary = async (): Promise<SummaryResponse> => {
  const res = await apiFetch('/api/summary')
  if (!res.ok) {
    throw new Error(`Summary fetch failed: ${res.status}`)
  }
  return res.json() as Promise<SummaryResponse>
}

const fetchHealth = async (): Promise<HealthResponse> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await apiFetch('/health', { signal: controller.signal })
    if (!res.ok) {
      throw new Error(`Health check failed: ${res.status}`)
    }
    const data: HealthResponse = await (res.json() as Promise<HealthResponse>)
    return data
  } finally {
    clearTimeout(timeout)
  }
}

const formatUptime = (uptime: { days: number; hours: number; minutes: number }): string => {
  const parts: string[] = []
  if (uptime.days > 0) parts.push(`${uptime.days}d`)
  if (uptime.hours > 0) parts.push(`${uptime.hours}h`)
  parts.push(`${uptime.minutes}m`)
  return parts.join(' ')
}

export default function HomePage() {
  const summary = usePolling<SummaryResponse>({
    fetcher: fetchSummary,
    intervalMs: POLL_INTERVAL,
  })

  const health = usePolling<HealthResponse>({
    fetcher: fetchHealth,
    intervalMs: POLL_INTERVAL,
  })

  const isHealthy = health.data?.status === 'ok' && !health.error
  const statusLabel = isHealthy ? 'Healthy' : 'Unhealthy'

  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      {/* Health status banner */}
      <div
        style={{
          padding: '0.75rem 1rem',
          marginBottom: '1.5rem',
          borderRadius: '6px',
          backgroundColor: isHealthy ? '#d4edda' : '#f8d7da',
          color: isHealthy ? '#155724' : '#721c24',
          border: `1px solid ${isHealthy ? '#c3e6cb' : '#f5c6cb'}`,
          fontWeight: 600,
          fontSize: '1rem',
        }}
        role="status"
        aria-live="polite"
      >
        Worker Status: {statusLabel}
      </div>

      <h1 style={{ marginTop: 0, marginBottom: '1.5rem' }}>Admin Dashboard</h1>

      {/* Summary section */}
      {summary.data ? (
        <div>
          {/* Uptime */}
          <section style={{ marginBottom: '1.5rem' }}>
            <h2 style={{ fontSize: '1.1rem', marginBottom: '0.5rem' }}>Worker Uptime</h2>
            <p style={{ fontSize: '1.5rem', fontWeight: 600, margin: 0 }}>
              {formatUptime(summary.data.uptime)}
            </p>
          </section>

          {/* Active queues */}
          <section style={{ marginBottom: '1.5rem' }}>
            <h2 style={{ fontSize: '1.1rem', marginBottom: '0.5rem' }}>Active Queues</h2>
            <p style={{ fontSize: '1.5rem', fontWeight: 600, margin: 0 }}>
              {summary.data.activeQueueCount}
            </p>
          </section>

          {/* Task counts by status */}
          <section style={{ marginBottom: '1.5rem' }}>
            <h2 style={{ fontSize: '1.1rem', marginBottom: '0.5rem' }}>Tasks by Status</h2>
            <table
              style={{
                borderCollapse: 'collapse',
                width: '100%',
                maxWidth: '400px',
              }}
            >
              <thead>
                <tr>
                  <th
                    style={{ textAlign: 'left', padding: '0.5rem', borderBottom: '1px solid #ddd' }}
                  >
                    Status
                  </th>
                  <th
                    style={{
                      textAlign: 'right',
                      padding: '0.5rem',
                      borderBottom: '1px solid #ddd',
                    }}
                  >
                    Count
                  </th>
                </tr>
              </thead>
              <tbody>
                {(['submitted', 'working', 'completed', 'failed', 'canceled'] as const).map(
                  (status) => (
                    <tr key={status}>
                      <td
                        style={{
                          padding: '0.5rem',
                          borderBottom: '1px solid #eee',
                          textTransform: 'capitalize',
                        }}
                      >
                        {status}
                      </td>
                      <td
                        style={{
                          padding: '0.5rem',
                          borderBottom: '1px solid #eee',
                          textAlign: 'right',
                        }}
                      >
                        {summary.data?.taskCounts.total[status] ?? 0}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </section>
        </div>
      ) : summary.error ? (
        <p style={{ color: '#721c24' }}>Failed to load summary data.</p>
      ) : (
        <p>Loading...</p>
      )}

      {/* Navigation */}
      <nav style={{ marginTop: '2rem', borderTop: '1px solid #ddd', paddingTop: '1rem' }}>
        <h2 style={{ fontSize: '1.1rem', marginBottom: '0.5rem' }}>Navigation</h2>
        <ul style={{ listStyle: 'none', padding: 0, display: 'flex', gap: '1rem' }}>
          <li>
            <Link href="/tasks" style={{ color: '#0070f3' }}>
              Tasks
            </Link>
          </li>
          <li>
            <Link href="/queue" style={{ color: '#0070f3' }}>
              Queue
            </Link>
          </li>
          <li>
            <Link href="/logs" style={{ color: '#0070f3' }}>
              Logs
            </Link>
          </li>
          <li>
            <Link href="/agents" style={{ color: '#0070f3' }}>
              Agents
            </Link>
          </li>
          <li>
            <Link href="/reviews" style={{ color: '#0070f3' }}>
              Reviews
            </Link>
          </li>
        </ul>
      </nav>
    </main>
  )
}
