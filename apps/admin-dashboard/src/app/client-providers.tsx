'use client'

import { RouteGuard } from '@admin-dashboard/hooks/route-guard'
import { AuthProvider } from '@admin-dashboard/hooks/use-auth'
import type { ReactNode } from 'react'

export const ClientProviders = ({ children }: { children: ReactNode }) => (
  <AuthProvider>
    <RouteGuard>{children}</RouteGuard>
  </AuthProvider>
)
