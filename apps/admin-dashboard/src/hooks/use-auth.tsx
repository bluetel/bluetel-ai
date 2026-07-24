'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

interface AuthContextValue {
  isAuthenticated: boolean
  isLoading: boolean
  token: string | null
  authDisabled: boolean
  login: (token: string) => Promise<{ success: boolean; error?: string }>
  logout: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

const COOKIE_NAME = 'admin_token'
const COOKIE_MAX_AGE_SECONDS = 24 * 60 * 60 // 24 hours

export const getCookie = (name: string): string | null => {
  if (typeof document === 'undefined') return null
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))
  return match ? decodeURIComponent(match[1]) : null
}

export const setCookie = (name: string, value: string, maxAgeSeconds: number): void => {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSeconds}; SameSite=Strict`
}

export const deleteCookie = (name: string): void => {
  document.cookie = `${name}=; path=/; max-age=0; SameSite=Strict`
}

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [token, setToken] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [authDisabled, setAuthDisabled] = useState(false)

  // On mount, check if auth is disabled and if there's an existing token cookie
  useEffect(() => {
    const checkAuth = async () => {
      try {
        // Try calling the summary endpoint without auth to see if auth is disabled
        const response = await fetch('/api/summary')
        if (response.ok) {
          // Auth is disabled on the server — allow unrestricted access
          setAuthDisabled(true)
          setIsLoading(false)
          return
        }
      } catch {
        // Network error — we'll still check for a stored token
      }

      // Auth is enabled — check for existing cookie
      const storedToken = getCookie(COOKIE_NAME)
      if (storedToken) {
        // Validate the stored token by making a test API call
        try {
          const response = await fetch('/api/summary', {
            headers: { Authorization: `Bearer ${storedToken}` },
          })
          if (response.ok) {
            setToken(storedToken)
          } else {
            // Token is invalid — clear it
            deleteCookie(COOKIE_NAME)
          }
        } catch {
          // Network error — keep the token and let the user try
          setToken(storedToken)
        }
      }
      setIsLoading(false)
    }

    void checkAuth()
  }, [])

  const login = useCallback(
    async (inputToken: string): Promise<{ success: boolean; error?: string }> => {
      try {
        const response = await fetch('/api/summary', {
          headers: { Authorization: `Bearer ${inputToken}` },
        })
        if (response.ok) {
          setCookie(COOKIE_NAME, inputToken, COOKIE_MAX_AGE_SECONDS)
          setToken(inputToken)
          return { success: true }
        }
        return { success: false, error: 'Invalid token' }
      } catch {
        return { success: false, error: 'Unable to connect to the server' }
      }
    },
    [],
  )

  const logout = useCallback(() => {
    deleteCookie(COOKIE_NAME)
    setToken(null)
  }, [])

  const isAuthenticated = authDisabled || token !== null

  const value = useMemo<AuthContextValue>(
    () => ({ isAuthenticated, isLoading, token, authDisabled, login, logout }),
    [isAuthenticated, isLoading, token, authDisabled, login, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export const useAuth = (): AuthContextValue => {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
