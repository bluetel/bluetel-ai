'use client'

import { usePolling } from '@admin-dashboard/hooks'
import { apiFetch } from '@admin-dashboard/lib/api-fetch'
import type { PaginatedResult, Review, ReviewStatus } from '@admin-dashboard/lib/types'
import { useCallback } from 'react'

const DEFAULT_POLL_INTERVAL = 5000

const fetchReviews = async (): Promise<PaginatedResult<Review>> => {
  const res = await apiFetch('/api/reviews?page=1&pageSize=200')
  if (!res.ok) {
    throw new Error(`Failed to fetch reviews: ${res.status}`)
  }
  return res.json() as Promise<PaginatedResult<Review>>
}

export const ReviewList = () => {
  const fetcher = useCallback(() => fetchReviews(), [])
  const { data, error, lastRefreshedAt, isPolling, isPaused, pause, resume, refresh } = usePolling<
    PaginatedResult<Review>
  >({ fetcher, intervalMs: DEFAULT_POLL_INTERVAL })

  const reviews = data?.items ?? []
  const pendingCount = reviews.filter((r) => r.status === 'pending').length

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
        <h1 style={{ margin: 0 }}>
          Reviews{' '}
          {pendingCount > 0 && (
            <span
              style={{
                fontSize: '0.9rem',
                color: '#fff',
                backgroundColor: '#e67e22',
                borderRadius: '10px',
                padding: '0.1rem 0.5rem',
                verticalAlign: 'middle',
              }}
            >
              {pendingCount} pending
            </span>
          )}
        </h1>
      </div>

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
          Error fetching reviews: {error.message}
        </div>
      )}

      {reviews.length === 0 && !error && (
        <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
          <p>No reviews yet.</p>
        </div>
      )}

      {reviews.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #eee', textAlign: 'left' }}>
              <th style={{ padding: '0.5rem' }}>Title</th>
              <th style={{ padding: '0.5rem' }}>Status</th>
              <th style={{ padding: '0.5rem' }}>Repository</th>
              <th style={{ padding: '0.5rem' }}>Iteration</th>
              <th style={{ padding: '0.5rem' }}>Reviewer</th>
              <th style={{ padding: '0.5rem' }}>Created</th>
            </tr>
          </thead>
          <tbody>
            {reviews.map((review) => (
              <tr key={review.id} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '0.5rem', maxWidth: '320px' }}>
                  <a
                    href={`/reviews?id=${review.id}`}
                    style={{ color: '#0070f3', textDecoration: 'none', fontWeight: 500 }}
                  >
                    {review.title}
                  </a>
                </td>
                <td style={{ padding: '0.5rem' }}>
                  <span style={getStatusStyle(review.status)}>{review.status}</span>
                </td>
                <td style={{ padding: '0.5rem' }}>{review.repoFullName ?? '—'}</td>
                <td style={{ padding: '0.5rem' }}>{review.iteration ?? '—'}</td>
                <td style={{ padding: '0.5rem', color: review.reviewer ? '#333' : '#999' }}>
                  {review.reviewer || '—'}
                </td>
                <td style={{ padding: '0.5rem' }}>{formatTimestamp(review.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  )
}

const formatTimestamp = (iso: string): string => {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

const getStatusStyle = (status: ReviewStatus): React.CSSProperties => {
  const styles: Record<ReviewStatus, React.CSSProperties> = {
    pending: { color: '#e67e22', fontWeight: 600 },
    approved: { color: '#0a0' },
    rejected: { color: '#c00' },
    expired: { color: '#999' },
  }
  return styles[status]
}
