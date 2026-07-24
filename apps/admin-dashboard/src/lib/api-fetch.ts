/**
 * Authenticated fetch wrapper for admin API calls.
 * Reads the admin_token cookie and attaches it as a Bearer token.
 */

const COOKIE_NAME = 'admin_token'

const getToken = (): string | null => {
  if (typeof document === 'undefined') return null
  const match = document.cookie.match(new RegExp(`(?:^|; )${COOKIE_NAME}=([^;]*)`))
  return match ? decodeURIComponent(match[1]) : null
}

export const apiFetch = async (input: string, init?: RequestInit): Promise<Response> => {
  const token = getToken()
  const headers = new Headers(init?.headers)

  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  return fetch(input, { ...init, headers })
}
