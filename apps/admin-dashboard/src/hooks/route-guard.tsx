'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useEffect } from 'react'
import type { ReactNode } from 'react'

import { useAuth } from './use-auth'

const PUBLIC_PATHS = ['/login']

export const RouteGuard = ({ children }: { children: ReactNode }) => {
  const { isAuthenticated, isLoading, authDisabled } = useAuth()
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    if (isLoading) return
    if (authDisabled) return

    const isPublicPath = PUBLIC_PATHS.includes(pathname)

    if (!isAuthenticated && !isPublicPath) {
      router.replace('/login')
    }
  }, [isAuthenticated, isLoading, authDisabled, pathname, router])

  if (isLoading) {
    return (
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '100vh',
        }}
      >
        <p>Loading...</p>
      </div>
    )
  }

  // If auth is disabled, render everything
  if (authDisabled) {
    return <>{children}</>
  }

  // If on a public path, always render
  const isPublicPath = PUBLIC_PATHS.includes(pathname)
  if (isPublicPath) {
    return <>{children}</>
  }

  // If not authenticated and not on a public path, show nothing (redirect is happening)
  if (!isAuthenticated) {
    return null
  }

  return <>{children}</>
}
