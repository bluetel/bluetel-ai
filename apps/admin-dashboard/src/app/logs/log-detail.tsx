'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'

import { parseSessionLogMetadata } from '../../lib'
import type { SessionLogMetadata } from '../../lib'
import { apiFetch } from '../../lib/api-fetch'

const TRUNCATION_INDICATOR = '[truncated — file exceeds 5 MB]'

export const LogDetail = ({ filename }: { filename: string }) => {
  const router = useRouter()
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchLogContent = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch(`/api/logs/${encodeURIComponent(filename)}`)
      if (!res.ok) {
        throw new Error(`Failed to load log file: ${res.status}`)
      }
      const text = await res.text()
      setContent(text)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load log file')
    } finally {
      setLoading(false)
    }
  }, [filename])

  useEffect(() => {
    void fetchLogContent()
  }, [fetchLogContent])

  const isTruncated = content?.endsWith(TRUNCATION_INDICATOR) ?? false
  const metadata: SessionLogMetadata | null = content ? parseSessionLogMetadata(content) : null

  if (loading) {
    return (
      <main>
        <h1>Session Log</h1>
        <p>Loading...</p>
      </main>
    )
  }

  if (error) {
    return (
      <main>
        <h1>Session Log</h1>
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
          ← Back to Logs
        </button>
        <p role="alert">Error: {error}</p>
      </main>
    )
  }

  return (
    <main>
      <h1>Session Log: {filename}</h1>
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
        ← Back to Logs
      </button>

      {metadata && (
        <section aria-label="Log metadata">
          <h2>Metadata</h2>
          <dl>
            <dt>Engine</dt>
            <dd>{metadata.engine}</dd>
            <dt>Repository</dt>
            <dd>{metadata.repository}</dd>
            <dt>Context</dt>
            <dd>{metadata.context}</dd>
            <dt>Exit Code</dt>
            <dd>{metadata.exitCode}</dd>
            <dt>Success</dt>
            <dd>{metadata.success ? 'Yes' : 'No'}</dd>
          </dl>
        </section>
      )}

      {isTruncated && (
        <p role="status">
          <strong>Note:</strong> This log file exceeds 5 MB. Content has been truncated.
        </p>
      )}

      <pre
        style={{
          fontFamily: 'monospace',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          overflow: 'auto',
        }}
      >
        {content}
      </pre>
    </main>
  )
}
