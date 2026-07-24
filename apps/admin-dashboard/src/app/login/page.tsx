'use client'

import { useAuth } from '@admin-dashboard/hooks/use-auth'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

export default function LoginPage() {
  const [tokenInput, setTokenInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const { isAuthenticated, authDisabled, login } = useAuth()
  const router = useRouter()

  // If already authenticated or auth is disabled, redirect to home
  useEffect(() => {
    if (isAuthenticated || authDisabled) {
      router.replace('/')
    }
  }, [isAuthenticated, authDisabled, router])

  const handleSubmit = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    setError(null)

    const trimmedToken = tokenInput.trim()
    if (!trimmedToken) {
      setError('Please enter a token')
      return
    }

    setIsSubmitting(true)
    const result = await login(trimmedToken)
    setIsSubmitting(false)

    if (result.success) {
      router.replace('/')
    } else {
      setError(result.error ?? 'Invalid token')
    }
  }

  return (
    <main
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100vh',
      }}
    >
      <div style={{ width: '100%', maxWidth: '400px', padding: '2rem' }}>
        <h1 style={{ marginBottom: '1.5rem', textAlign: 'center' }}>Admin Dashboard</h1>
        <form onSubmit={(e) => void handleSubmit(e)}>
          <div style={{ marginBottom: '1rem' }}>
            <label
              htmlFor="token"
              style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}
            >
              Access Token
            </label>
            <input
              id="token"
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="Enter your admin token"
              disabled={isSubmitting}
              style={{
                width: '100%',
                padding: '0.5rem 0.75rem',
                border: '1px solid #ccc',
                borderRadius: '4px',
                fontSize: '1rem',
                boxSizing: 'border-box',
              }}
              autoFocus
            />
          </div>
          {error && (
            <p
              role="alert"
              style={{ color: '#dc2626', marginBottom: '1rem', fontSize: '0.875rem' }}
            >
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={isSubmitting}
            style={{
              width: '100%',
              padding: '0.5rem 1rem',
              backgroundColor: '#2563eb',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              fontSize: '1rem',
              cursor: isSubmitting ? 'not-allowed' : 'pointer',
              opacity: isSubmitting ? 0.7 : 1,
            }}
          >
            {isSubmitting ? 'Verifying...' : 'Sign In'}
          </button>
        </form>
      </div>
    </main>
  )
}
