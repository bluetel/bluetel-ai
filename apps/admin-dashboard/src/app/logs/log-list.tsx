'use client'

import { useCallback, useState } from 'react'

import { usePolling } from '../../hooks'
import { formatFileSize } from '../../lib'
import { apiFetch } from '../../lib/api-fetch'

interface SessionLogFileEntry {
  filename: string
  sizeBytes: number
  createdAt: string
}

interface LogsResponse {
  items: SessionLogFileEntry[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

const PAGE_SIZE = 50

export const LogList = () => {
  const [page, setPage] = useState(1)

  const fetcher = useCallback(async (): Promise<LogsResponse> => {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(PAGE_SIZE),
    })
    const res = await apiFetch(`/api/logs?${params}`)
    if (!res.ok) {
      throw new Error(`Failed to fetch logs: ${res.status}`)
    }
    return res.json() as Promise<LogsResponse>
  }, [page])

  const { data, error } = usePolling<LogsResponse>({
    fetcher,
    intervalMs: 5000,
  })

  const handlePrevPage = () => {
    setPage((p) => Math.max(1, p - 1))
  }

  const handleNextPage = () => {
    if (data && page < data.totalPages) {
      setPage((p) => p + 1)
    }
  }

  if (error && !data) {
    return (
      <main>
        <h1>Session Logs</h1>
        <p>Error loading logs: {error.message}</p>
      </main>
    )
  }

  if (!data) {
    return (
      <main>
        <h1>Session Logs</h1>
        <p>Loading...</p>
      </main>
    )
  }

  if (data.total === 0) {
    return (
      <main>
        <h1>Session Logs</h1>
        <p>No session logs are available.</p>
      </main>
    )
  }

  return (
    <main>
      <h1>Session Logs</h1>

      <table>
        <thead>
          <tr>
            <th>Filename</th>
            <th>Size</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((entry) => (
            <tr key={entry.filename}>
              <td>
                <a href={`/logs?filename=${encodeURIComponent(entry.filename)}`}>
                  {entry.filename}
                </a>
              </td>
              <td>{formatFileSize(entry.sizeBytes)}</td>
              <td>{new Date(entry.createdAt).toISOString()}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <nav aria-label="Pagination">
        <button onClick={handlePrevPage} disabled={page <= 1}>
          Previous
        </button>
        <span>
          Page {data.page} of {data.totalPages}
        </span>
        <button onClick={handleNextPage} disabled={page >= data.totalPages}>
          Next
        </button>
      </nav>
    </main>
  )
}
