'use client'

import { usePolling } from '@admin-dashboard/hooks'
import { apiFetch } from '@admin-dashboard/lib/api-fetch'
import Link from 'next/link'
import { useState } from 'react'

interface Agent {
  name: string
  scope: 'builtin' | 'global' | 'workspace'
  description: string
  isDefault: boolean
}

interface AgentsResponse {
  agents: Agent[]
  discoveredAt: string | null
  refreshError?: string
}

const SCOPE_COLORS: Record<string, { bg: string; text: string }> = {
  builtin: { bg: '#e3f2fd', text: '#1565c0' },
  global: { bg: '#e8f5e9', text: '#2e7d32' },
  workspace: { bg: '#f3e5f5', text: '#6a1b9a' },
}

const SCOPE_LABELS: Record<string, string> = {
  builtin: 'Built-in',
  global: 'Global',
  workspace: 'Workspace',
}

const fetchAgents = async (): Promise<AgentsResponse> => {
  const res = await apiFetch('/api/agents')
  if (!res.ok) throw new Error(`Failed to fetch agents: ${res.status}`)
  return res.json() as Promise<AgentsResponse>
}

const formatRelativeTime = (isoDate: string): string => {
  const diff = Date.now() - new Date(isoDate).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

export default function AgentsPage() {
  const { data, error } = usePolling<AgentsResponse>({
    fetcher: fetchAgents,
    intervalMs: 30000,
  })

  const [isRefreshing, setIsRefreshing] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const handleRefresh = async () => {
    setIsRefreshing(true)
    setToast(null)
    try {
      const res = await apiFetch('/api/agents/refresh', { method: 'POST' })
      const body = (await res.json()) as AgentsResponse
      if (body.refreshError) {
        setToast(body.refreshError)
      }
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Refresh failed')
    } finally {
      setIsRefreshing(false)
    }
  }

  const agents = data?.agents ?? []
  const scopeCounts = agents.reduce(
    (acc, a) => {
      acc[a.scope]++
      return acc
    },
    { builtin: 0, global: 0, workspace: 0 },
  )

  return (
    <main style={{ padding: '1.5rem', fontFamily: 'system-ui, sans-serif', maxWidth: '800px' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1rem',
        }}
      >
        <h1 style={{ margin: 0 }}>Agents</h1>
        <Link href="/" style={{ color: '#0070f3', fontSize: '0.9rem' }}>
          ← Dashboard
        </Link>
      </div>

      {toast && (
        <div
          style={{
            padding: '0.75rem',
            backgroundColor: '#fff3cd',
            border: '1px solid #ffc107',
            borderRadius: '4px',
            marginBottom: '1rem',
            color: '#856404',
          }}
        >
          {toast}
        </div>
      )}

      {error ? (
        <p style={{ color: '#c00' }}>Failed to load agents.</p>
      ) : !data ? (
        <p>Loading...</p>
      ) : agents.length === 0 ? (
        <div
          style={{
            padding: '2rem',
            textAlign: 'center',
            border: '1px solid #ddd',
            borderRadius: '6px',
            backgroundColor: '#f9f9f9',
          }}
        >
          <p style={{ fontSize: '1.1rem', margin: '0 0 0.5rem' }}>No agents discovered</p>
          <p style={{ color: '#666', margin: 0, fontSize: '0.9rem' }}>
            Verify the Kiro CLI installation path and ensure <code>kiro-cli agent</code> runs
            successfully.
          </p>
        </div>
      ) : (
        <>
          {/* Summary header */}
          <div style={{ marginBottom: '1rem' }}>
            <p style={{ margin: '0 0 0.25rem', fontWeight: 500 }}>
              {agents.length} agent{agents.length === 1 ? '' : 's'} — {scopeCounts.builtin} Built-in
              · {scopeCounts.global} Global · {scopeCounts.workspace} Workspace
            </p>
            {data.discoveredAt && (
              <p style={{ margin: 0, fontSize: '0.85rem', color: '#666' }}>
                Last refreshed {formatRelativeTime(data.discoveredAt)}
              </p>
            )}
          </div>

          {/* Refresh button */}
          <button
            onClick={() => void handleRefresh()}
            disabled={isRefreshing}
            style={{
              padding: '0.4rem 1rem',
              marginBottom: '1rem',
              backgroundColor: isRefreshing ? '#999' : '#0070f3',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              cursor: isRefreshing ? 'not-allowed' : 'pointer',
              fontSize: '0.85rem',
            }}
          >
            {isRefreshing ? 'Refreshing...' : 'Refresh Agents'}
          </button>

          {/* Agent list */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {agents.map((agent) => (
              <div
                key={agent.name}
                style={{
                  padding: '0.75rem 1rem',
                  border: '1px solid #ddd',
                  borderRadius: '6px',
                  backgroundColor: '#fff',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    marginBottom: '0.25rem',
                  }}
                >
                  <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{agent.name}</span>
                  <span
                    style={{
                      padding: '0.1rem 0.5rem',
                      borderRadius: '10px',
                      fontSize: '0.75rem',
                      fontWeight: 500,
                      backgroundColor: SCOPE_COLORS[agent.scope].bg,
                      color: SCOPE_COLORS[agent.scope].text,
                    }}
                  >
                    {SCOPE_LABELS[agent.scope]}
                  </span>
                  {agent.isDefault && (
                    <span style={{ fontSize: '0.75rem', color: '#f5a623', fontWeight: 600 }}>
                      ⭐ Default
                    </span>
                  )}
                </div>
                {agent.description && (
                  <p style={{ margin: 0, fontSize: '0.85rem', color: '#555' }}>
                    {agent.description}
                  </p>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </main>
  )
}
