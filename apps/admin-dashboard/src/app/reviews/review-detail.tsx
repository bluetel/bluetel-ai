'use client'

import { usePolling } from '@admin-dashboard/hooks'
import { apiFetch } from '@admin-dashboard/lib/api-fetch'
import type { Review, ReviewDecision } from '@admin-dashboard/lib/types'
import { useRouter } from 'next/navigation'
import { useCallback, useState } from 'react'

const POLL_INTERVAL = 4000

export const ReviewDetail = ({ id }: { id: string }) => {
  const router = useRouter()
  const fetcher = useCallback(async (): Promise<Review> => {
    const res = await apiFetch(`/api/reviews/${id}`)
    if (!res.ok) {
      throw new Error(`Failed to fetch review: ${res.status}`)
    }
    return res.json() as Promise<Review>
  }, [id])

  const {
    data: review,
    error,
    refresh,
  } = usePolling<Review>({
    fetcher,
    intervalMs: POLL_INTERVAL,
  })

  const [comment, setComment] = useState('')
  const [reviewer, setReviewer] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const decide = async (decision: ReviewDecision) => {
    if (decision === 'rejected' && comment.trim() === '') {
      setSubmitError('A comment is required when rejecting.')
      return
    }
    setSubmitting(true)
    setSubmitError(null)
    try {
      const res = await apiFetch(`/api/reviews/${id}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, comment, reviewer: reviewer || undefined }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `Decision failed: ${res.status}`)
      }
      refresh()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main style={{ padding: '1.5rem', fontFamily: 'system-ui, sans-serif', maxWidth: '900px' }}>
      <button
        onClick={() => router.back()}
        style={{
          color: '#0070f3',
          fontSize: '0.85rem',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        ← Back to reviews
      </button>

      {error && !review && (
        <div
          style={{
            padding: '0.75rem',
            backgroundColor: '#fee',
            border: '1px solid #fcc',
            borderRadius: '4px',
            margin: '1rem 0',
            color: '#c00',
          }}
        >
          Error: {error.message}
        </div>
      )}

      {review == null ? (
        !error && <p style={{ marginTop: '1rem' }}>Loading…</p>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', margin: '1rem 0' }}>
            <h1 style={{ margin: 0, fontSize: '1.4rem' }}>{review.title}</h1>
            <span style={statusStyle(review.status)}>{review.status}</span>
          </div>

          <dl style={{ fontSize: '0.85rem', color: '#555', margin: '0 0 1rem' }}>
            {review.repoFullName && <Field label="Repository" value={review.repoFullName} />}
            {review.branch && <Field label="Branch" value={review.branch} />}
            {review.iteration != null && (
              <Field label="Iteration" value={String(review.iteration)} />
            )}
            <Field label="Created" value={new Date(review.createdAt).toLocaleString()} />
            {review.expiresAt && (
              <Field label="Expires" value={new Date(review.expiresAt).toLocaleString()} />
            )}
          </dl>

          {review.context && (
            <Section title="Context">
              <pre style={preStyle}>{review.context}</pre>
            </Section>
          )}

          <Section title="Content to review">
            <pre style={preStyle}>{review.content}</pre>
          </Section>

          {review.status === 'pending' ? (
            <Section title="Your decision">
              <input
                type="text"
                placeholder="Your name (optional)"
                value={reviewer}
                onChange={(e) => setReviewer(e.target.value)}
                style={inputStyle}
              />
              <textarea
                placeholder="Comment — optional to approve, required to reject (sent back to the workflow)"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={4}
                style={{ ...inputStyle, fontFamily: 'inherit', resize: 'vertical' }}
              />
              {submitError && <p style={{ color: '#c00', fontSize: '0.85rem' }}>{submitError}</p>}
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <button
                  onClick={() => void decide('approved')}
                  disabled={submitting}
                  style={buttonStyle('#0a0', submitting)}
                >
                  {submitting ? '…' : 'Approve'}
                </button>
                <button
                  onClick={() => void decide('rejected')}
                  disabled={submitting}
                  style={buttonStyle('#c00', submitting)}
                >
                  {submitting ? '…' : 'Reject'}
                </button>
              </div>
            </Section>
          ) : (
            <Section title="Decision">
              <p style={{ fontSize: '0.9rem' }}>
                <strong style={statusStyle(review.status)}>{review.status}</strong>
                {review.reviewer && <> by {review.reviewer}</>}
                {review.decidedAt && <> on {new Date(review.decidedAt).toLocaleString()}</>}
              </p>
              {review.comment && <pre style={preStyle}>{review.comment}</pre>}
            </Section>
          )}
        </>
      )}
    </main>
  )
}

const Field = ({ label, value }: { label: string; value: string }) => (
  <div style={{ display: 'flex', gap: '0.5rem' }}>
    <dt style={{ fontWeight: 600, minWidth: '90px' }}>{label}</dt>
    <dd style={{ margin: 0 }}>{value}</dd>
  </div>
)

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section style={{ marginBottom: '1.25rem' }}>
    <h2 style={{ fontSize: '1rem', marginBottom: '0.4rem' }}>{title}</h2>
    {children}
  </section>
)

const preStyle: React.CSSProperties = {
  backgroundColor: '#f6f8fa',
  border: '1px solid #e1e4e8',
  borderRadius: '6px',
  padding: '0.75rem',
  overflowX: 'auto',
  fontSize: '0.8rem',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}

const inputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  marginBottom: '0.5rem',
  padding: '0.5rem',
  border: '1px solid #ccc',
  borderRadius: '4px',
  fontSize: '0.85rem',
  boxSizing: 'border-box',
}

const buttonStyle = (color: string, disabled: boolean): React.CSSProperties => ({
  padding: '0.5rem 1.25rem',
  backgroundColor: color,
  color: '#fff',
  border: 'none',
  borderRadius: '4px',
  fontSize: '0.9rem',
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.6 : 1,
})

const statusStyle = (status: Review['status']): React.CSSProperties => {
  const colors: Record<Review['status'], string> = {
    pending: '#e67e22',
    approved: '#0a0',
    rejected: '#c00',
    expired: '#999',
  }
  return { color: colors[status], fontWeight: 600 }
}
