'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

export interface UsePollingOptions<T> {
  fetcher: () => Promise<T>
  intervalMs: number // Clamped to [1000, 60000]
  enabled?: boolean
}

export interface UsePollingResult<T> {
  data: T | null
  error: Error | null
  lastRefreshedAt: Date | null
  isPolling: boolean
  isPaused: boolean
  consecutiveFailures: number
  pause: () => void
  resume: () => void
  refresh: () => void
}

export const clampInterval = (ms: number): number => {
  if (Number.isNaN(ms) || ms < 1000) return 1000
  if (ms > 60000) return 60000
  return ms
}

export const usePolling = <T>(options: UsePollingOptions<T>): UsePollingResult<T> => {
  const { fetcher, intervalMs, enabled = true } = options
  const effectiveInterval = clampInterval(intervalMs)

  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null)
  const [isPaused, setIsPaused] = useState(false)
  const [consecutiveFailures, setConsecutiveFailures] = useState(0)

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fetcherRef = useRef(fetcher)
  const isMountedRef = useRef(true)
  const scheduleNextRef = useRef<() => void>(() => {})

  // Keep fetcher ref up to date without triggering re-renders
  useEffect(() => {
    fetcherRef.current = fetcher
  }, [fetcher])

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const executeFetch = useCallback(async () => {
    try {
      const result = await fetcherRef.current()
      if (!isMountedRef.current) return
      setData(result)
      setError(null)
      setLastRefreshedAt(new Date())
      setConsecutiveFailures(0)
    } catch (err) {
      if (!isMountedRef.current) return
      const fetchError = err instanceof Error ? err : new Error(String(err))
      setError(fetchError)
      setConsecutiveFailures((prev) => prev + 1)
    }
  }, [])

  const scheduleNext = useCallback(() => {
    clearTimer()
    if (!isMountedRef.current) return
    timerRef.current = setTimeout(() => {
      void executeFetch().then(() => {
        if (isMountedRef.current && enabled && !isPaused) {
          scheduleNextRef.current()
        }
      })
    }, effectiveInterval)
  }, [clearTimer, effectiveInterval, executeFetch, enabled, isPaused])

  // Keep ref in sync
  useEffect(() => {
    scheduleNextRef.current = scheduleNext
  }, [scheduleNext])

  // Main polling effect
  useEffect(() => {
    if (!enabled || isPaused) {
      clearTimer()
      return
    }

    // Execute immediately on start, then schedule
    void executeFetch().then(() => {
      if (isMountedRef.current) {
        scheduleNext()
      }
    })

    return () => {
      clearTimer()
    }
  }, [enabled, isPaused, clearTimer, executeFetch, scheduleNext])

  const pause = useCallback(() => {
    setIsPaused(true)
    clearTimer()
  }, [clearTimer])

  const resume = useCallback(() => {
    setIsPaused(false)
  }, [])

  const refresh = useCallback(() => {
    // Manual refresh resets the auto-poll countdown timer
    clearTimer()
    void executeFetch().then(() => {
      if (isMountedRef.current && enabled && !isPaused) {
        scheduleNext()
      }
    })
  }, [clearTimer, executeFetch, enabled, isPaused, scheduleNext])

  const isPolling = enabled && !isPaused

  return {
    data,
    error,
    lastRefreshedAt,
    isPolling,
    isPaused,
    consecutiveFailures,
    pause,
    resume,
    refresh,
  }
}
